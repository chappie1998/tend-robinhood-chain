// Deploy script for the Tend EVM options protocol on Monad testnet.
//
// Usage:
//   MONAD_DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.ts --network monadTestnet
//   (or: npm run deploy:monad)
//
// Deploys, in order: MockUSDC (a 6-decimal mock settlement token, minted to
// the deployer), TendSeriesFactory, and TendPoolVault — then writes
// deployments/monad-testnet.json with every deployed address.
//
// Safe to `import`/type-check without a funded key or network access; it
// only touches the network once `main()` actually runs. Running it against
// Hardhat's local, ephemeral "hardhat" network (the default, with no
// --network flag) exercises the full deploy + wiring logic against an
// in-memory chain and never writes the monad-testnet.json manifest, so it
// is a safe way to validate the script without touching Monad testnet.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { network } from "hardhat";
import { MONAD_TESTNET } from "../config/monad.js";
import { ROBINHOOD_TESTNET } from "../config/robinhood.js";
import { DEPLOYER_SENTINEL, assertDeploymentTarget, assertDeployerNotPrivileged } from "../config/deployment-target.js";
import { resolveTarget } from "../config/targets.js";

// --- Mock settlement token -------------------------------------------------
const MOCK_USDC_NAME = "Mock USD Coin";
const MOCK_USDC_SYMBOL = "mUSDC";
const MOCK_USDC_DECIMALS = 6;
// 10,000,000 mUSDC minted to the deployer for demo liquidity.
// (Built via BigInt() calls rather than `n`-suffixed literals so this file
// type-checks under the repo's ES2017 tsconfig target.)
const MOCK_USDC_INITIAL_SUPPLY = BigInt(10_000_000) * BigInt(10) ** BigInt(MOCK_USDC_DECIMALS);

// --- Pool risk parameters (demo values) ------------------------------------

/// Resolved per network — see manifestPathFor in scripts/lib/e2e/seed-series.ts
/// for why this must never be a single shared file.
import { manifestPathFor } from "./lib/e2e/seed-series.js";

interface Manifest {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  pythAddress: string;
  canonicalPythAddress: string;
  pythNote: string;
  deployer: string;
  isProduction: boolean;
  settlement: { token: string; symbol: string; decimals: number; isMock: boolean };
  roles: { owner: string; emergencyAdmin: string; manager: string; quoteAuthority: string; feeRecipient: string };
  pool: { maxUtilizationBps: number; maxPositionBps: number; feeBps: number };
  contracts: {
    mockUSDC: string;
    /** Admin-only settlement oracle (TendPriceOracle) on demo deployments. */
    priceOracle?: string;
    tendSeriesFactory: string;
    tendPoolVault: string;
  };
  deployedAt: string;
}

