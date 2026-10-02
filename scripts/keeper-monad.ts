// Keeper: one idempotent sweep that keeps the public Monad testnet demo alive
// without anyone watching it. Safe to run repeatedly on a schedule (see
// .github/workflows/monad-keeper.yml, which requests every 15 minutes — see
// scripts/lib/e2e/seed-series.ts's TENORS comment for how far off that
// request the real, measured cadence is, and why Phase 2 has to seed a
// LADDER of series per tenor rather than just the next one).
//
// Two things kill the unattended demo, and this script fixes both, in order:
//
//   Phase 1 — resolve every resolvable position. Positions that expire and are
//   never settled or refunded keep `vault.openPositions()` above zero forever.
//
//   Phase 2 — ensure every configured (market, tenor) pair's ladder of series
//   is topped up. `TendPoolVault.authorizeSeries` (contracts/TendPoolVault.sol,
//   around line 247) reverts `PoolHasOpenPositions` while `openPositions != 0
//   || lockedCollateral != 0` — but ONLY for RE-authorizing a series that
//   already has a `seriesAuth` entry. Enabling a genuinely NEW one is always
//   allowed, open positions or not (see the `@dev` comment on
//   `authorizeSeries` for the safety argument). So Phase 1 running before
//   Phase 2 still matters — it clears the way for re-authorizations that
//   need it — but a single stale open position no longer blocks EVERY new
//   rung the way it used to; Phase 2 always attempts the ladder and lets
//   `ensureSeededSeries` sort brand-new-vs-re-auth out per rung.
//
// Usage:
//   npm run keeper:monad
//   DRY_RUN=1 npm run keeper:monad    # log every action, send nothing
//   (equivalent to: node --env-file=.env node_modules/.bin/hardhat run
//    scripts/keeper-monad.ts --network monadTestnet)
//
// DRY_RUN=1 is genuinely side-effect-free: no transaction is sent and the
// manifest is not written. Every read (including the Hermes price fetch, the
// MockPyth update-data construction and its fee quote) still runs, so the log
// shows exactly what a live run would do. A funded MONAD_DEPLOYER_KEY is still
// required even in dry-run, because the contract handles are built from the
// configured wallet.
//
// Everything it does is permissionless except `authorizeSeries` (pool
// manager) — settlement publishing, settling and refunding can be sent by
// anyone, and payouts/refunds always go to each position's recorded buyer, not
// to the keeper. The keeper therefore sends everything as the deployer and
// never needs the buyer wallet.
//
// Exit code: 0 when the sweep completes, even if individual items were skipped
// for legitimate reasons (not expired yet, settlement dead zone, a rung's
// authorization deferred to a later run). Non-zero only on a genuine failure
// — unreachable RPC, no key configured, Phase 2 unable to leave ANY fillable
// series for some (market, tenor) pair, or every attempted item reverting.
import { network } from "hardhat";
import { type Hex, createPublicClient, formatEther, http } from "viem";
import { MARKETS } from "../config/markets.js";
import { MONAD_TESTNET } from "../config/monad.js";
import { ROBINHOOD_TESTNET } from "../config/robinhood.js";
import { monadTestnetChain, robinhoodTestnetChain, explorerTx } from "./lib/e2e/chain.js";
import { explainRevert } from "./lib/e2e/errors.js";
import { formatMUSDC } from "./lib/e2e/format.js";
import {
  manifestPathFor,
  TENORS,
  type SeededSeries,
  ensureSeededSeries,
  readDeployManifest,
  writeDeployManifest,
} from "./lib/e2e/seed-series.js";
import { loadSettlementOracle, publishSettlementForSeries } from "./lib/e2e/settlement.js";
import { createKeeperBudget } from "./lib/keeper-budget.js";

