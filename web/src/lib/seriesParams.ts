import { type Address, type Hex, stringToHex } from "viem";

// ---------------------------------------------------------------------------
// Series parameter constants — MIRRORED BY HAND from
// scripts/lib/e2e/seed-series.ts, the seeder's single source of truth. web/
// is a separate npm package from the Hardhat project at the worktree root
// (own package.json, own tsconfig, own dependency graph — see chain.ts for
// the identical situation with the Monad chain definition), and the seeder
// module itself imports "@nomicfoundation/hardhat-viem/types" and does Node
// fs I/O, so it cannot be imported into this browser bundle even if the
// package boundary were crossed.
//
// These values MUST stay byte-identical to their counterparts in
// scripts/lib/e2e/seed-series.ts — useLiveSeries.ts uses them to reconstruct
// the exact CreateSeriesParams the seeder used, so it can re-derive the
// seeder's deterministic seriesId (via the factory's pure `deriveSeriesId`
// view function) without ever trusting the build-time manifest for "which
// series is live right now".
//
// >>> If you change ANY value below, change scripts/lib/e2e/seed-series.ts's
// >>> matching constant too (or vice versa). A mismatch here makes
// >>> useLiveSeries.ts derive the WRONG seriesId for every candidate, so it
// >>> would silently fall back to the (possibly stale) manifest series on
// >>> every load — defeating the entire point of this module.
export const EXPIRY_ROUND_SECONDS = 15n * 60n;
export const OBSERVATION_WINDOW_SECONDS = 60;
export const SETTLEMENT_GRACE_SECONDS = 60 * 60;
export const MAX_CONFIDENCE_BPS = 500;

export type TenorId = "15m" | "1h" | "12h";

export interface TenorConfig {
  id: TenorId;
  label: string;
  leadSeconds: bigint;
  /** How many consecutive ladder rungs the seeder maintains for this tenor —
   * see scripts/lib/e2e/seed-series.ts's TENORS comment for the measured
   * keeper cadence this sizes against. Not load-bearing for correctness
   * here (useLiveSeries.ts's on-chain probe finds a rung regardless of how
   * many exist), only for sizing how wide that probe searches. */
  ladderSize: number;
}

// MUST equal TENORS in scripts/lib/e2e/seed-series.ts (id, leadSeconds and
// ladderSize — `lastTradeBufferSeconds` is server-only authorization logic,
// not needed here). Traders pick one of these three per trade (see
// TenorSelector.tsx); each has its own ladder of series so a short tenor
// stays fillable between the keeper's unpredictable runs (2026-08 and later
// history: raised from a single 2h tenor to 12h, then split into three —
// see git log and seed-series.ts for the full story). If this ever
// disagrees with seed-series.ts, useLiveSeries derives the wrong seriesId
// for every candidate in the mismatched tenor and silently falls back to
// the possibly-stale manifest — that tenor shows no tradable market with no
// error anywhere.
export const TENORS: readonly TenorConfig[] = [
  { id: "15m", label: "15 minutes", leadSeconds: 15n * 60n, ladderSize: 20 },
  { id: "1h", label: "1 hour", leadSeconds: 60n * 60n, ladderSize: 5 },
  { id: "12h", label: "12 hours", leadSeconds: 12n * 60n * 60n, ladderSize: 1 },
];

/**
 * TendSeriesFactory.CreateSeriesParams, field-for-field — the exact shape
 * `deriveSeriesId` / `createSeries` expect (see abis/TendSeriesFactory.ts).
 * Passed as a named object (not a positional tuple/array): viem's ABI
 * encoder accepts either for a named-component struct, and the object form
 * type-checks cleanly against wagmi's inferred ABI types without a cast.
 */
export interface CreateSeriesParams {
  pythFeedId: Hex;
  settlementToken: Address;
  expiry: bigint;
  observationWindow: number;
  settlementGrace: number;
  maxConfidenceBps: number;
  symbol: Hex;
}

