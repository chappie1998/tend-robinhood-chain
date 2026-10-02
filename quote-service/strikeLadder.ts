// Binary expiry-only strike selection shared by quote previews and signed quotes.
// Quotes keep the existing ABI but set width to one raw price tick. The deployed
// vault then pays either maxPayout or zero at expiry.
import { MAKER_EDGE_BPS, probabilityItm, type SpreadDirection } from "./pricing.js";

export type TileIndex = 0 | 1 | 2;
export const DEFAULT_TILE: TileIndex = 1;
export function isTileIndex(value: unknown): value is TileIndex {
  return value === 0 || value === 1 || value === 2;
}

export interface PayoutTier { index: TileIndex; numerator: bigint; denominator: bigint; multiple: number }
/** Fixed winning payouts. These exact raw-unit ratios are never model output. */
export const PAYOUT_TIERS: readonly PayoutTier[] = [
  { index: 0, numerator: 3n, denominator: 2n, multiple: 1.5 },
  { index: 1, numerator: 2n, denominator: 1n, multiple: 2 },
  { index: 2, numerator: 3n, denominator: 1n, multiple: 3 },
] as const;

export interface BinaryTerms { premium: bigint; maxPayout: bigint; clamped: boolean }
/**
 * Makes the premium and escrow exact for a selected tier. Capacity reduces
 * charged premium; it never changes the ratio or charges above the offer.
 */
export function binaryTerms(offeredPremium: bigint, payoutCapacity: bigint, tile: TileIndex): BinaryTerms {
  if (offeredPremium <= 0n) throw new Error("Binary payout needs a positive offered premium.");
  if (payoutCapacity <= 0n) throw new Error("Binary payout needs positive pool capacity.");
  const tier = PAYOUT_TIERS[tile];
  if (tier === undefined) throw new Error(`Unknown payout tier ${tile}.`);
  let premium = offeredPremium;
  const capacityPremium = (payoutCapacity * tier.denominator) / tier.numerator;
  if (premium > capacityPremium) premium = capacityPremium;
  premium -= premium % tier.denominator; // 1.5x requires an even premium.
  if (premium <= 0n) throw new Error("Pool capacity cannot support one exact payout tier.");
  const maxPayout = (premium * tier.numerator) / tier.denominator;
  if (maxPayout <= 0n || maxPayout > payoutCapacity) throw new Error("Invalid binary payout capacity.");
  return { premium, maxPayout, clamped: premium !== offeredPremium };
}

export interface LadderParams {
  direction: SpreadDirection;
  spot: number;
  volAnnual: number;
  timeYears: number;
  makerEdgeBps?: number;
  /** Raw integer price scale used by the deployed vault (normally 1e8). */
  priceScale?: number;
}

export interface LadderTile {
  index: TileIndex;
  multiple: number;
  strike: number;
  /** Exact raw strike sent in the existing PoolQuote ABI. */
  strikeRaw: bigint;
  strikeOffsetFraction: number;
  /** Risk-neutral chance that this binary ticket pays at expiry. */
  probabilityItm: number;
  /** A binary ticket profits exactly when it pays. */
  probabilityProfit: number;
  targetProbability: number;
  /** Edge after conservative price-tick rounding. */
  makerEdgeBps: number;
}

function validProbability(value: number): boolean { return Number.isFinite(value) && value > 0 && value <= 1; }
function assertParams(p: LadderParams): void {
  if (!(p.spot > 0) || !Number.isFinite(p.spot)) throw new Error("strikeLadder needs a finite positive spot.");
  if (!(p.volAnnual > 0) || !Number.isFinite(p.volAnnual)) throw new Error("strikeLadder needs positive volatility.");
  if (!(p.timeYears > 0) || !Number.isFinite(p.timeYears)) throw new Error("strikeLadder needs positive time to expiry.");
  const edge = p.makerEdgeBps ?? MAKER_EDGE_BPS;
  if (!(edge >= 0) || !Number.isFinite(edge)) throw new Error("strikeLadder needs a valid maker edge.");
  const scale = p.priceScale ?? 100_000_000;
  if (!Number.isSafeInteger(scale) || scale <= 0 || !Number.isSafeInteger(Math.round(p.spot * scale))) {
    throw new Error("strikeLadder needs safe raw price precision.");
  }
}

