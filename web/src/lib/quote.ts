import type { Address, Hex } from "viem";

// The PoolQuote struct exactly as TendPoolVault.fillPoolQuote expects it. The
// field order here is load-bearing: poolQuoteTuple() below serialises these
// nine fields positionally, and that order MUST match the Solidity struct
// (uint256 nonce, uint8 direction, uint128 strike, uint128 width, uint128
// premium, uint128 maxPayout, uint64 quoteExpiry, bytes32 seriesId, address
// buyer). Mirrors scripts/lib/e2e/quote.ts's poolQuoteTuple — the SPA can't
// import from scripts/, so it's re-declared here.
export interface PoolQuote {
  nonce: bigint;
  direction: number;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  quoteExpiry: bigint;
  seriesId: Hex;
  buyer: Address;
}

/**
 * Positional tuple matching the Solidity PoolQuote struct's field order
 * exactly, for the ABI call `fillPoolQuote(quote, signature)`. Numeric fields
 * stay bigint; the tuple is passed straight to wagmi/viem as the first arg.
 */
export function poolQuoteTuple(q: PoolQuote) {
  return [
    q.nonce,
    q.direction,
    q.strike,
    q.width,
    q.premium,
    q.maxPayout,
    q.quoteExpiry,
    q.seriesId,
    q.buyer,
  ] as const;
}

/** Human-readable terms the quote service returns alongside the signed quote. */
export interface QuoteHumanTerms {
  strike: string;
  width: string;
  premium: string;
  /** Risk-neutral binary fair value, formatted as "<amount> mUSDC". */
  fairValue: string;
  maxPayout: string;
  quoteExpiry: string;
  expiry: string;
}

/** The parsed quote-service response, with numeric fields promoted to bigint. */
export interface SignedQuoteResponse {
  quote: PoolQuote;
  signature: Hex;
  verifyingContract: Address;
  chainId: number;
  /** Exact selected binary winning payout: 1.5, 2, or 3 times charged premium. */
  multiple: number;
  /** Selected fixed payout tier: 0=1.5x, 1=2x, 2=3x. */
  tile: number;
  /** Signed fraction of spot the strike sits at: +0.004 is 0.4% above spot. */
  strikeOffsetFraction: number;
  /** True when parity rounding or pool capacity reduced the charged premium. */
  clamped: boolean;
  feeBps: number;
  /** Annualized realized volatility used to price this quote, e.g. 0.3298 for 32.98%. */
  impliedVolatility: number;
  /** Risk-neutral binary fair value in raw settlement-token units. */
  fairValue: string;
  /** Actual maker edge (bps) after conservative strike rounding. */
  makerEdgeBps: number;
  /** P(finishing in the money) at expiry, in [0, 1]. */
  probabilityItm: number;
  /** For binary tickets this equals P(finishing in the money). */
  probabilityProfit: number;
  /** Time to the series' expiry, in hours, at the moment this quote was priced. */
  timeToExpiryHours: number;
  humanTerms: QuoteHumanTerms;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Quote service returned a malformed ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Quote service response is missing string field \`${field}\`.`);
  }
  return value;
}

/** BigInt() a decimal-string numeric field, failing loudly if it isn't one. */
function requireBigInt(value: unknown, field: string): bigint {
  const raw = requireString(value, field);
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`Quote service field \`${field}\` is not a valid integer: ${raw}`);
  }
}

/** A finite JS `number` field (the pricing fields — multiple, vol, probability, etc. — are inherently floating-point, unlike the bigint quote terms above), failing loudly on anything else (missing, non-number, NaN, ±Infinity). */
function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Quote service response is missing numeric field \`${field}\`.`);
  }
  return value;
}

/**
 * Validates and parses the quote service's JSON response into a
 * SignedQuoteResponse. Every numeric field arrives as a decimal string (so it
 * survives JSON without precision loss) and is promoted to bigint here.
 * Fail-closed: any missing/malformed field throws with a clear message rather
 * than yielding a half-built quote that would only revert on-chain later.
 */
export function parseSignedQuoteResponse(raw: unknown): SignedQuoteResponse {
  const root = asRecord(raw, "quote payload");
  const q = asRecord(root.quote, "quote");
  const humanTermsRaw = asRecord(root.humanTerms, "humanTerms");

  const quote: PoolQuote = {
    nonce: requireBigInt(q.nonce, "quote.nonce"),
    direction: Number(requireBigInt(q.direction, "quote.direction")),
    strike: requireBigInt(q.strike, "quote.strike"),
    width: requireBigInt(q.width, "quote.width"),
    premium: requireBigInt(q.premium, "quote.premium"),
    maxPayout: requireBigInt(q.maxPayout, "quote.maxPayout"),
    quoteExpiry: requireBigInt(q.quoteExpiry, "quote.quoteExpiry"),
    seriesId: requireString(q.seriesId, "quote.seriesId") as Hex,
    buyer: requireString(q.buyer, "quote.buyer") as Address,
  };

  const humanTerms: QuoteHumanTerms = {
    strike: requireString(humanTermsRaw.strike, "humanTerms.strike"),
    width: requireString(humanTermsRaw.width, "humanTerms.width"),
    premium: requireString(humanTermsRaw.premium, "humanTerms.premium"),
    fairValue: requireString(humanTermsRaw.fairValue, "humanTerms.fairValue"),
    maxPayout: requireString(humanTermsRaw.maxPayout, "humanTerms.maxPayout"),
    quoteExpiry: requireString(humanTermsRaw.quoteExpiry, "humanTerms.quoteExpiry"),
    expiry: requireString(humanTermsRaw.expiry, "humanTerms.expiry"),
  };

  return {
    quote,
    signature: requireString(root.signature, "signature") as Hex,
    verifyingContract: requireString(root.verifyingContract, "verifyingContract") as Address,
    chainId: requireFiniteNumber(root.chainId, "chainId"),
    // A float (e.g. 6.23) that reflects the strike actually priced — never round it into a tier.
    multiple: requireFiniteNumber(root.multiple, "multiple"),
    tile: requireFiniteNumber(root.tile, "tile"),
    strikeOffsetFraction: requireFiniteNumber(root.strikeOffsetFraction, "strikeOffsetFraction"),
    // Absent or non-boolean reads as "not clamped": this only ever downgrades
    // a claim the UI makes about capacity, never invents one.
    clamped: root.clamped === true,
    feeBps: requireFiniteNumber(root.feeBps, "feeBps"),
    impliedVolatility: requireFiniteNumber(root.impliedVolatility, "impliedVolatility"),
    fairValue: requireString(root.fairValue, "fairValue"),
    makerEdgeBps: requireFiniteNumber(root.makerEdgeBps, "makerEdgeBps"),
    probabilityItm: requireFiniteNumber(root.probabilityItm, "probabilityItm"),
    probabilityProfit: requireFiniteNumber(root.probabilityProfit, "probabilityProfit"),
    timeToExpiryHours: requireFiniteNumber(root.timeToExpiryHours, "timeToExpiryHours"),
    humanTerms,
  };
}
