// Redeploys ONLY TendPoolVault, against the factory, settlement token and
// Pyth receiver already in deployments/monad-testnet.json.
//
// Usage:
//   npx hardhat run scripts/deploy-vault.ts --network monadTestnet
//
// WHY THIS EXISTS
//
// `deploy.ts` deploys the whole protocol and overwrites every address, which
// would orphan the factory and with it every series that has ever been
// created and settled. A vault upgrade needs the opposite: keep the factory
// (series, settlement prices, refundability all live there) and swap only the
// pool. Positions are not transferable, so a vault's code can only change by
// deploying a new one — there is no proxy here, deliberately.
//
// WHAT IT DOES NOT DO
//
// It moves no money. The old vault keeps its liquidity and stays fully
// functional: its LPs can still withdraw, and any position still open there
// settles or refunds there. The new vault starts empty and with NO series
// authorized, so it cannot be traded until liquidity and authorizations are
// in place — run `npm run bootstrap:monad` immediately after this, which does
// both.
import { network } from "hardhat";
import type { Hex } from "viem";
import { MONAD_TESTNET } from "../config/monad.js";
import { MANIFEST_PATH, readDeployManifest, writeDeployManifest } from "./lib/e2e/seed-series.js";

/// Everything the new vault must copy is read from the LIVE vault, not from
/// the manifest: the manifest on this deployment predates the roles/pool
/// blocks `deploy.ts` writes today, and chain state is the only authority on
/// how the running pool is actually configured.
const VAULT_CONFIG_ABI = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "manager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "quoteAuthority", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "maxUtilizationBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "maxPositionBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "openPositions", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lockedCollateral", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/// DRY_RUN=1 reads the live configuration and prints the plan without sending
/// a transaction or touching the manifest — the same convention the keeper
/// uses, and the right way to check this before spending gas.
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const manifest = await readDeployManifest();

  const connection = await network.create();
  const { viem, networkName, networkConfig } = connection;
  const isMonadTestnet = networkName === MONAD_TESTNET.name;

  const [deployerClient] = await viem.getWalletClients();
  if (deployerClient === undefined) {
    throw new Error(
      `No account configured for network "${networkName}". Set MONAD_DEPLOYER_KEY (a funded Monad testnet key).`,
    );
  }
  const deployer = deployerClient.account.address;
  const publicClient = await viem.getPublicClient();
  console.log(`Network: ${networkName} (chainId ${networkConfig.chainId ?? "unknown"})${DRY_RUN ? "  [DRY RUN]" : ""}`);
  console.log(`Deployer: ${deployer}`);

  const previousVault = manifest.contracts.tendPoolVault as Hex;
  const read = <T>(functionName: string): Promise<T> =>
    publicClient.readContract({ address: previousVault, abi: VAULT_CONFIG_ABI, functionName }) as Promise<T>;

  const [factory, token, manager, quoteAuthority, feeRecipient] = await Promise.all([
    read<Hex>("factory"),
    read<Hex>("asset"),
    read<Hex>("manager"),
    read<Hex>("quoteAuthority"),
    read<Hex>("feeRecipient"),
  ]);
  const [maxUtilizationBps, maxPositionBps, feeBps, openPositions, lockedCollateral, totalAssets] = await Promise.all([
    read<number>("maxUtilizationBps"),
    read<number>("maxPositionBps"),
    read<number>("feeBps"),
    read<bigint>("openPositions"),
    read<bigint>("lockedCollateral"),
    read<bigint>("totalAssets"),
  ]);

  // The factory is what carries every series, settlement price and refund
  // deadline. A mismatch here means the manifest and the live vault disagree
  // about which protocol this is — stop rather than deploy against a guess.
  const manifestFactory = manifest.contracts.tendSeriesFactory as Hex;
  if (factory.toLowerCase() !== manifestFactory.toLowerCase()) {
    throw new Error(
      `Live vault's factory (${factory}) does not match the manifest (${manifestFactory}). Refusing to deploy.`,
    );
  }
  // Deploying is always safe, but MIGRATING while the old pool still owes
  // someone is not: those positions stay behind and must settle or refund
  // there. Say so loudly rather than discovering it after the app has moved.
  if (openPositions !== 0n || lockedCollateral !== 0n) {
    console.log(
      `\n!! The current vault has ${openPositions} open position(s) and ${lockedCollateral} locked. ` +
        `Those stay on ${previousVault} and must settle or refund there — the new vault cannot see them.`,
    );
  }

  console.log("\nReusing (unchanged):");
  console.log(`  TendSeriesFactory : ${factory}`);
  console.log(`  settlement token  : ${token}`);
  console.log(`  Pyth receiver     : ${manifest.pythAddress}`);
  console.log("Replacing:");
  console.log(`  TendPoolVault     : ${previousVault}  <-- keep this address for rollback`);
  console.log(`    holds ${totalAssets} raw settlement units of LP liquidity, which stays where it is`);
  console.log(`Cloned config: manager=${manager} quoteAuthority=${quoteAuthority} feeRecipient=${feeRecipient}`);
  console.log(`Pool params : maxUtilization=${maxUtilizationBps}bps maxPosition=${maxPositionBps}bps fee=${feeBps}bps`);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Nothing deployed, manifest untouched. Re-run without DRY_RUN=1 to deploy.");
    await connection.close();
    return;
  }

  const vault = await viem.deployContract("TendPoolVault", [
    factory,
    token,
    manager,
    quoteAuthority,
    maxUtilizationBps,
    maxPositionBps,
    feeBps,
    feeRecipient,
  ]);
  console.log(`\nTendPoolVault deployed at ${vault.address}`);

  // Read the roles back from the chain rather than trusting the constructor
  // arguments: a vault whose manager or quote authority is wrong cannot be
  // used at all, and is far cheaper to reject here than to discover later.
  const onchainManager = await vault.read.manager();
  if (onchainManager.toLowerCase() !== manager.toLowerCase()) {
    throw new Error(`TendPoolVault.manager() is ${onchainManager}, expected ${manager}. Do not use this deployment.`);
  }
  const onchainAuthority = await vault.read.quoteAuthority();
  if (onchainAuthority.toLowerCase() !== quoteAuthority.toLowerCase()) {
    throw new Error(
      `TendPoolVault.quoteAuthority() is ${onchainAuthority}, expected ${quoteAuthority}. The quote service signs ` +
        `with ${quoteAuthority}, so every fill against this vault would revert BadSignature.`,
    );
  }
  // The entire point of this redeploy: prove the new bytecode actually carries
  // the early-exit path before anything is pointed at it.
  const closeTypehash = await vault.read.CLOSE_QUOTE_TYPEHASH();
  if (!closeTypehash || /^0x0+$/.test(closeTypehash)) {
    throw new Error("Deployed vault has no CLOSE_QUOTE_TYPEHASH — this is not the early-exit build. Recompile.");
  }
  console.log(`  manager verified        : ${onchainManager}`);
  console.log(`  quoteAuthority verified : ${onchainAuthority}`);
  console.log(`  early-exit path present : ${closeTypehash}`);

  if (isMonadTestnet) {
    manifest.contracts.tendPoolVault = vault.address;
    manifest.deployedAt = new Date().toISOString();
    // `seededSeries` is deliberately left in place: the series themselves live
    // on the (unchanged) factory and are still valid, and the SPA needs a
    // non-empty market list to start its own on-chain discovery at all. What
    // is now stale is their AUTHORIZATION, which is per-vault — bootstrap
    // re-authorizes every rung against the new vault below.
    await writeDeployManifest(manifest);
    console.log(`\nWrote manifest to ${MANIFEST_PATH} (contracts.tendPoolVault updated).`);
  } else {
    console.log(`\nNot ${MONAD_TESTNET.name}; manifest not written. This run only validated the deploy wiring.`);
  }

  console.log("\nThe new vault is EMPTY and has NO series authorized. Next, in order:");
  console.log("  1. npm run bootstrap:monad     # deposits liquidity + authorizes every rung on the new vault");
  console.log("  2. commit deployments/monad-testnet.json");
  console.log("  3. vercel deploy --prod --archive=tgz --yes   # the manifest is bundled at build time");
  console.log(`\nRollback: set contracts.tendPoolVault back to ${previousVault}, rebuild and redeploy.`);
  console.log("The old vault keeps its liquidity; its LPs can still withdraw from it at any time.");

  await connection.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
