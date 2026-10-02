// The "make sure a fillable series exists for every configured market, backed
// by pool liquidity" routine, extracted from scripts/bootstrap-monad.ts so the
// unattended keeper (scripts/keeper-monad.ts) can reuse it verbatim instead of
// copy-pasting the series parameters, expiry bucketing, deposit-to-target
// behavior and authorization bounds. Both callers therefore produce
// byte-identical series parameters per market/tenor/rung (and thus, within a
// given tenor's own grid window, the same deterministic seriesId — see
// `tenorLadderBase` below).
//
// It does NOT deploy anything and it does NOT write the manifest — the caller
// owns that, so bootstrap and the keeper can each decide what to persist. The
// manifest *shape* lives here so both agree on it.
//
// Which markets get seeded is driven entirely by config/markets.ts — this
// module has zero asset-specific logic. Adding a third market is a one-line
// change there; nothing here needs to change.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Hex, stringToHex } from "viem";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { MARKETS, type MarketConfig } from "../../../config/markets.js";
import { explorerTx } from "./chain.js";
import { explainRevert } from "./errors.js";
import { formatMUSDC } from "./format.js";
import { fairRungOrder, leastCoveredPairs } from "../keeper-budget.js";

// --- Series parameters shared by every tenor --------------------------------
//
// TendSeriesFactory bounds (contracts/TendSeriesFactory.sol):
//   MIN_SERIES_LEAD        = 15 minutes  (expiry must be >= now + this)
//   MAX_OBSERVATION_WINDOW = 1 hour
//   MAX_SETTLEMENT_GRACE   = 24 hours
//   MAX_CONFIDENCE_BPS     = 2_000 (20%)
// The values below are chosen with a wide safety margin under every bound, and
// apply identically to every configured market and every tenor — none of
// these bounds are asset- or tenor-specific.
export const OBSERVATION_WINDOW_SECONDS = 60; // 1 minute — well under the 1 hour max.
export const SETTLEMENT_GRACE_SECONDS = 60 * 60; // 1 hour — well under the 24 hour max.
export const MAX_CONFIDENCE_BPS = 500; // 5% — well under the 2,000 bps (20%) max.

// --- Tenors + the ladder --------------------------------------------------
//
// Traders pick their own expiry — 15 minutes, 1 hour, or 12 hours — instead
// of the single hardcoded tenor this file used to seed. That single tenor
// was raised from 2h to 12h on 2026-08-15 purely to cut the keeper's gas
// burn after two demo outages (2026-08-05, 2026-08-14) caused by reseeding
// too often; see git history on `SERIES_LEAD_SECONDS` for the arithmetic.
// 12h alone made for a poor demo, though: every trade expired overnight and
// a tester never saw a settlement. It remains one of the three tenors below
// (unchanged parameters), alongside two shorter ones.
//
// *** Why a LADDER of series per tenor, not just "the next one" — this is
// *** the non-obvious part, and the reason this file is more than a loop
// *** over three lead times. ***
//
// The obvious implementation mirrors what this file did before: "ensure the
// next series for each tenor exists." That is correct for 12h and WRONG for
// 15m, because the keeper does not actually run on the schedule it asks for.
// `.github/workflows/monad-keeper.yml` requests every 15 minutes
// (`*/15 * * * *`), but GitHub Actions scheduling on a private repo is
// best-effort and gets throttled under low usage. Measured real invocation
// timestamps from the Actions run history:
//     15:12, 11:33, 06:24, 01:27, 23:34, 21:37
//     -> gaps of 3.6h, 5.1h, 4.9h, 1.9h, 2.0h between consecutive runs.
// A single "next" 15-minute series is dead within minutes of being created,
// and the demo has NOTHING tradable in that tenor for hours until the next
// run happens to fire. "Just create the next one" silently breaks the exact
// tenor it was added for — it works fine in local testing (where you run the
// script yourself, seconds apart) and then goes dark in the one place it has
// to actually hold up: the unattended CI keeper.
//
// The fix: each run creates enough CONSECUTIVE series ahead of "now" — a
// ladder — to survive the worst gap actually observed (~5.1h; rounded up to
// 5h for margin). `ladderSize = ceil(5h / leadSeconds)`, computed once here
// and then hardcoded per tenor below (not left as a runtime formula) so the
// assumption is visible to whoever reads this file, not just to whoever
// derived it:
//     15m tenor: ceil(5h / 15m) = 20 rungs
//     1h  tenor: ceil(5h / 1h)  = 5 rungs
//     12h tenor: ceil(5h / 12h) = 1 rung  (unchanged — 12h already outlives
//                                          every observed gap on its own)
// If this ever gets "simplified" back to one series per tenor, the 15-minute
// tenor will silently go dark for hours at a time again — this comment is
// here so that change gets caught in review instead of discovered by a
// tester staring at an empty ticket.
export interface TenorConfig {
  /** Stable id — used in the manifest, keeper/bootstrap logs, and mirrored
   * by hand into web/src/lib/seriesParams.ts for the SPA's tenor selector. */
  id: "15m" | "1h" | "12h";
  /** Trader-facing label. */
  label: string;
  /** Time from a rung's own ladder base (see `tenorLadderBase`) to its expiry. */
  leadSeconds: bigint;
  /** How many consecutive rungs to maintain — see the ladder-sizing comment above. */
  ladderSize: number;
  /** How long before ITS OWN expiry a rung's lastTradeAt cutoff sits. See the
   * per-tenor buffer comment below `TENORS` for why this can't be one flat
   * constant shared across tenors. */
  lastTradeBufferSeconds: bigint;
}