/**
 * The seeder's 15-minute expiry-bucket boundary for `nowSec`, offset by
 * `bucketOffset` buckets — positive looks further into the past, negative
 * further into the future. Mirrors
 * `bucketStart = ceil(now / EXPIRY_ROUND_SECONDS) * EXPIRY_ROUND_SECONDS`
 * from scripts/lib/e2e/seed-series.ts, minus `bucketOffset` rounds.
 *
 * This stays a single shared 900-second grid across every tenor — it does
 * NOT need to match seed-series.ts's per-tenor `tenorLadderBase` anchoring
 * (which exists purely for the seeder's own gas efficiency across
 * unpredictable keeper runs). 900 seconds divides every tenor's
 * `leadSeconds` (900, 3600, 43200), so any expiry the seeder could ever
 * have produced — on ANY tenor's own grid — is also reachable as
 * `bucketStartFor(nowSec, someOffset) + tenor.leadSeconds` for a wide
 * enough `someOffset` range. useLiveSeries.ts just needs to search that
 * range wide enough per tenor (see its PAST_BUCKETS/FUTURE_BUCKETS).
 */
export function bucketStartFor(nowSec: bigint, bucketOffset: bigint): bigint {
  const currentBucketStart = ((nowSec + EXPIRY_ROUND_SECONDS - 1n) / EXPIRY_ROUND_SECONDS) * EXPIRY_ROUND_SECONDS;
  return currentBucketStart - bucketOffset * EXPIRY_ROUND_SECONDS;
}

/**
 * The seeder's deterministic expiry for the bucket `bucketOffset` rounds away
 * from `nowSec`'s own bucket, for the given tenor's lead time:
 * `bucketStartFor(...) + tenor.leadSeconds`. A series the seeder created for
 * this bucket/tenor — if one exists on-chain — has exactly this expiry by
 * construction (the seriesId is a hash of the params including expiry, so a
 * matching derived id confirms the value).
 */
export function expiryForBucket(nowSec: bigint, bucketOffset: bigint, leadSeconds: bigint): bigint {
  return bucketStartFor(nowSec, bucketOffset) + leadSeconds;
}

/**
 * MUST match scripts/lib/e2e/seed-series.ts's `tenorQualifiedSymbol` exactly
 * — byte-identical, not just "close". This is not cosmetic: `deriveSeriesId`
 * hashes the full CreateSeriesParams tuple including `symbol`, and every
 * expiry timestamp any tenor's ladder can ever produce is a multiple of 900
 * seconds (900 divides every tenor's own leadSeconds), so the 15-minute
 * tenor's candidate search window structurally OVERLAPS every other tenor's
 * — a real 12h-tenor series with a few hours left before expiry sits
 * squarely inside the 15-minute tenor's own forward search range (see
 * useLiveSeries.ts). Without qualifying the symbol, useLiveSeries would
 * "find" and mislabel that 12h series as a 15-minute-tenor candidate —
 * exactly the "trader thinks they bought 15m, actually got 12h" failure
 * this whole feature exists to prevent. Verified against the live testnet
 * deployment: an unqualified symbol let the 15-minute tenor's probe
 * cross-match a real, currently-live series created under the pre-ladder
 * single-tenor scheme.
 */
export function tenorQualifiedSymbol(marketSymbol: string, tenorId: TenorId): string {
  return `${marketSymbol}-${tenorId.toUpperCase()}`;
}

/**
 * Builds the CreateSeriesParams the seeder would have used for `market` at
 * `expiry` — byte-identical to scripts/lib/e2e/seed-series.ts's own
 * `seriesParams` construction, so `factory.deriveSeriesId(...)` on the result
 * reproduces the exact seriesId the seeder derived (and, if it actually ran,
 * created) for that market/tenor/expiry combination. `market.symbol` here
 * MUST already be tenor-qualified (see `tenorQualifiedSymbol`) — this
 * function hashes whatever symbol it's given verbatim, so the caller
 * (useLiveSeries.ts) is responsible for qualifying it before calling this.
 */
export function createSeriesParamsFor(
  market: { symbol: string; pythFeedId: Hex },
  settlementToken: Address,
  expiry: bigint,
): CreateSeriesParams {
  return {
    pythFeedId: market.pythFeedId,
    settlementToken,
    expiry,
    observationWindow: OBSERVATION_WINDOW_SECONDS,
    settlementGrace: SETTLEMENT_GRACE_SECONDS,
    maxConfidenceBps: MAX_CONFIDENCE_BPS,
    symbol: stringToHex(market.symbol, { size: 32 }),
  };
}
