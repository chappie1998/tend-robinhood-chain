import type { PoolQuote } from "./quote";

/**
 * The contract's PRICE_SCALE — strike and width are quoted as 1e8-scaled
 * integers (see TendPoolVault.sol). Single source of truth for both this file
 * and TradeTicket, which previously kept its own private copy.
 */
export const PRICE_SCALE = 1e8;

/**
 * The payoff a signed quote describes, worked out from the quote's own
 * numbers — never a value the contract wouldn't itself produce.
 *
 * Mirrors `TendPoolVault.calculatePayout` exactly (contracts/TendPoolVault.sol):
 *
 *   delta = direction == Up   ? max(settlementPrice - strike, 0)
 *         : direction == Down ? max(strike - settlementPrice, 0)
 *   delta = min(delta, width)
 *   payout = maxPayout * delta / width
 *
 * `maxLoss`/`maxProfit` fall straight out of that without needing settlement
 * price at all:
 *   - delta = 0     -> payout = 0          -> loss = premium (the whole cost)
 *   - delta >= width -> payout = maxPayout  -> profit = maxPayout - premium
 *
 * For legacy widths, `breakevenPrice` and `capPrice` invert the linear segment — solving
 * `payout(delta) = premium` for delta, then converting delta back to a price:
 *
 *   delta_be = premium * width / maxPayout   (always <= width, since a quote
 *              never signs premium > maxPayout)
 *   breakeven = Up   ? strike + delta_be
 *             : Down ? strike - delta_be
 *   capPrice  = Up   ? strike + width          (delta == width, payout maxed)
 *             : Down ? strike - width
 *
 * New width=1 quotes are strict binary: a favourable settlement one raw tick
 * beyond strike pays maxPayout; a tie pays zero. premium and maxPayout are
 * both raw settlement-asset base units, so their
 * ratio is decimals-invariant — no need to descale either one to get
 * `delta_be` right, only strike/width need PRICE_SCALE.
 */
export interface PayoffSummary {
  /** = premium. The entire cost of the position; it cannot be liquidated for more than this. */
  maxLoss: bigint;
  /** = maxPayout - premium (clamped at 0, though a valid quote never signs premium > maxPayout). */
  maxProfit: bigint;
  /** Human USD price at which payout first equals premium (net P&L crosses zero). */
  breakevenPrice: number;
  /** Human USD price at which payout is fully capped at maxPayout. */
  capPrice: number;
  /** Human USD strike, echoed for convenience so callers don't re-derive it. */
  strikePrice: number;
  /** New quotes use width=1 raw tick and settle as strict expiry-only binaries. */
  isBinary: boolean;
}

/**
 * Net P&L (raw settlement-asset base units — same unscaled convention as
 * `maxLoss`/`maxProfit` above, not yet divided by the asset's decimals) at an
 * arbitrary settlement price. This is the exact same linear segment
 * `computePayoffSummary` derives its two flat endpoints from — reused here to
 * plot the whole curve for the payoff diagram instead of evaluating it only at
 * delta=0 and delta=width. No new math: same clamp, same scale, same mirror of
 * `calculatePayout` documented on `computePayoffSummary` above.
 */
export function computePnlAtPrice(quote: PoolQuote, settlementPrice: number): number {
  const strike = Number(quote.strike) / PRICE_SCALE;
  const width = Number(quote.width) / PRICE_SCALE;
  const premiumNum = Number(quote.premium);
  const maxPayoutNum = Number(quote.maxPayout);

  const isUp = quote.direction === 0;
  const rawSettlement = BigInt(Math.round(settlementPrice * PRICE_SCALE));
  const rawDelta = isUp ? rawSettlement - quote.strike : quote.strike - rawSettlement;
  const humanDelta = isUp ? settlementPrice - strike : strike - settlementPrice;
  // width=1 raw tick is the new expiry-only binary convention: strict wins
  // pay the whole cap; ties and the losing side pay zero. Wider legacy quotes
  // retain their deployed linear-spread behavior.
  const payout = quote.width === 1n
    ? (rawDelta > 0n ? maxPayoutNum : 0)
    : width > 0 ? (maxPayoutNum * Math.min(Math.max(humanDelta, 0), width)) / width : 0;

  return payout - premiumNum;
}

export function computePayoffSummary(quote: PoolQuote): PayoffSummary {
  const strike = Number(quote.strike) / PRICE_SCALE;
  const width = Number(quote.width) / PRICE_SCALE;

  const premiumNum = Number(quote.premium);
  const maxPayoutNum = Number(quote.maxPayout);
  const isBinary = quote.width === 1n;
  const ratio = maxPayoutNum > 0 ? premiumNum / maxPayoutNum : 0;
  const deltaToBreakeven = isBinary ? 1 / PRICE_SCALE : width * ratio;

  const isUp = quote.direction === 0;
  const breakevenPrice = isUp ? strike + deltaToBreakeven : strike - deltaToBreakeven;
  const capPrice = isBinary ? breakevenPrice : isUp ? strike + width : strike - width;

  const maxLoss = quote.premium;
  const maxProfit = quote.maxPayout > quote.premium ? quote.maxPayout - quote.premium : 0n;

  return { maxLoss, maxProfit, breakevenPrice, capPrice, strikePrice: strike, isBinary };
}

/**
 * Plain-language description of the payoff shape, e.g. "Pays from 64,300.00
 * up to 64,624.30, capped at 2,500.00 mUSDC." `formatUsdPrice` /
 * `maxPayoutHuman` are passed in rather than recomputed so this stays pure
 * string assembly with no formatting policy of its own.
 */
export function payoffShapeDescription(
  direction: number,
  strikeDisplay: string,
  capDisplay: string,
  maxPayoutDisplay: string,
  assetSymbol: string,
): string {
  const verb = direction === 0 ? "up to" : "down to";
  return `Pays from ${strikeDisplay} ${verb} ${capDisplay}, capped at ${maxPayoutDisplay} ${assetSymbol}.`;
}