// Per-tenor last-trade cutoff buffer (TendPoolVault.MIN_TRADE_LEAD = 15 min
// is a hard floor on `lastTradeAt - now` at authorization time, and
// `lastTradeAt` must stay strictly < expiry). The old flat 30-minute buffer
// was sized for a 12-hour tenor and is IMPOSSIBLE for a 15-minute one — 30
// minutes before a 15-minute-out expiry is already in the past. Each tenor
// therefore gets its own buffer, small relative to its own `leadSeconds`:
//     15m tenor: 60s    (leaves ~14m of the 15m window actually tradable)
//     1h  tenor: 5 min  (leaves ~55m of the 1h window actually tradable)
//     12h tenor: 30 min (unchanged — the original, already-tested value)
// Even with a 60s buffer, the VERY NEAREST rung of the 15-minute tenor can
// still fail the MIN_TRADE_LEAD floor in the worst case: if "now" lands
// right at a grid boundary, that rung's own expiry is only ~15 minutes out,
// leaving no room for both the 15-minute MIN_TRADE_LEAD floor and a positive
// buffer before it. `ensureSeededSeries` handles this per-rung below by
// SKIPPING (never aborting) authorization for just that one rung and logging
// why — `createSeries` still succeeds for it regardless (the factory's own
// bound is only 15 minutes), rung 2 onward cover the gap with room to spare,
// and a later run simply won't reconsider that specific rung once it has
// expired.
export const TENORS: readonly TenorConfig[] = [
  { id: "15m", label: "15 minutes", leadSeconds: 15n * 60n, ladderSize: 20, lastTradeBufferSeconds: 60n },
  { id: "1h", label: "1 hour", leadSeconds: 60n * 60n, ladderSize: 5, lastTradeBufferSeconds: 5n * 60n },
  { id: "12h", label: "12 hours", leadSeconds: 12n * 60n * 60n, ladderSize: 1, lastTradeBufferSeconds: 30n * 60n },
];

/**
 * The absolute grid boundary >= `nowSec`, quantized to `leadSeconds` and
 * anchored to the Unix epoch — NOT to whenever this happens to be called.
 * Ladder rung `i` (1-indexed) for a tenor then sits at
 * `tenorLadderBase(nowSec, tenor.leadSeconds) + i * tenor.leadSeconds`.
 *
 * Anchoring to each tenor's OWN grid (rather than reusing a shared 15-minute
 * grid computed relative to "now") is what makes the ladder cheap across
 * unpredictable keeper runs. A shared 15-minute-relative-to-now grid (the
 * pre-ladder approach this file used to take) happens to work for the
 * 15-minute tenor — its own lead already matches that grid — but NOT for the
 * 1h/12h tenors: those would land on a different phase of the grid almost
 * every run (the 15-minute rounding point drifts against a 1h or 12h period
 * depending on exactly when the keeper fires) and pay to recreate a whole
 * ladder of otherwise-still-valid series every single time. Anchoring each
 * tenor to multiples of its OWN `leadSeconds` fixes that: any two runs whose
 * "now" falls within the same `leadSeconds`-wide window compute the
 * IDENTICAL ladder rungs and reuse them for free via the
 * deriveSeriesId/seriesExists idempotency check below — exactly the
 * behavior the original single-tenor version relied on, generalized per
 * tenor instead of assumed to be 15 minutes for all of them.
 */
export function tenorLadderBase(nowSec: bigint, leadSeconds: bigint): bigint {
  return ((nowSec + leadSeconds - 1n) / leadSeconds) * leadSeconds;
}

/**
 * Qualifies a market's on-chain symbol per tenor — e.g. "BTC" + "15m" ->
 * "BTC-15M" — used as the `symbol` field of every series this tenor's
 * ladder creates.
 *
 * This is NOT cosmetic. `deriveSeriesId` hashes the FULL CreateSeriesParams
 * tuple, symbol included, so qualifying it makes each tenor's ladder live in
 * a completely disjoint id space. Without this, a client (or this seeder)
 * trying to answer "which tenor is candidate id X" purely from its expiry
 * timestamp CANNOT, in general: every expiry any tenor's ladder ever
 * produces is a multiple of 900 seconds (`tenorLadderBase` is always
 * anchored to a multiple of `leadSeconds`, and 900 divides every configured
 * `leadSeconds` — 900, 3600, 43200), so the 15-minute tenor's own candidate
 * grid is a SUPERSET of every other tenor's. Concretely: a real 12h-tenor
 * series with 4h43m left before expiry falls squarely inside the
 * 15-minute tenor's ~5h15m forward search window (useLiveSeries.ts —
 * sized to cover that tenor's own 20-rung ladder), and an unqualified
 * symbol would let the 15-minute tenor's search "find" and mislabel it as
 * a 15-minute-tenor series — precisely the "trader thinks they bought 15m,
 * actually got 12h" failure this feature exists to prevent. This was caught
 * empirically against the live testnet deployment (a real, currently-live
 * series created under the pre-ladder single-tenor scheme was cross-matched
 * by the 15-minute tenor's probe) before the fix, confirming it is a real
 * failure mode, not a hypothetical one.
 *
 * Fits well within the 31-ASCII-byte limit `stringToHex(_, {size:32})`
 * needs (config/markets.ts) — "BTC-15M" / "ETH-12H" are 7 characters.
 */
