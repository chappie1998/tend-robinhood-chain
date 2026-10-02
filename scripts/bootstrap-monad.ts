// Bootstrap script: seeds a live, tradable LADDER of option series — one per
// tenor (15m / 1h / 12h) per configured market (config/markets.ts) — plus
// shared pool liquidity, on the already-deployed Tend EVM contracts on Monad
// testnet.
//
// Usage:
//   npm run bootstrap:monad
//   (equivalent to: node --env-file=.env node_modules/.bin/hardhat run
//    scripts/bootstrap-monad.ts --network monadTestnet)
//
// This script does NOT deploy anything — it reads the addresses already
// written to deployments/monad-testnet.json by `npm run deploy:monad` and,
// for every (market, tenor) pair (config/markets.ts x seed-series.ts's
// TENORS):
//   1. Creates enough CONSECUTIVE <SYMBOL>/USD option series ("rungs") to
//      cover that tenor's ladder — 20 rungs for 15m, 5 for 1h, 1 for 12h —
//      reusing any that already exist on-chain (see "Idempotency" below).
//   2. Approves and deposits mUSDC writer liquidity into TendPoolVault, up
//      to a target pool size, so the pool can actually write options. This
//      step is pool-level and only happens once, not once per market/tenor.
//   3. Authorizes every rung that needs it (`authorizeSeries`) so fills are
//      possible against it.
//   4. Extends deployments/monad-testnet.json with a `seededSeries` array
//      (one entry per (market, tenor) pair — the latest-expiry rung left
//      enabled) and a `pool` section describing what was seeded, for the
//      frontend and later phases to read.
//
// Steps 1-3 (the series parameters, the per-tenor ladder, the
// deposit-to-target behavior and the lastTradeAt bounds) live in
// scripts/lib/e2e/seed-series.ts, because scripts/keeper-monad.ts re-seeds
// fresh series on exactly the same terms when a market/tenor's ladder needs
// topping up. This script is the thin CLI wrapper around that routine plus
// the manifest write.
//
// Idempotency: re-running this script is safe. Series creation derives a
// deterministic id from its parameters (`deriveSeriesId`), and each tenor's
// ladder rungs are anchored to that tenor's OWN absolute grid (see
// `tenorLadderBase` in seed-series.ts) — re-runs whose "now" falls in the
// same grid window reuse the exact same rungs instead of reverting on
// `SeriesAlreadyExists`. Liquidity deposits only top the pool up to the
// target level (skipped if already at/above it), and each rung's
// authorization is only (re-)sent if it isn't already active with a valid
// cutoff.
import { network } from "hardhat";
import type { Hex } from "viem";
import { MONAD_TESTNET } from "../config/monad.js";
import { ROBINHOOD_TESTNET } from "../config/robinhood.js";
import { formatMUSDC } from "./lib/e2e/format.js";
import {
  ensureSeededSeries,
  manifestPathFor,
  readDeployManifest,
  writeDeployManifest,
} from "./lib/e2e/seed-series.js";

async function main() {
  const connection = await network.create();
  const { viem, networkName } = connection;

  // The manifest is resolved from the CONNECTED network, not a fixed path:
  // seeding Robinhood against Monad's addresses would create series on a
  // factory that does not exist on this chain.
  const manifestPath = manifestPathFor(networkName);
  const manifest = await readDeployManifest(manifestPath);

  const SUPPORTED = [MONAD_TESTNET.name, ROBINHOOD_TESTNET.name];
  if (!SUPPORTED.includes(networkName)) {
    await connection.close();
    throw new Error(
      `Connected to "${networkName}", which has no deployment manifest. This script only makes ` +
        `sense against a network the contracts were deployed to (${SUPPORTED.join(", ")}) — run ` +
        `with "--network monadTestnet" or "--network robinhoodTestnet".`,
    );
  }
  if (manifest.chainId !== undefined && Number(manifest.chainId) !== Number(connection.networkConfig.chainId)) {
    await connection.close();
    throw new Error(
      `Manifest ${manifestPath} is for chain ${manifest.chainId}, but this connection is chain ` +
        `${connection.networkConfig.chainId}. Refusing to seed against the wrong chain's addresses.`,
    );
  }

  const [deployerClient] = await viem.getWalletClients();
  if (deployerClient === undefined) {
    await connection.close();
    throw new Error(
      `No account configured for "${networkName}". Set MONAD_DEPLOYER_KEY (the deployer key, ` +
        `used for both testnets) in .env and retry.`,
    );
  }
  const deployer = deployerClient.account.address;
  const publicClient = await viem.getPublicClient();

  console.log(`Network: ${networkName} (chainId ${connection.networkConfig.chainId})`);
  console.log(`Deployer / manager / quote authority: ${deployer}`);
  if (deployer.toLowerCase() !== manifest.deployer.toLowerCase()) {
    console.log(
      `  Warning: this key (${deployer}) differs from the manifest's recorded deployer ` +
        `(${manifest.deployer}). authorizeSeries and manager-gated calls will revert unless this ` +
        `key is also the pool manager.`,
    );
  }

  const factory = await viem.getContractAt("TendSeriesFactory", manifest.contracts.tendSeriesFactory as Hex);
  const vault = await viem.getContractAt("TendPoolVault", manifest.contracts.tendPoolVault as Hex);
  const mockUSDC = await viem.getContractAt("MockERC20", manifest.contracts.mockUSDC as Hex);

  const seeded = await ensureSeededSeries({
    publicClient,
    factory,
    vault,
    mockUSDC,
    deployer,
    settlementToken: manifest.contracts.mockUSDC as Hex,
    priorSeededSeries: manifest.seededSeries,
    priorPool: manifest.pool,
    log: (line) => console.log(line),
  });

  // -------------------------------------------------------------------------
  // Persist results into the manifest.
  // -------------------------------------------------------------------------
  await writeDeployManifest(
    {
      ...manifest,
      seededSeries: seeded.seededSeries,
      pool: seeded.pool,
    },
    manifestPath,
  );
  console.log(`\nWrote seededSeries + pool sections to ${manifestPath}`);

  await connection.close();

  console.log("\nBootstrap complete:");
  for (const result of seeded.results) {
    const enabledRungs = result.rungs.filter((r) => r.enabled).length;
    console.log(`  ${result.symbol} / ${result.tenorId}: ${enabledRungs}/${result.rungs.length} rung(s) fillable.`);
    if (result.seededSeries) {
      console.log(`    manifest seriesId: ${result.seededSeries.seriesId}`);
      console.log(`    manifest lastTradeAt: ${result.seededSeries.lastTradeAt}`);
    } else {
      console.log(`    no fillable rung this call — nothing to pin in the manifest.`);
    }
    for (const rung of result.rungs) {
      if (rung.skipReason) console.log(`    rung ${rung.rung}: skipped — ${rung.skipReason}`);
    }
  }
  console.log(`  totalAssets: ${seeded.totalAssetsAfter} raw (${formatMUSDC(seeded.totalAssetsAfter)} mUSDC)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