/**
 * An exact raw tick small enough to preserve the probability distinction
 * between tiers. A fixed 0.1%-of-spot tick collapses short, low-volatility
 * strikes into one price and turns a 2x/3x quote into a near-zero-probability
 * ticket. Keeping rounding under 1/64 of the modeled one-sigma move bounds
 * that error while remaining displayable and on-chain representable.
 */
function rawStrikeTick(p: LadderParams, priceScale: number): bigint {
  const expectedMove = p.spot * p.volAnnual * Math.sqrt(p.timeYears);
  const displayTick = Math.max(expectedMove / 64, 1 / priceScale);
  const raw = Math.max(1, Math.floor(displayTick * priceScale));
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error("Could not derive a displayable price tick.");
  return BigInt(raw);
}
function probabilityFor(p: LadderParams, strike: number): number {
  return probabilityItm(p.direction, p.spot, strike, p.volAnnual, p.timeYears);
}

/** Solves the monotone binary ITM probability equation before tick rounding. */
function solveStrike(p: LadderParams, target: number): number {
  let low = Number.MIN_VALUE;
  let high = p.spot;
  if (p.direction === "up") {
    while (probabilityFor(p, high) > target && high < Number.MAX_VALUE / 2) high *= 2;
    if (!(probabilityFor(p, low) >= target) || !(probabilityFor(p, high) <= target)) {
      throw new Error("No feasible positive up strike for target probability.");
    }
    for (let i = 0; i < 80; i += 1) { const mid = (low + high) / 2; if (probabilityFor(p, mid) > target) low = mid; else high = mid; }
  } else {
    while (probabilityFor(p, high) < target && high < Number.MAX_VALUE / 2) high *= 2;
    if (!(probabilityFor(p, low) <= target) || !(probabilityFor(p, high) >= target)) {
      throw new Error("No feasible positive down strike for target probability.");
    }
    for (let i = 0; i < 80; i += 1) { const mid = (low + high) / 2; if (probabilityFor(p, mid) < target) low = mid; else high = mid; }
  }
  return (low + high) / 2;
}

function priceTile(p: LadderParams, tier: PayoutTier): LadderTile {
  const edge = p.makerEdgeBps ?? MAKER_EDGE_BPS;
  const targetProbability = 1 / (tier.multiple * (1 + edge / 10_000));
  if (!validProbability(targetProbability)) throw new Error("Invalid binary target probability.");
  const scale = p.priceScale ?? 100_000_000;
  const tick = rawStrikeTick(p, scale);
  const solved = solveStrike(p, targetProbability);
  const raw = BigInt(Math.round(solved * scale));
  let strikeRaw = p.direction === "up" ? ((raw + tick - 1n) / tick) * tick : (raw / tick) * tick;
  if (strikeRaw <= 0n) throw new Error("Conservative down strike rounded to zero.");
  let strike = Number(strikeRaw) / scale;
  let actual = probabilityFor(p, strike);
  // Move one whole tick in the pool's favour if float rounding made it easier.
  for (let i = 0; i < 4 && (!validProbability(actual) || actual > targetProbability + 1e-12); i += 1) {
    strikeRaw += p.direction === "up" ? tick : -tick;
    if (strikeRaw <= 0n) throw new Error("No positive conservative strike for binary quote.");
    strike = Number(strikeRaw) / scale;
    actual = probabilityFor(p, strike);
  }
  if (!validProbability(actual) || actual > targetProbability + 1e-12) {
    throw new Error("Could not round binary strike without underpricing payout.");
  }
  const actualMakerEdgeBps = ((1 / (tier.multiple * actual)) - 1) * 10_000;
  if (!Number.isFinite(actualMakerEdgeBps) || actualMakerEdgeBps < edge - 1e-7) {
    throw new Error("Invalid maker edge after strike rounding.");
  }
  return { index: tier.index, multiple: tier.multiple, strike, strikeRaw,
    strikeOffsetFraction: (strike - p.spot) / p.spot, probabilityItm: actual,
    probabilityProfit: actual, targetProbability, makerEdgeBps: actualMakerEdgeBps };
}

/** Produces the three fixed-payout tiers using risk-neutral, conservative strikes. */
export function strikeLadder(p: LadderParams): LadderTile[] {
  assertParams(p);
  return PAYOUT_TIERS.map((tier) => priceTile(p, tier));
}