export function tenorQualifiedSymbol(marketSymbol: string, tenorId: string): string {
  return `${marketSymbol}-${tenorId.toUpperCase()}`;
}

// TendPoolVault bounds (contracts/TendPoolVault.sol):
//   MIN_TRADE_LEAD = 15 minutes (lastTradeAt must be >= now + this, and < expiry)
export const MIN_TRADE_LEAD_SECONDS = 15n * 60n; // mirrors TendPoolVault.MIN_TRADE_LEAD

/**
 * Safety margin added to the per-rung MIN_TRADE_LEAD check, on top of a
 * FRESH clock reading (see the guard below). A rung is checked in this
 * process but enforced against `block.timestamp` when its authorizeSeries
 * actually mines, which is seconds later; without a margin a rung sitting
 * exactly on the boundary passes the check here and reverts on chain.
 */
export const AUTHORIZE_LATENCY_MARGIN_SECONDS = 30n;

// --- Pool liquidity parameters ----------------------------------------------
const MUSDC_DECIMALS = 6;
// Target *level*, not a fixed top-up amount: re-running only deposits the
// shortfall (or nothing, if the pool is already at/above this level). This is
// pool-level, shared collateral for every market — it is deposited once per
// call, never once per market or tenor.
export const POOL_DEPOSIT_TARGET_RAW = BigInt(100_000) * BigInt(10) ** BigInt(MUSDC_DECIMALS);

export const DEPOSIT_DEADLINE_BUFFER_SECONDS = 10 * 60;

/// Manifest path for a given hardhat network name. PER CHAIN, deliberately:
/// this repo now deploys the same protocol to more than one testnet, and a
/// single shared path would have the Robinhood deploy silently overwrite the
/// live Monad manifest — pointing production at contracts on a chain it is
/// not connected to.
export function manifestPathFor(network: string): string {
  const file = network === "robinhoodTestnet" ? "robinhood-testnet.json" : "monad-testnet.json";
  return path.join(process.cwd(), "deployments", file);
}

/// Default (Monad) manifest path, kept for the many call sites that predate
/// multi-chain. New code should prefer manifestPathFor(network).
export const MANIFEST_PATH = manifestPathFor("monadTestnet");

// --- Manifest shape ----------------------------------------------------------

export interface DeployManifest {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  pythAddress: string;
  deployer: string;
  contracts: {
    mockUSDC: string;
    /** Legacy, unauthenticated: anyone can post. Absent on TendPriceOracle deployments. */
    mockPyth?: string;
    /** Admin-only TendPriceOracle; when present, settlement posts here. */
    priceOracle?: string;
    tendSeriesFactory: string;
    tendPoolVault: string;
  };
  deployedAt: string;
  /** One entry per (configured market, tenor) pair — e.g. BTC/15m, BTC/1h,
   * BTC/12h, ETH/15m, ... — in `markets x TENORS` order. Each entry is the
   * LATEST-expiry rung of that tenor's ladder that this call left enabled;
   * see `ensureSeededSeries`. It is a fallback pointer for the SPA, never
   * the authoritative "what's live" answer — useLiveSeries.ts re-derives
   * that straight from the chain. */
  seededSeries?: SeededSeries[];
  pool?: SeededPool;
}

export interface SeededSeries {
  symbol: string;
  pythFeedId: string;
  /** Which tenor this entry belongs to — see `TenorConfig.id`. */
  tenorId: string;
  seriesId: string;
  settlementToken: string;
  expiry: string;
  observationWindow: number;
  settlementGrace: number;
  maxConfidenceBps: number;
  lastTradeAt: string;
  createTxHash: string | null;
  authorizeTxHash: string | null;
  seededAt: string;
}

export interface SeededPool {
  depositTargetRaw: string;
  totalAssetsBeforeRaw: string;
  totalAssetsAfterRaw: string;
  approveTxHash: string | null;
  depositTxHash: string | null;
  seededAt: string;
}