// The public `positions(uint256)` getter FLATTENS the Position struct into
// multiple named return values, so viem returns an ARRAY tuple — NOT an object
// with named keys. This exact trap has bitten this repo repeatedly; see
// web/src/hooks/usePositions.ts and scripts/settle-monad-position.ts for the
// same pattern. Field order (contracts/TendPoolVault.sol `struct Position`):
// [buyer, seriesId, direction, strike, width, premium, maxPayout, feeBps,
// settled]. `factory.getSeries` is the opposite — it returns a named-struct
// OBJECT, because it is a hand-written getter returning `Series memory`.
const POS_BUYER = 0;
const POS_SERIES_ID = 1;
const POS_PREMIUM = 5;
const POS_MAX_PAYOUT = 6;
const POS_SETTLED = 8;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Position ids are read in small concurrent batches: the public Monad testnet
// RPC is slow enough that a strictly sequential sweep over a few hundred ids
// would dominate the run time, but large parallel bursts get rate-limited.
const POSITION_READ_BATCH_SIZE = 20;

interface UnsettledPosition {
  id: bigint;
  buyer: Hex;
  premium: bigint;
  maxPayout: bigint;
}

interface SweepSummary {
  positionsScanned: number;
  positionsUnsettled: number;
  settlementsPublished: number;
  settled: number;
  refunded: number;
  skippedNotExpired: number;
  skippedDeadZone: number;
  failures: number;
  /// "SYMBOL/tenorId" pairs (config/markets.ts x seed-series.ts's TENORS)
  /// that got at least one newly created or newly authorized ladder rung
  /// this run.
  reseededPairs: string[];
  /// Per "SYMBOL/tenorId" pair: the currently-fillable series id (the
  /// latest-expiry rung `ensureSeededSeries` left enabled), or null when
  /// nothing is fillable for that pair.
  fillableByPair: Record<string, Hex | null>;
}

