// Read-only operational check. Exit 2 for --production until release requirements are met.
import { createPublicClient, http, parseAbi } from "viem";
import { ACTIVE_CHAIN, ACTIVE_MANIFEST } from "../config/activeChain.js";
import { MONAD_TESTNET } from "../config/monad.js";
import { ROBINHOOD_TESTNET } from "../config/robinhood.js";
import monadManifest from "../deployments/monad-testnet.json" with { type: "json" };
import robinhoodManifest from "../deployments/robinhood-testnet.json" with { type: "json" };
import { activeChain } from "./lib/e2e/chain.js";
import { assertRuntimeMode, verifyDeploymentIdentity } from "../quote-service/deploymentGuard.js";
import { getQuoteContext } from "../quote-service/serverContext.js";
import { inspectOracle, loadLocalAdminOracleRuntimeCode, loadLocalMockPythRuntimeCode, LocalMockPythArtifactError, type OracleInventory } from "./lib/oracle-inventory.js";

const client = createPublicClient({ chain: activeChain, transport: http(ACTIVE_CHAIN.rpcUrl, { timeout: 10_000, retryCount: 1 }) });
const healthAbi = parseAbi([
  "function paused() view returns (bool)",
  "function totalAssets() view returns (uint256)",
  "function lockedCollateral() view returns (uint256)",
]);

async function inspectConfiguredOracles(): Promise<OracleInventory[]> {
  const localMockRuntimeCode = await loadLocalMockPythRuntimeCode();
  const localAdminOracleRuntimeCode = await loadLocalAdminOracleRuntimeCode();
  const configured = [
    { chain: MONAD_TESTNET, manifest: monadManifest },
    { chain: ROBINHOOD_TESTNET, manifest: robinhoodManifest },
  ];
  return Promise.all(configured.map(({ chain, manifest }) => inspectOracle(
    createPublicClient({ chain: activeChain.id === chain.chainId ? activeChain : undefined, transport: http(chain.rpcUrl, { timeout: 10_000, retryCount: 1 }) }),
    manifest,
    localMockRuntimeCode,
    localAdminOracleRuntimeCode,
  )));
}

function oracleBlocker(oracle: OracleInventory): string {
  switch (oracle.oracleType) {
    case "exact-demo-mock-pyth":
      return `Oracle on chain ${oracle.expectedChainId} exactly matches locally compiled DeployableMockPyth; ANY caller can post a settlement price.`;
    case "exact-admin-price-oracle":
      return `Oracle on chain ${oracle.expectedChainId} is TendPriceOracle: only its admin can post, but prices are not independently attested.`;
    case "unknown-oracle-unverified":
      return `Oracle on chain ${oracle.expectedChainId} has unknown runtime code; authentication is unverified and must not be inferred from bytecode mismatch.`;
    case "no-runtime-code":
      return `Oracle on chain ${oracle.expectedChainId} has no runtime code.`;
    case "manifest-oracle-mismatch":
      return `Oracle wiring or chain identity does not match the manifest on chain ${oracle.expectedChainId}.`;
    case "rpc-or-wiring-failure":
      return `Oracle evidence could not be read for chain ${oracle.expectedChainId}.`;
  }
}

async function main() {
  assertRuntimeMode();
  const oracleInventory = await inspectConfiguredOracles();
  const activeOracle = oracleInventory.find(({ expectedChainId }) => expectedChainId === ACTIVE_CHAIN.chainId);
  if (!activeOracle || !activeOracle.wiringVerified) {
    throw new Error("Active deployment oracle does not match the configured manifest.");
  }
  const identity = await verifyDeploymentIdentity(client, ACTIVE_MANIFEST);
  const [block, paused, assets, locked] = await Promise.all([
    client.getBlock(),
    client.readContract({ address: identity.factory, abi: healthAbi, functionName: "paused" }),
    client.readContract({ address: identity.vault, abi: healthAbi, functionName: "totalAssets" }),
    client.readContract({ address: identity.vault, abi: healthAbi, functionName: "lockedCollateral" }),
  ]);
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(block.timestamp);
  const issues: string[] = [];
  if (ageSeconds > 120 || ageSeconds < -30) issues.push("RPC head is stale or clock skew exceeds tolerance.");
  if (paused) issues.push("Factory is paused.");
  if (assets <= locked) issues.push("Pool has no free collateral.");
  if (activeOracle.oracleType !== "exact-demo-mock-pyth") {
    issues.push("Active oracle is not the locally compiled demo MockPyth; settlement authenticity is unverified.");
  }
  let signerVerified = false;
  if (process.env.QUOTE_AUTHORITY_KEY) {
    await getQuoteContext(client, ACTIVE_MANIFEST.contracts);
    signerVerified = true;
  } else {
    issues.push("QUOTE_AUTHORITY_KEY is absent; signer readiness was not verified.");
  }
  const productionBlockers = [
    ...oracleInventory.map(oracleBlocker),
    "Current runtime and token deployment are testnet-only.",
    "Production roles, canonical oracle settlement proof and independent contract audit are required.",
  ];
  console.log(JSON.stringify({
    chainId: ACTIVE_CHAIN.chainId, checkedAt: new Date().toISOString(),
    wiringVerified: true, signerVerified, blockAgeSeconds: ageSeconds,
    oracle: activeOracle, oracleInventory,
    totalAssets: assets.toString(), lockedCollateral: locked.toString(),
    operationalChecksPassed: issues.length === 0, issues,
    marketAvailability: "Not checked; run the keeper dry-run and verify fillable ladders separately.",
    productionReady: false, productionBlockers,
  }, null, 2));
  if (issues.length) process.exitCode = 1;
  else if (process.argv.includes("--production")) process.exitCode = 2;
}

main().catch((error: unknown) => {
  if (error instanceof LocalMockPythArtifactError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  // RPC errors may contain provider URLs; never print credentials from transport errors.
  console.error("Readiness check failed: verify chain, RPC availability, contract wiring and signer configuration.");
  process.exitCode = 1;
});