export async function readDeployManifest(manifestPath: string = MANIFEST_PATH): Promise<DeployManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No manifest found at ${manifestPath}. Run "npm run deploy:monad" first — this only seeds an ` +
          `already-deployed protocol, it never deploys.`,
      );
    }
    throw error;
  }
  return JSON.parse(raw) as DeployManifest;
}

export async function writeDeployManifest(
  manifest: DeployManifest,
  manifestPath: string = MANIFEST_PATH,
): Promise<void> {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// --- Seeding -----------------------------------------------------------------

/// The slice of a viem PublicClient this module needs. Structural so both
/// Hardhat's `viem.getPublicClient()` (bootstrap) and a standalone
/// `createPublicClient(...)` (the keeper) satisfy it.
export interface SeedPublicClient {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<unknown>;
}

export interface EnsureSeededSeriesParams {
  publicClient: SeedPublicClient;
  factory: ContractReturnType<"TendSeriesFactory">;
  vault: ContractReturnType<"TendPoolVault">;
  mockUSDC: ContractReturnType<"MockERC20">;
  /// The account sending every transaction here (must be the pool manager for
  /// `authorizeSeries` to succeed).
  deployer: Hex;
  /// The series' settlement token — the manifest's mUSDC address, which must
  /// equal the vault's `asset`.
  settlementToken: Hex;
  /// Which markets to ensure a fillable ladder for. Defaults to every market
  /// in config/markets.ts.
  markets?: readonly MarketConfig[];
  /// Which tenors to ensure a ladder for, per market. Defaults to every
  /// tenor in `TENORS`. Narrowing this is mostly for tests — the keeper and
  /// bootstrap both use the default (every tenor).
  tenors?: readonly TenorConfig[];
  /// A previous run's recorded sections, so an idempotent no-op re-run keeps
  /// the original creation/authorization tx hashes instead of clobbering them
  /// with nulls. Matched by symbol + tenorId, then confirmed by seriesId — a
  /// config change (e.g. a different pythFeedId under the same symbol)
  /// computes a different seriesId and correctly drops the stale tx hashes
  /// rather than reusing them.
  priorSeededSeries?: readonly SeededSeries[];
  priorPool?: SeededPool;
  /// Unix seconds used for expiry bucketing and the lastTradeAt bounds check.
  /// Defaults to wall clock, matching bootstrap's original behavior.
  nowSeconds?: bigint;
  /// Log every action without sending a single transaction.
  dryRun?: boolean;
  /// Optional keeper-only native-gas gate. A denied operation is deferred,
  /// logged, and does not block other pairs or deeper idempotent reads.
  authorizeSpend?: (
    operation: "seedRung" | "authorizeSeries" | "completeSeedRung" | "approve" | "deposit",
    label: string,
    gasUnits?: bigint,
  ) => Promise<{ allowed: boolean; reason?: string; gasPriceWei?: bigint }>;
  log?: (line: string) => void;
}

/// One ladder rung's on-chain state after this call.
export interface RungResult {
  /// 1-indexed position in the tenor's ladder.
  rung: number;
  seriesId: Hex;
  expiry: bigint;
  createdSeries: boolean;
  isTradable: boolean;
  /// True only when this call actually sent authorizeSeries for this rung.
  authorizedSeries: boolean;
  /// The rung's seriesAuth state AFTER this call (whether or not this call
  /// changed it).
  enabled: boolean;
  lastTradeAt: bigint;
  /// Set when authorization for this rung was intentionally skipped this
  /// call (bounds too tight, or pool not flat for a required re-auth) —
  /// never set for a hard failure, which throws instead.
  skipReason?: string;
  createTxHash: string | null;
  authorizeTxHash: string | null;
}

/// One (market, tenor) pair's ladder after this call.
export interface MarketTenorResult {
  symbol: string;
  pythFeedId: Hex;
  tenorId: TenorConfig["id"];
  /// Every ladder rung processed this call, in rung order (1..ladderSize).
  rungs: RungResult[];
  /// The rung persisted into the manifest for this (market, tenor) pair —
  /// the latest-expiry rung left enabled after this call. Falls back to the
  /// unchanged prior manifest entry when this call left nothing enabled for
  /// this pair (should not happen in practice past the very first run — see
  /// the ladder-sizing comment above `TENORS`), and is `undefined` only when
  /// there was never a prior entry either.
  seededSeries: SeededSeries | undefined;
}

export interface EnsureSeededSeriesResult {
  /// One result per (market, tenor) pair, in `markets x tenors` order.
  results: MarketTenorResult[];
  /// True when this call actually sent a deposit (pool-level, at most once
  /// regardless of how many rungs were seeded).
  deposited: boolean;
  totalAssetsBefore: bigint;
  totalAssetsAfter: bigint;
  /// Ready-to-persist manifest array — the defined `seededSeries` from every
  /// result, in order. In dry-run these describe what WOULD have been
  /// written; the caller should not write them.
  seededSeries: SeededSeries[];
  pool: SeededPool;
  dryRun: boolean;
}

/// Creates (or reuses) every configured (market, tenor) pair's ladder of
/// series, tops the pool up to the target liquidity level once, and
/// authorizes whatever rungs need it — the multi-tenor, laddered
/// generalization of what `npm run bootstrap:monad` used to do for a single
/// series per market, minus manifest writing.
///
/// Idempotent: every step is skipped when the chain already satisfies it —
/// re-running with an unchanged `now` (or one that hasn't crossed a tenor's
/// own grid boundary — see `tenorLadderBase`) reuses every existing rung and
/// sends nothing.
///
/// Authorization safety: `vault.authorizeSeries` now (contracts/TendPoolVault.sol)
/// only requires a flat pool (`openPositions == 0 && lockedCollateral == 0`)
/// for RE-authorizing a seriesId that already has a `seriesAuth` entry —
/// enabling a genuinely new one is always allowed, open positions or not
/// (see the `@dev` comment on `authorizeSeries` for the full safety
/// argument). This function reads the pool's obligations ONCE up front and
/// uses that single snapshot for every rung: brand-new rungs (the common
/// case — most of a ladder, on almost every run) are authorized regardless;
/// a rung that needs RE-authorization while the pool isn't flat is skipped
/// (logged, not thrown) and left for a later, flatter run, so one stuck
/// series can never block the rest of the ladder — for any market, any
/// tenor — the way it used to before the guard was relaxed.
export async function ensureSeededSeries(
  params: EnsureSeededSeriesParams,
): Promise<EnsureSeededSeriesResult> {
  const { publicClient, factory, vault, mockUSDC, deployer, settlementToken } = params;
  const markets = params.markets ?? MARKETS;
  const tenors = params.tenors ?? TENORS;
  const dryRun = params.dryRun ?? false;
  const log = params.log ?? ((line: string) => console.log(line));
  const dryPrefix = dryRun ? "[dry-run] " : "";

  if (markets.length === 0) {
    throw new Error("ensureSeededSeries was called with an empty market list — nothing to seed.");
  }
  if (tenors.length === 0) {
    throw new Error("ensureSeededSeries was called with an empty tenor list — nothing to seed.");
  }

  const priorByKey = new Map((params.priorSeededSeries ?? []).map((entry) => [`${entry.symbol}:${entry.tenorId}`, entry]));

  // -------------------------------------------------------------------------
  // 1. Create (or reuse) every configured market's ladder, for every tenor.
  // -------------------------------------------------------------------------
  const nowSec = params.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));

  interface RungState {
    market: MarketConfig;
    tenor: TenorConfig;
    rung: number;
    seriesId: Hex;
    expiry: bigint;
    createTxHash: string | null;
    createdSeries: boolean;
    isTradable: boolean;
    skipReason?: string;
  }

  const rungStates: RungState[] = [];

  const pairPlans = markets.flatMap((market) =>
    tenors.map((tenor) => ({
      pair: `${market.symbol}/${tenor.id}`,
      rungs: Array.from({ length: tenor.ladderSize }, (_, index) => ({ market, tenor, rung: index + 1 })),
    })),
  );

  const priorExpiryByPair = new Map(
    (params.priorSeededSeries ?? []).map((entry) => [`${entry.symbol}/${entry.tenorId}`, BigInt(entry.expiry)]),
  );
  // Missing and oldest recorded coverage goes first. Once a constrained run
  // refreshes one pair, its newer manifest expiry moves it behind deferred
  // pairs on the next run, avoiding schedule-dependent starvation.
  const prioritizedPairPlans = leastCoveredPairs(pairPlans, priorExpiryByPair);
  for (const { rung: plan } of fairRungOrder(prioritizedPairPlans)) {
      const { market, tenor, rung } = plan;
      const base = tenorLadderBase(nowSec, tenor.leadSeconds);
      const symbolBytes32 = stringToHex(tenorQualifiedSymbol(market.symbol, tenor.id), { size: 32 });
        const expiry = base + BigInt(rung) * tenor.leadSeconds;
        const seriesParams = [
          market.pythFeedId,
          settlementToken,
          expiry,
          OBSERVATION_WINDOW_SECONDS,
          SETTLEMENT_GRACE_SECONDS,
          MAX_CONFIDENCE_BPS,
          symbolBytes32,
        ] as const;

        const seriesId = (await factory.read.deriveSeriesId([seriesParams as unknown as never])) as Hex;

        const priorEntry = priorByKey.get(`${market.symbol}:${tenor.id}`);
        let createTxHash: string | null = priorEntry?.seriesId === seriesId ? priorEntry.createTxHash : null;
        let createdSeries = false;
        let skipReason: string | undefined;
        const alreadyExists = (await factory.read.seriesExists([seriesId])) as boolean;
        const desiredLastTradeAt = expiry - tenor.lastTradeBufferSeconds;
        const cannotAuthorize =
          desiredLastTradeAt < nowSec + MIN_TRADE_LEAD_SECONDS + AUTHORIZE_LATENCY_MARGIN_SECONDS ||
          desiredLastTradeAt >= expiry;
        if (alreadyExists) {
          log(`  rung ${rung}/${tenor.ladderSize} expiry=${expiry}: exists — reusing (${seriesId}).`);
        } else if (cannotAuthorize) {
          skipReason =
            `creation deferred because lastTradeAt (${desiredLastTradeAt}) is already too close to authorization bounds ` +
            `at planning time (${nowSec}); preserving gas for the next fillable rung`;
          log(`  rung ${rung}/${tenor.ladderSize} expiry=${expiry}: DEFERRED — ${skipReason}.`);
        } else if (dryRun) {
          log(`  ${dryPrefix}rung ${rung}/${tenor.ladderSize} expiry=${expiry}: would create (${seriesId}).`);
        } else {
          // Claim create + authorize together. Once creation starts, enough
          // bounded budget remains to make this rung fillable.
          const createGas = await factory.estimateGas.createSeries([seriesParams as unknown as never]);
          const spend = await params.authorizeSpend?.(
            "seedRung",
            `${market.symbol}/${tenor.id} rung ${rung}`,
            createGas,
          );
          if (spend && !spend.allowed) {
            skipReason = spend.reason ?? "native gas budget denied createSeries";
            log(`  rung ${rung}/${tenor.ladderSize} expiry=${expiry}: DEFERRED — ${skipReason}.`);
          } else {
          try {
            createTxHash = await factory.write.createSeries([seriesParams as unknown as never], {
              gas: createGas,
              gasPrice: spend?.gasPriceWei,
            });
          } catch (error) {
            throw new Error(
              `createSeries reverted for ${market.symbol}/${tenor.id} rung ${rung}/${tenor.ladderSize}: ${explainRevert(error)}`,
            );
          }
          await publicClient.waitForTransactionReceipt({ hash: createTxHash as Hex });
          createdSeries = true;
          log(`  rung ${rung}/${tenor.ladderSize} expiry=${expiry}: created (${seriesId})`);
          log(`    createSeries tx: ${createTxHash}`);
          log(`    explorer:        ${explorerTx(createTxHash, publicClient.chain?.id)}`);
          }
        }

        // In dry-run the series may not exist yet, so these read-backs are
        // informational rather than assertions.
        const seriesExistsAfter = (await factory.read.seriesExists([seriesId])) as boolean;
        const isTradable = (await factory.read.isTradable([seriesId])) as boolean;
        if (!dryRun && skipReason === undefined && (!seriesExistsAfter || !isTradable)) {
          throw new Error(
            `Series ${seriesId} (${market.symbol}/${tenor.id} rung ${rung}/${tenor.ladderSize}) is not both ` +
              `existing and tradable after creation — refusing to continue (factory may be paused, or the ` +
              `series was disabled).`,
          );
        }

        rungStates.push({ market, tenor, rung, seriesId, expiry, createTxHash, createdSeries, isTradable, skipReason });
  }

  // -------------------------------------------------------------------------
  // 2. Approve + deposit pool liquidity, up to the target level. Pool-level —
  //    done once here, regardless of how many rungs were just created.
  // -------------------------------------------------------------------------
  const priorPool = params.priorPool;
  const totalAssetsBefore = (await vault.read.totalAssets()) as bigint;
  const totalSharesBefore = (await vault.read.totalShares()) as bigint;
  log(`\nPool totalAssets before: ${totalAssetsBefore} raw units (${formatMUSDC(totalAssetsBefore)} mUSDC)`);

  let approveTxHash: string | null = priorPool?.approveTxHash ?? null;
  let depositTxHash: string | null = priorPool?.depositTxHash ?? null;
  let deposited = false;

  if (totalAssetsBefore >= POOL_DEPOSIT_TARGET_RAW) {
    log(`  Pool already holds >= target (${formatMUSDC(POOL_DEPOSIT_TARGET_RAW)} mUSDC) — skipping deposit.`);
  } else {
    const shortfall = POOL_DEPOSIT_TARGET_RAW - totalAssetsBefore;
    log(`  Depositing shortfall: ${shortfall} raw units (${formatMUSDC(shortfall)} mUSDC).`);

    const deployerBalance = (await mockUSDC.read.balanceOf([deployer])) as bigint;
    if (deployerBalance < shortfall) {
      throw new Error(
        `Deployer mUSDC balance (${deployerBalance}) is less than the required deposit (${shortfall}). ` +
          `Mint more mUSDC to ${deployer} first.`,
      );
    }

    const currentAllowance = (await mockUSDC.read.allowance([deployer, vault.address])) as bigint;
    let approvalReady = currentAllowance >= shortfall;
    if (currentAllowance >= shortfall) {
      log(`  Existing allowance (${currentAllowance}) already covers the deposit — skipping approve.`);
    } else if (dryRun) {
      log(`${dryPrefix}  would call mUSDC.approve(${vault.address}, ${shortfall}).`);
    } else {
      const approveGas = await mockUSDC.estimateGas.approve([vault.address, shortfall]);
      const spend = await params.authorizeSpend?.("approve", "pool liquidity approval", approveGas);
      if (spend && !spend.allowed) {
        log(`  Approval DEFERRED — ${spend.reason ?? "native gas budget denied approval"}.`);
      } else {
        try {
          approveTxHash = await mockUSDC.write.approve([vault.address, shortfall], {
            gas: approveGas,
            gasPrice: spend?.gasPriceWei,
          });
        } catch (error) {
          throw new Error(`mUSDC.approve reverted: ${explainRevert(error)}`);
        }
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash as Hex });
        approvalReady = true;
        log(`  approve tx: ${approveTxHash}`);
        log(`  explorer:   ${explorerTx(approveTxHash, publicClient.chain?.id)}`);
      }
    }

    if (!dryRun && !approvalReady) {
      log(`  Deposit DEFERRED because the required approval was not affordable.`);
    } else if (dryRun) {
      log(`${dryPrefix}  would call vault.deposit(${shortfall}, <minSharesOut>, <deadline>).`);
    } else {
      const minSharesOut = (await vault.read.calculateDepositShares([
        shortfall,
        totalSharesBefore,
        totalAssetsBefore,
      ])) as bigint;
      const depositDeadline = BigInt(Math.floor(Date.now() / 1000) + DEPOSIT_DEADLINE_BUFFER_SECONDS);
      const depositGas = await vault.estimateGas.deposit([shortfall, minSharesOut, depositDeadline]);
      const spend = await params.authorizeSpend?.("deposit", "pool liquidity deposit", depositGas);
      if (spend && !spend.allowed) {
        log(`  Deposit DEFERRED — ${spend.reason ?? "native gas budget denied deposit"}.`);
      } else {
        try {
          depositTxHash = await vault.write.deposit([shortfall, minSharesOut, depositDeadline], {
            gas: depositGas,
            gasPrice: spend?.gasPriceWei,
          });
        } catch (error) {
          throw new Error(`vault.deposit reverted: ${explainRevert(error)}`);
        }
        await publicClient.waitForTransactionReceipt({ hash: depositTxHash as Hex });
        deposited = true;
        log(`  deposit tx: ${depositTxHash}`);
        log(`  explorer:   ${explorerTx(depositTxHash, publicClient.chain?.id)}`);
      }
    }
  }

  const totalAssetsAfter = (await vault.read.totalAssets()) as bigint;
  log(`Pool totalAssets after:  ${totalAssetsAfter} raw units (${formatMUSDC(totalAssetsAfter)} mUSDC)`);

  // -------------------------------------------------------------------------
  // 3. Authorize every rung that needs it.
  //
  // The pool's obligations are read ONCE here and reused for every rung
  // below — they don't change mid-script (nothing here triggers a fill) and
  // a single snapshot is all the relaxed guard needs: it only matters for
  // deciding whether a RE-authorization may proceed, and that decision is
  // supposed to be consistent across the whole call, not re-checked (and
  // potentially flip-flopping) per rung.
  // -------------------------------------------------------------------------
  const openPositionsSnapshot = (await vault.read.openPositions()) as bigint;
  const lockedCollateralSnapshot = (await vault.read.lockedCollateral()) as bigint;
  const poolFlat = openPositionsSnapshot === 0n && lockedCollateralSnapshot === 0n;
  log(
    `\nPool obligations snapshot for authorization: openPositions=${openPositionsSnapshot}, ` +
      `lockedCollateral=${lockedCollateralSnapshot} (${poolFlat ? "flat" : "NOT flat"}).`,
  );
  if (!poolFlat) {
    log(
      `  Pool is not flat — brand-new-series authorizations still proceed (TendPoolVault's relaxed guard), ` +
        `but re-authorizing any EXISTING seriesAuth entry will be skipped this run and left for a later, ` +
        `flatter run.`,
    );
  }

  const nowIso = new Date().toISOString();

  interface RungResultState extends RungState {
    authorizedSeries: boolean;
    enabled: boolean;
    lastTradeAt: bigint;
    skipReason: string | undefined;
    authorizeTxHash: string | null;
  }

  const rungResults: RungResultState[] = [];

  for (const state of rungStates) {
    const { market, tenor, rung, seriesId, expiry } = state;
    const label = `${market.symbol}/${tenor.id} rung ${rung}/${tenor.ladderSize}`;
    const desiredLastTradeAt = expiry - tenor.lastTradeBufferSeconds;

    // The ladder GRID stays anchored to the run's single `nowSec` (that is
    // what makes repeated runs compute identical rungs and reuse them for
    // free). The BOUNDS CHECK below must not: a full ladder sends dozens of
    // transactions, so by the time a later pair's nearest rung is reached,
    // minutes have passed and a rung that cleared MIN_TRADE_LEAD at the top
    // of the run no longer does. Checking it against the stale `nowSec` sent
    // exactly that doomed authorization and reverted the whole phase with
    // InvalidLastTradeCutoff, stranding every pair after it. A caller that
    // pins `nowSeconds` (tests) keeps its fixed clock.
    const guardNowSec = params.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));

    const [existingEnabled, existingLastTradeAt] = (await vault.read.seriesAuth([seriesId])) as [boolean, bigint];
    // Mirrors TendPoolVault.authorizeSeries' own `isNewAuthorization` check
    // exactly: an entry that has never been enabled and never been given a
    // lastTradeAt is untouched, so enabling it is allowed regardless of pool
    // state.
    const isNewAuthorization = !existingEnabled && existingLastTradeAt === 0n;
    const authorizationStillValid = existingEnabled && existingLastTradeAt > guardNowSec && existingLastTradeAt < expiry;

    const priorEntry = priorByKey.get(`${market.symbol}:${tenor.id}`);
    let authorizeTxHash: string | null = priorEntry?.seriesId === seriesId ? (priorEntry?.authorizeTxHash ?? null) : null;
    let authorizedSeries = false;
    let skipReason: string | undefined = state.skipReason;
    let finalEnabled = existingEnabled;
    let finalLastTradeAt = existingLastTradeAt;

    if (skipReason !== undefined) {
      log(`  ${label}: authorization DEFERRED — ${skipReason}.`);
    } else if (authorizationStillValid) {
      log(`  ${label}: already authorized (lastTradeAt=${existingLastTradeAt}) — skipping.`);
    } else if (desiredLastTradeAt < guardNowSec + MIN_TRADE_LEAD_SECONDS + AUTHORIZE_LATENCY_MARGIN_SECONDS || desiredLastTradeAt >= expiry) {
      // Structural edge case documented above `TENORS` — only the nearest
      // rung(s) of the shortest tenor can ever hit this. Never a hard
      // failure: the series itself was already created above
      // (permissionless, harmless either way); only THIS rung's
      // authorization is skipped. The next rung already covers the gap.
      skipReason =
        `computed lastTradeAt (${desiredLastTradeAt}) violates MIN_TRADE_LEAD/expiry bounds relative to now ` +
        `(${guardNowSec}) — too close to this rung's own expiry (${expiry}) for both the buffer and ` +
        `TendPoolVault.MIN_TRADE_LEAD.`;
      log(`  ${label}: SKIPPED — ${skipReason}`);
    } else if (!isNewAuthorization && !poolFlat) {
      skipReason =
        `re-authorization required (existing entry enabled=${existingEnabled}, lastTradeAt=${existingLastTradeAt}) ` +
        `but the pool is not flat (openPositions=${openPositionsSnapshot}, lockedCollateral=${lockedCollateralSnapshot})`;
      log(`  ${label}: SKIPPED — ${skipReason} — deferring to a later run.`);
    } else if (dryRun) {
      log(
        `  ${dryPrefix}${label}: would authorize (lastTradeAt=${desiredLastTradeAt})` +
          `${isNewAuthorization ? " [new — proceeds regardless of open positions]" : ""}.`,
      );
      finalEnabled = true;
      finalLastTradeAt = desiredLastTradeAt;
    } else {
      const authorizeGas = await vault.estimateGas.authorizeSeries([seriesId, true, desiredLastTradeAt]);
      const spend = state.createdSeries
        ? await params.authorizeSpend?.(
            "completeSeedRung",
            `${market.symbol}/${tenor.id} rung ${rung}`,
            authorizeGas,
          )
        : await params.authorizeSpend?.("authorizeSeries", label, authorizeGas);
      if (spend && !spend.allowed) {
        skipReason = spend.reason ?? "native gas budget denied authorizeSeries";
        log(`  ${label}: DEFERRED — ${skipReason}.`);
        rungResults.push({
          ...state,
          authorizedSeries,
          enabled: finalEnabled,
          lastTradeAt: finalLastTradeAt,
          skipReason,
          authorizeTxHash,
        });
        continue;
      }
      log(
        `  ${label}: authorizing (lastTradeAt=${desiredLastTradeAt})` +
          `${isNewAuthorization ? " [new — proceeds regardless of open positions]" : ""}.`,
      );
      try {
        authorizeTxHash = await vault.write.authorizeSeries([seriesId, true, desiredLastTradeAt], {
          gas: authorizeGas,
          gasPrice: spend?.gasPriceWei,
        });
      } catch (error) {
        throw new Error(`vault.authorizeSeries reverted for ${label}: ${explainRevert(error)}`);
      }
      await publicClient.waitForTransactionReceipt({ hash: authorizeTxHash as Hex });
      authorizedSeries = true;
      const [enabledAfter, lastTradeAtAfter] = (await vault.read.seriesAuth([seriesId])) as [boolean, bigint];
      if (!enabledAfter) {
        throw new Error(`Series ${seriesId} (${label}) is not authorized on the pool after authorizeSeries — refusing to continue.`);
      }
      finalEnabled = enabledAfter;
      finalLastTradeAt = lastTradeAtAfter;
      log(`    authorizeSeries tx: ${authorizeTxHash}`);
      log(`    explorer:           ${explorerTx(authorizeTxHash, publicClient.chain?.id)}`);
    }

    rungResults.push({
      ...state,
      authorizedSeries,
      enabled: finalEnabled,
      lastTradeAt: finalLastTradeAt,
      skipReason,
      authorizeTxHash,
    });
  }

  // -------------------------------------------------------------------------
  // 4. Assemble one result per (market, tenor) — the manifest entry is the
  //    latest-expiry rung this call left enabled, mirroring the "prefer the
  //    latest expiry within a tenor" rule the SPA's useLiveSeries.ts applies
  //    on-chain (see that file).
  // -------------------------------------------------------------------------
  const results: MarketTenorResult[] = [];
  const flatSeededSeries: SeededSeries[] = [];

  for (const market of markets) {
    for (const tenor of tenors) {
      const rungsForPair = rungResults.filter((r) => r.market.symbol === market.symbol && r.tenor.id === tenor.id);

      let chosen: RungResultState | undefined;
      for (const r of rungsForPair) {
        if (r.enabled && (!chosen || r.expiry > chosen.expiry)) chosen = r;
      }

      const priorEntry = priorByKey.get(`${market.symbol}:${tenor.id}`);
      const seededSeriesEntry: SeededSeries | undefined = chosen
        ? {
            symbol: market.symbol,
            pythFeedId: market.pythFeedId,
            tenorId: tenor.id,
            seriesId: chosen.seriesId,
            settlementToken,
            expiry: chosen.expiry.toString(),
            observationWindow: OBSERVATION_WINDOW_SECONDS,
            settlementGrace: SETTLEMENT_GRACE_SECONDS,
            maxConfidenceBps: MAX_CONFIDENCE_BPS,
            lastTradeAt: chosen.lastTradeAt.toString(),
            createTxHash: chosen.createTxHash,
            authorizeTxHash: chosen.authorizeTxHash,
            seededAt: nowIso,
          }
        : priorEntry;

      results.push({
        symbol: market.symbol,
        pythFeedId: market.pythFeedId,
        tenorId: tenor.id,
        rungs: rungsForPair.map((r) => ({
          rung: r.rung,
          seriesId: r.seriesId,
          expiry: r.expiry,
          createdSeries: r.createdSeries,
          isTradable: r.isTradable,
          authorizedSeries: r.authorizedSeries,
          enabled: r.enabled,
          lastTradeAt: r.lastTradeAt,
          skipReason: r.skipReason,
          createTxHash: r.createTxHash,
          authorizeTxHash: r.authorizeTxHash,
        })),
        seededSeries: seededSeriesEntry,
      });
      if (seededSeriesEntry) flatSeededSeries.push(seededSeriesEntry);
    }
  }

  return {
    results,
    deposited,
    totalAssetsBefore,
    totalAssetsAfter,
    seededSeries: flatSeededSeries,
    pool: {
      depositTargetRaw: POOL_DEPOSIT_TARGET_RAW.toString(),
      totalAssetsBeforeRaw: totalAssetsBefore.toString(),
      totalAssetsAfterRaw: totalAssetsAfter.toString(),
      approveTxHash,
      depositTxHash,
      seededAt: nowIso,
    },
    dryRun,
  };
}