function isDryRun(): boolean {
  const raw = (process.env.DRY_RUN ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function shortError(error: unknown): string {
  const explained = explainRevert(error);
  return explained.split("\n")[0];
}

async function main() {
  const dryRun = isDryRun();

  const connection = await network.create();
  const { viem, networkName } = connection;

  // Chain comes from the CONNECTION, not a constant: this keeper now sweeps
  // two testnets, and reading Monad's manifest while connected to Robinhood
  // would settle and seed against contracts that do not exist there. Resolved
  // after network.create() because the connected network is what decides it.
  const isRobinhood = networkName === ROBINHOOD_TESTNET.name;
  const chainConfig = isRobinhood ? ROBINHOOD_TESTNET : MONAD_TESTNET;
  const viemChain = isRobinhood ? robinhoodTestnetChain : monadTestnetChain;
  const manifestPath = manifestPathFor(networkName);
  const manifest = await readDeployManifest(manifestPath);

  const summary: SweepSummary = {
    positionsScanned: 0,
    positionsUnsettled: 0,
    settlementsPublished: 0,
    settled: 0,
    refunded: 0,
    skippedNotExpired: 0,
    skippedDeadZone: 0,
    failures: 0,
    reseededPairs: [],
    fillableByPair: Object.fromEntries(
      MARKETS.flatMap((market) => TENORS.map((tenor) => [`${market.symbol}/${tenor.id}`, null])),
    ),
  };
  // Set when the run hit something that means the demo is actually broken (as
  // opposed to "nothing to do"), which is the only thing that makes the
  // process exit non-zero.
  let fatalReason: string | null = null;

  try {
    if (networkName !== MONAD_TESTNET.name && networkName !== ROBINHOOD_TESTNET.name) {
      throw new Error(
        `Connected to "${networkName}", which has no deployment. Run with ` +
          `"--network monadTestnet" (npm run keeper:monad) or "--network robinhoodTestnet" ` +
          `(npm run keeper:robinhood).`,
      );
    }
    if (manifest.chainId !== undefined && Number(manifest.chainId) !== chainConfig.chainId) {
      throw new Error(
        `Manifest ${manifestPath} is for chain ${manifest.chainId}, but this run targets ` +
          `${chainConfig.chainId}. Refusing to sweep against the wrong chain's addresses.`,
      );
    }

    const [deployerClient] = await viem.getWalletClients();
    if (deployerClient === undefined) {
      throw new Error(
        `No account configured for "${networkName}". Set MONAD_DEPLOYER_KEY (the deployer key, used ` +
          `for both testnets) in the environment (.env locally, or the repository secret in CI) and retry.`,
      );
    }
    const deployer = deployerClient.account.address;
    const publicClient = createPublicClient({ chain: viemChain, transport: http(chainConfig.rpcUrl) });

    console.log(`Tend keeper — ${dryRun ? "DRY RUN (no transactions will be sent)" : "LIVE"}`);
    console.log(`Network: ${networkName} (chainId ${chainConfig.chainId})`);
    console.log(`Keeper account (deployer / pool manager): ${deployer}`);
    if (deployer.toLowerCase() !== manifest.deployer.toLowerCase()) {
      console.log(
        `  Warning: this key (${deployer}) differs from the manifest's recorded deployer ` +
          `(${manifest.deployer}). Settling and refunding are permissionless so Phase 1 still works, but ` +
          `Phase 2's authorizeSeries will revert unless this key is also the pool manager.`,
      );
    }

    // Informational only. Settlement/refund work must never be blocked by the
    // cost of rebuilding every possible ladder rung.
    const balance = await publicClient.getBalance({ address: deployer });
    const gasPrice = await publicClient.getGasPrice();
    const GAS_PER_RUNG_RESEED = 461_000n;
    const TOTAL_LADDER_RUNGS = TENORS.reduce((sum, tenor) => sum + tenor.ladderSize, 0);
    const worstCaseGas = GAS_PER_RUNG_RESEED * BigInt(TOTAL_LADDER_RUNGS) * BigInt(MARKETS.length);
    const needed = (worstCaseGas * gasPrice * 3n) / 2n;
    console.log(
      `Keeper balance: ${formatEther(balance)} MON ` +
        `(worst-case full-ladder rebuild for ${MARKETS.length} market(s) x ${TOTAL_LADDER_RUNGS} rung(s) at ` +
        `${Number(gasPrice) / 1e9} gwei: ~${formatEther(needed)} MON)`,
    );
    if (balance < needed) console.log(`  Full rebuild is not affordable; Phase 1 will run and Phase 2 will seed only affordable work.`);

    const gasReserve = isRobinhood ? 5_000_000_000_000_000n : 100_000_000_000_000_000n;
    const seedBudget = createKeeperBudget({
      reserveWei: gasReserve,
      dryRun,
      balance: () => publicClient.getBalance({ address: deployer }),
      gasPrice: () => publicClient.getGasPrice(),
    });
    console.log(`  Seeding gas reserve: ${formatEther(gasReserve)} native token; balance and gas price refresh before each write.`);

    const factory = await viem.getContractAt("TendSeriesFactory", manifest.contracts.tendSeriesFactory as Hex);
    const vault = await viem.getContractAt("TendPoolVault", manifest.contracts.tendPoolVault as Hex);
    const mockUSDC = await viem.getContractAt("MockERC20", manifest.contracts.mockUSDC as Hex);
    // The settlement oracle: factory.pyth() points here, not at Monad
    // testnet's canonical Pyth receiver (which rejects live Hermes Wormhole
    // VAAs) — see scripts/lib/e2e/settlement.ts for the full explanation.
    const { mockPyth, priceOracle } = await loadSettlementOracle(viem, manifest.contracts);

    // =====================================================================
    // PHASE 1 — resolve every resolvable position.
    // =====================================================================
    console.log(`\n=== PHASE 1: resolve expired positions ===`);

    const openBefore = (await vault.read.openPositions()) as bigint;
    const lockedBefore = (await vault.read.lockedCollateral()) as bigint;
    const nextPositionId = (await vault.read.nextPositionId()) as bigint;
    console.log(`  vault.openPositions()    = ${openBefore}`);
    console.log(`  vault.lockedCollateral() = ${formatMUSDC(lockedBefore)} mUSDC`);
    console.log(`  vault.nextPositionId()   = ${nextPositionId} (ids 1..${nextPositionId - 1n} exist)`);

    // Group unsettled positions BY SERIES. This is the point of the whole
    // pass: a series has exactly ONE settlement, so publishSettlement must be
    // called once per series (a second call reverts AlreadyFinalized), while
    // settlePoolPosition/refundPoolPosition are per position. Iterating
    // positions directly would try to publish once per position.
    const unsettledBySeries = new Map<Hex, UnsettledPosition[]>();

    const ids: bigint[] = [];
    for (let id = 1n; id < nextPositionId; id++) ids.push(id);

    for (let offset = 0; offset < ids.length; offset += POSITION_READ_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + POSITION_READ_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            return { id, tuple: (await vault.read.positions([id])) as readonly unknown[] };
          } catch (error) {
            // A single unreadable id must not abort the sweep.
            console.log(`  position ${id}: read failed, skipping — ${shortError(error)}`);
            return { id, tuple: undefined };
          }
        }),
      );
      for (const { id, tuple } of results) {
        if (tuple === undefined) {
          summary.failures += 1;
          continue;
        }
        summary.positionsScanned += 1;
        const buyer = tuple[POS_BUYER] as Hex;
        const seriesId = tuple[POS_SERIES_ID] as Hex;
        if (buyer.toLowerCase() === ZERO_ADDRESS) continue; // never-written slot
        if (tuple[POS_SETTLED] as boolean) continue; // already settled or refunded
        summary.positionsUnsettled += 1;
        const entry: UnsettledPosition = {
          id,
          buyer,
          premium: tuple[POS_PREMIUM] as bigint,
          maxPayout: tuple[POS_MAX_PAYOUT] as bigint,
        };
        const existing = unsettledBySeries.get(seriesId);
        if (existing === undefined) unsettledBySeries.set(seriesId, [entry]);
        else existing.push(entry);
      }
    }

    console.log(
      `  Scanned ${summary.positionsScanned} position slot(s): ${summary.positionsUnsettled} unsettled, ` +
        `spread across ${unsettledBySeries.size} series.`,
    );

    for (const [seriesId, positions] of unsettledBySeries) {
      const idList = positions.map((p) => p.id).join(", ");
      console.log(`\n  Series ${seriesId} — ${positions.length} unsettled position(s): ${idList}`);
      try {
        const series = await factory.read.getSeries([seriesId]);
        const expiry = series.expiry;
        const observationWindow = BigInt(series.observationWindow);
        const settlementGrace = BigInt(series.settlementGrace);
        const observationEnd = expiry + observationWindow;
        const settlementDeadline = observationEnd + settlementGrace;
        const now = (await publicClient.getBlock()).timestamp;

        console.log(
          `    expiry=${expiry} (${new Date(Number(expiry) * 1000).toISOString()}), ` +
            `observationEnd=${observationEnd}, settlementDeadline=${settlementDeadline}, chain now=${now}`,
        );

        if (now < expiry) {
          summary.skippedNotExpired += positions.length;
          console.log(
            `    Not ready: ${expiry - now}s remain until expiry. Skipping ${positions.length} position(s).`,
          );
          continue;
        }

        const refundable = (await factory.read.isRefundable([seriesId])) as boolean;
        console.log(`    factory.isRefundable(seriesId) == ${refundable}`);

        if (refundable) {
          // Nobody published a settlement before the deadline: the honest
          // fail-safe is to return each buyer's premium and release the
          // pool's collateral.
          console.log(`    REFUND path — settlement deadline passed with no finalized settlement.`);
          for (const position of positions) {
            try {
              if (dryRun) {
                console.log(
                  `      [dry-run] would call vault.refundPoolPosition(${position.id}) — returns ` +
                    `${formatMUSDC(position.premium)} mUSDC premium to ${position.buyer} and releases ` +
                    `${formatMUSDC(position.maxPayout)} mUSDC collateral.`,
                );
                summary.refunded += 1;
                continue;
              }
              const hash = await vault.write.refundPoolPosition([position.id]);
              await publicClient.waitForTransactionReceipt({ hash });
              summary.refunded += 1;
              console.log(`      refunded position ${position.id}: ${explorerTx(hash, publicClient.chain?.id)}`);
            } catch (error) {
              summary.failures += 1;
              console.log(`      position ${position.id}: refundPoolPosition failed — ${shortError(error)}`);
            }
          }
          continue;
        }

        if (now <= settlementDeadline) {
          console.log(`    SETTLE path — expired and still inside the settlement window.`);

          const settlement = (await factory.read.getSettlement([seriesId])) as { finalized: boolean };
          if (settlement.finalized) {
            console.log(`    Settlement already finalized for this series — publishing skipped.`);
          } else {
            // ONCE per series, never once per position.
            const published = await publishSettlementForSeries({
              publicClient,
              factory,
              mockPyth,
              priceOracle,
              seriesId,
              series,
              publisher: deployer,
              dryRun,
              log: (line) => console.log(`    ${line}`),
            });
            summary.settlementsPublished += 1;
            if (published.publishTxHash !== null) {
              console.log(`    Settlement published for series ${seriesId}.`);
            }
          }

          for (const position of positions) {
            try {
              if (dryRun) {
                console.log(
                  `      [dry-run] would call vault.settlePoolPosition(${position.id}) — pays the buyer ` +
                    `${position.buyer} and releases up to ${formatMUSDC(position.maxPayout)} mUSDC collateral.`,
                );
                summary.settled += 1;
                continue;
              }
              const hash = await vault.write.settlePoolPosition([position.id]);
              await publicClient.waitForTransactionReceipt({ hash });
              summary.settled += 1;
              console.log(`      settled position ${position.id}: ${explorerTx(hash, publicClient.chain?.id)}`);
            } catch (error) {
              summary.failures += 1;
              console.log(`      position ${position.id}: settlePoolPosition failed — ${shortError(error)}`);
            }
          }
          continue;
        }

        // Past the settlement deadline yet isRefundable() is still false —
        // typically an already-finalized settlement whose positions were never
        // settled. Those are handled by the branch above while the window is
        // open; landing here means the window closed too. Diagnose loudly,
        // never throw: one stuck series must not abort the sweep.
        console.log(
          `    DEAD ZONE — chain time ${now} is past settlementDeadline ${settlementDeadline} ` +
            `(= expiry ${expiry} + observationWindow ${observationWindow} + settlementGrace ` +
            `${settlementGrace}), yet factory.isRefundable(${seriesId}) is false. That means a settlement ` +
            `IS finalized, so these ${positions.length} position(s) should still be settleable — attempting ` +
            `settlePoolPosition anyway.`,
        );
        for (const position of positions) {
          try {
            if (dryRun) {
              console.log(`      [dry-run] would call vault.settlePoolPosition(${position.id}).`);
              summary.settled += 1;
              continue;
            }
            const hash = await vault.write.settlePoolPosition([position.id]);
            await publicClient.waitForTransactionReceipt({ hash });
            summary.settled += 1;
            console.log(`      settled position ${position.id}: ${explorerTx(hash, publicClient.chain?.id)}`);
          } catch (error) {
            // Counted as a dead-zone skip, NOT a failure: a genuinely stuck
            // position here would otherwise make every scheduled run exit
            // non-zero forever. It is reported loudly in the summary instead.
            summary.skippedDeadZone += 1;
            console.log(
              `      position ${position.id}: settlePoolPosition failed in the dead zone — ` +
                `${shortError(error)}. This position needs manual attention.`,
            );
          }
        }
      } catch (error) {
        summary.failures += 1;
        console.log(`    Series ${seriesId} failed, continuing with the rest — ${shortError(error)}`);
      }
    }

    // =====================================================================
    // PHASE 2 — ensure every (market, tenor) ladder is topped up.
    // =====================================================================
    console.log(`\n=== PHASE 2: ensure every market/tenor ladder is topped up ===`);

    const openAfter = (await vault.read.openPositions()) as bigint;
    const lockedAfter = (await vault.read.lockedCollateral()) as bigint;
    console.log(`  vault.openPositions()    = ${openAfter}`);
    console.log(`  vault.lockedCollateral() = ${formatMUSDC(lockedAfter)} mUSDC`);
    console.log(
      openAfter === 0n && lockedAfter === 0n
        ? `  Pool is flat — every rung (new or re-authorization) may proceed.`
        : `  Pool is NOT flat — brand-new rungs still proceed (TendPoolVault's relaxed authorizeSeries guard); ` +
          `re-authorizing any already-touched rung will be skipped this run and left for a later, flatter run.`,
    );

    // Always attempted, regardless of pool state: `ensureSeededSeries` is
    // idempotent (it re-derives every ladder rung's deterministic id and
    // only sends a transaction for what's actually missing or stale) and
    // internally gates re-authorizations on pool flatness per rung — see its
    // own doc comment. This subsumes the old "which known series are still
    // fillable" prescan: re-deriving every rung's id from the tenor's own
    // grid is authoritative discovery, not a guess from a possibly-stale
    // manifest.
    try {
      const seeded = await ensureSeededSeries({
        publicClient,
        factory,
        vault,
        mockUSDC,
        deployer,
        settlementToken: manifest.contracts.mockUSDC as Hex,
        priorSeededSeries: manifest.seededSeries,
        priorPool: manifest.pool,
        dryRun,
        authorizeSpend: async (operation, label, estimatedGas) => {
          if (operation === "completeSeedRung") {
            const decision = await seedBudget.complete(`seedRung ${label}`, estimatedGas ?? 223_000n);
            return { allowed: decision.allowed, reason: decision.reason, gasPriceWei: decision.gasPriceWei };
          }
          const authorizationHold = operation === "seedRung" ? 223_000n : 0n;
          const gasUnits = (estimatedGas ?? 0n) + authorizationHold;
          const decision = await seedBudget.claim({
            label: `${operation} ${label}`,
            gasUnits,
            holdGasUnits: authorizationHold,
          });
          return { allowed: decision.allowed, reason: decision.reason, gasPriceWei: decision.gasPriceWei };
        },
        log: (line) => console.log(`  ${line}`),
      });

      for (const result of seeded.results) {
        const key = `${result.symbol}/${result.tenorId}`;
        summary.fillableByPair[key] = result.seededSeries ? (result.seededSeries.seriesId as Hex) : null;
        if (result.rungs.some((rung) => rung.createdSeries || rung.authorizedSeries)) {
          summary.reseededPairs.push(key);
        }
        const enabledCount = result.rungs.filter((rung) => rung.enabled).length;
        console.log(`  ${key}: ${enabledCount}/${result.rungs.length} rung(s) fillable.`);
        for (const rung of result.rungs) {
          if (rung.skipReason) console.log(`    rung ${rung.rung}/${result.rungs.length}: skipped — ${rung.skipReason}`);
        }
      }
      const budgetState = seedBudget.snapshot();
      console.log(
        `  Seeding budget: bounded up to ${formatEther(budgetState.committedWei)} native token; ` +
          `${budgetState.deferred.length} operation(s) deferred.`,
      );
      for (const reason of budgetState.deferred) console.log(`    ${reason}`);

      // Merge every (market, tenor) result into the existing manifest array
      // — every pair untouched this run keeps its prior entry unchanged.
      const priorByKey = new Map((manifest.seededSeries ?? []).map((entry) => [`${entry.symbol}:${entry.tenorId}`, entry]));
      for (const entry of seeded.seededSeries) priorByKey.set(`${entry.symbol}:${entry.tenorId}`, entry);
      const mergedSeededSeries: SeededSeries[] = Array.from(priorByKey.values());

      if (dryRun) {
        console.log(
          `  [dry-run] would write seededSeries + pool sections to ${manifestPath} — manifest left untouched.`,
        );
      } else {
        await writeDeployManifest(
          {
            ...manifest,
            seededSeries: mergedSeededSeries,
            pool: seeded.pool,
          },
          manifestPath,
        );
        console.log(`  Wrote seededSeries + pool sections to ${manifestPath}`);
      }

      const stillDead = seeded.results.filter((result) => !result.seededSeries).map((result) => `${result.symbol}/${result.tenorId}`);
      if (stillDead.length > 0) {
        fatalReason =
          `Phase 2 could not leave a fillable series for: ${stillDead.join(", ")}. The demo has no tradable ` +
          `series there until this is resolved.`;
        console.log(`  FAILED — ${fatalReason}`);
      }
    } catch (error) {
      summary.failures += 1;
      fatalReason = `Phase 2 threw: ${shortError(error)}`;
      console.log(`  FAILED — ${fatalReason}`);
    }
  } catch (error) {
    // Anything that escapes to here is a whole-run failure (unreachable RPC,
    // missing key, wrong network) rather than one bad position.
    summary.failures += 1;
    fatalReason = shortError(error);
    console.error(error);
  } finally {
    await connection.close();
  }

  // -----------------------------------------------------------------------
  // Result.
  // -----------------------------------------------------------------------
  const attempted = summary.settled + summary.refunded + summary.failures;
  if (fatalReason === null && attempted > 0 && summary.settled + summary.refunded === 0) {
    fatalReason = `every one of the ${summary.failures} attempted action(s) failed`;
  }

  console.log(`\n=== KEEPER SUMMARY ===`);
  console.log(`  mode:                 ${dryRun ? "DRY RUN (nothing sent)" : "live"}`);
  console.log(`  positions scanned:    ${summary.positionsScanned} (${summary.positionsUnsettled} unsettled)`);
  console.log(`  settlements published: ${summary.settlementsPublished}`);
  console.log(`  settled:              ${summary.settled}`);
  console.log(`  refunded:             ${summary.refunded}`);
  console.log(`  skipped (not expired): ${summary.skippedNotExpired}`);
  console.log(`  skipped (dead zone):  ${summary.skippedDeadZone}`);
  console.log(`  failures:             ${summary.failures}`);
  console.log(
    `  pairs reseeded:       ${summary.reseededPairs.length > 0 ? summary.reseededPairs.join(", ") : "none"}`,
  );
  for (const market of MARKETS) {
    for (const tenor of TENORS) {
      const key = `${market.symbol}/${tenor.id}`;
      console.log(`  ${key.padEnd(10)} fillable series:   ${summary.fillableByPair[key] ?? "none"}`);
    }
  }

  const pairsSummary = MARKETS.flatMap((market) =>
    TENORS.map((tenor) => {
      const key = `${market.symbol}/${tenor.id}`;
      return `${key}=${summary.fillableByPair[key] ?? "none"}`;
    }),
  ).join(",");

  const resultLine =
    `keeper ${dryRun ? "dry-run " : ""}result: settled=${summary.settled} refunded=${summary.refunded} ` +
    `published=${summary.settlementsPublished} skipped=${summary.skippedNotExpired + summary.skippedDeadZone} ` +
    `failures=${summary.failures} ` +
    `reseeded=${summary.reseededPairs.length > 0 ? summary.reseededPairs.join(",") : "none"} ` +
    `fillableSeries[${pairsSummary}]`;

  if (fatalReason !== null) {
    console.error(`${resultLine} — FAILED: ${fatalReason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${resultLine} — OK`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