async function readExistingManifest(manifestPath: string): Promise<Manifest | undefined> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function main() {
  const connection = await network.create();
  const { viem, networkName, networkConfig } = connection;
  // Any target that writes a manifest — i.e. a real chain this repo deploys
  // to, not hardhat's in-memory network. Was `isMonadTestnet`; it gates the
  // manifest write, and there is now more than one such chain.
  const manifestPath = manifestPathFor(networkName);
  const writesManifest = networkName === MONAD_TESTNET.name || networkName === ROBINHOOD_TESTNET.name;

  const [deployerClient] = await viem.getWalletClients();
  if (deployerClient === undefined) {
    throw new Error(
      `No account configured for network "${networkName}". ` +
        `Set MONAD_DEPLOYER_KEY (a funded Monad testnet private key) and retry.`,
    );
  }
  const deployer = deployerClient.account.address;
  const publicClient = await viem.getPublicClient();

  console.log(`Network: ${networkName} (chainId ${networkConfig.chainId ?? "unknown"})`);
  console.log(`Deployer: ${deployer}`);

  if (writesManifest) {
    const existing = await readExistingManifest(manifestPath);
    if (existing !== undefined) {
      console.log(`\nAn existing manifest was found at ${manifestPath}:`);
      console.log(JSON.stringify(existing, null, 2));
      console.log(
        "Re-running this script will deploy brand-new contract instances " +
          "(no CREATE2 / deterministic addresses are used) and overwrite this " +
          "manifest with the new addresses.\n",
      );
    }
  } else {
    console.log(
      `\nNote: "${networkName}" is not a manifest-writing target. No manifest ` +
        `will be written; this run only validates the deploy wiring end to end.\n`,
    );
  }

  console.log("Deployment plan:");
  // Resolve WHAT we are deploying against. The demo target deploys its own
  // mock token + MockPyth; a real target names an existing settlement token
  // (USDC/USDT) and the chain's canonical IPyth receiver. Validated before a
  // single transaction is sent, so a misconfiguration fails here rather than
  // halfway through.
  const target = resolveTarget(networkName);
  assertDeploymentTarget(target);
  // Config-only validation can't see the live signer, so a production deploy
  // is additionally checked against the address actually connected — the one
  // mistake (two env vars, one key) that no amount of config comparison
  // catches. No-op for the demo, which collapses roles onto the deployer by
  // design.
  assertDeployerNotPrivileged(target, deployer);
  if (await publicClient.getChainId() !== target.chainId) {
    throw new Error("RPC chain ID does not match the deployment target; no transactions sent.");
  }
  if (!target.deployMocks) {
    for (const address of [target.settlementToken!, target.pythAddress!]) {
      const code = await publicClient.getCode({ address });
      if (!code || code === "0x") throw new Error(`Required contract has no code at ${address}; no transactions sent.`);
    }
  }
  const role = (configured: string) => (configured === DEPLOYER_SENTINEL ? deployer : (configured as `0x${string}`));
  const owner = role(target.roles.owner);
  const emergencyAdmin = role(target.roles.emergencyAdmin);
  const manager = role(target.roles.manager);
  const quoteAuthority = role(target.roles.quoteAuthority);
  const feeRecipient = role(target.roles.feeRecipient);

  console.log(`Target: ${target.network} (${target.isProduction ? "PRODUCTION" : "demo"}), deployMocks=${target.deployMocks}`);

  // 1. Settlement token: deploy a mock, or bind to the real one.
  let settlementToken: `0x${string}`;
  let settlementSymbol: string;
  let settlementDecimals: number;
  // REUSE_SETTLEMENT_TOKEN=1 keeps the mock token from this chain's existing
  // manifest, so a redeploy of oracle/factory/vault does not strand every
  // trader's and LP's test balance on an orphaned token.
  const reuseToken = process.env.REUSE_SETTLEMENT_TOKEN === "1";
  if (target.deployMocks && reuseToken) {
    const existing = await readExistingManifest(manifestPath);
    const reused = existing?.contracts.mockUSDC;
    if (!reused) throw new Error(`REUSE_SETTLEMENT_TOKEN=1 but ${manifestPath} records no contracts.mockUSDC.`);
    const code = await publicClient.getCode({ address: reused as `0x${string}` });
    if (!code || code === "0x") throw new Error(`Recorded settlement token ${reused} has no code on this chain.`);
    const erc20 = [
      { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
      { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
    ] as const;
    settlementToken = reused as `0x${string}`;
    settlementDecimals = Number(await publicClient.readContract({ address: settlementToken, abi: erc20, functionName: "decimals" }));
    settlementSymbol = String(await publicClient.readContract({ address: settlementToken, abi: erc20, functionName: "symbol" }));
    if (settlementDecimals !== MOCK_USDC_DECIMALS) {
      throw new Error(`Reused token has ${settlementDecimals} decimals; expected ${MOCK_USDC_DECIMALS}.`);
    }
    console.log(`Reusing settlement token ${settlementSymbol} at ${settlementToken} (${settlementDecimals} decimals, read on-chain)`);
  } else if (target.deployMocks) {
    const mockUSDC = await viem.deployContract("MockERC20", [MOCK_USDC_NAME, MOCK_USDC_SYMBOL, MOCK_USDC_DECIMALS]);
    const mintHash = await mockUSDC.write.mint([deployer, MOCK_USDC_INITIAL_SUPPLY]);
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    settlementToken = mockUSDC.address;
    settlementSymbol = MOCK_USDC_SYMBOL;
    settlementDecimals = MOCK_USDC_DECIMALS;
    console.log(`MockUSDC deployed at ${settlementToken}; minted ${MOCK_USDC_INITIAL_SUPPLY} raw units to ${deployer}`);
  } else {
    settlementToken = target.settlementToken as `0x${string}`;
    // Decimals and symbol are READ FROM THE TOKEN, never assumed — USDC/USDT
    // happen to be 6, but an 18-decimal asset must not silently mis-scale
    // every amount in the stack.
    const erc20 = [
      { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
      { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
    ] as const;
    settlementDecimals = Number(
      await publicClient.readContract({ address: settlementToken, abi: erc20, functionName: "decimals" }),
    );
    if (!Number.isInteger(settlementDecimals) || settlementDecimals < 0 || settlementDecimals > 18) {
      throw new Error("Unsupported settlement token decimals; expected an integer from 0 to 18.");
    }
    settlementSymbol = String(
      await publicClient.readContract({ address: settlementToken, abi: erc20, functionName: "symbol" }),
    );
    console.log(`Settlement token: ${settlementSymbol} at ${settlementToken} (${settlementDecimals} decimals, read on-chain)`);
  }

  // 2. Oracle: MockPyth for the demo, the canonical IPyth receiver otherwise.
  // TendSeriesFactory is written against the IPyth interface, so this is the
  // only line that differs between the two.
  let pythAddress: `0x${string}`;
  if (target.deployMocks) {
    // Admin-only oracle, NOT MockPyth: MockPyth accepts a price from any
    // caller, and publishSettlement is permissionless, so under MockPyth
    // anyone could settle a series at an invented price. The manager (the
    // keeper wallet) is the only address that can post.
    const priceOracle = await viem.deployContract("TendPriceOracle", [manager]);
    pythAddress = priceOracle.address;
    console.log(`TendPriceOracle deployed at ${pythAddress}; admin (only poster) = ${manager}`);
  } else {
    pythAddress = target.pythAddress as `0x${string}`;
    console.log(`Pyth receiver: ${pythAddress} (canonical)`);
  }

  // 3. Permissionless series factory.
  const factory = await viem.deployContract("TendSeriesFactory", [owner, emergencyAdmin, pythAddress]);
  console.log(`TendSeriesFactory deployed at ${factory.address}`);

  // 4. Pooled writer vault.
  const vault = await viem.deployContract("TendPoolVault", [
    factory.address,
    settlementToken,
    manager,
    quoteAuthority,
    target.pool.maxUtilizationBps,
    target.pool.maxPositionBps,
    target.pool.feeBps,
    feeRecipient,
  ]);
  console.log(`TendPoolVault deployed at ${vault.address}`);

  // Read the manager back from the chain rather than trusting the constructor
  // argument. `manager` used to be `msg.sender` implicitly, so a regression
  // here would silently hand pool control to whichever key ran the deploy —
  // the exact failure this whole change exists to prevent. Assert, don't hope.
  const onchainManager = await vault.read.manager();
  if (onchainManager.toLowerCase() !== manager.toLowerCase()) {
    throw new Error(
      `TendPoolVault.manager() is ${onchainManager}, expected ${manager}. The vault was deployed with the ` +
        `wrong manager — do not use this deployment.`,
    );
  }
  console.log(`  manager verified on-chain: ${onchainManager}`);

  if (writesManifest) {
    // Every network-identifying field comes from the resolved TARGET, never
    // from a hardcoded chain: writing MONAD_TESTNET values into a Robinhood
    // manifest would describe contracts on a chain they are not deployed to.
    const isRobinhood = networkName === ROBINHOOD_TESTNET.name;
    const canonicalPyth = isRobinhood ? ROBINHOOD_TESTNET.pythAddress : MONAD_TESTNET.pythAddress;
    const manifest: Manifest = {
      network: target.network,
      chainId: target.chainId,
      rpcUrl: target.rpcUrl,
      explorer: target.explorer,
      pythAddress,
      canonicalPythAddress: canonicalPyth,
      pythNote: !target.deployMocks
        ? "Settlement uses the chain's canonical IPyth receiver."
        : "Settlement uses TendPriceOracle: only its admin (roles.manager) can " +
          "post prices, and caller-supplied update data is ignored. The keeper " +
          "posts the Coinbase expiry-minute price, then settles. Trust model: " +
          "the admin is the oracle — prices are not independently attested. " +
          (isRobinhood
            ? "Robinhood Chain testnet has no working canonical Pyth receiver."
            : "Monad testnet's canonical Pyth receiver (canonicalPythAddress) rejects live Hermes updates."),
      deployer,
      isProduction: target.isProduction,
      /// Decimals are read from the settlement token on-chain at deploy time,
      /// never assumed — downstream tooling must format amounts from this.
      settlement: {
        token: settlementToken,
        symbol: settlementSymbol,
        decimals: settlementDecimals,
        isMock: target.deployMocks,
      },
      roles: { owner, emergencyAdmin, manager, quoteAuthority, feeRecipient },
      pool: target.pool,
      contracts: {
        mockUSDC: settlementToken,
        ...(target.deployMocks ? { priceOracle: pythAddress } : {}),
        tendSeriesFactory: factory.address,
        tendPoolVault: vault.address,
      },
      deployedAt: new Date().toISOString(),
    };

    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nWrote manifest to ${manifestPath}`);
  }

  await connection.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
