/**
 * Formats a human USD price for display, with decimals that scale to the
 * price.
 *
 * A fixed 2 decimals is wrong at both ends of this product's range: noise on
 * BTC, and destructive below a dollar. MON trades near $0.023, where every
 * strike on the ladder renders as "0.02" — three distinct rungs collapsing
 * into one number, in the signed quote AND in the tile the trader picks from.
 *
 * Mirrors web/src/lib/format.ts's formatUsdPrice. The two exist separately
 * because the service must not import from the SPA, but they must agree:
 * the strike a quote is signed at is the strike the ticket shows.
 */
export function formatPriceForDisplay(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  // Binary strikes can be only a few thousandths apart near expiry. Keep
  // enough precision above $1 to avoid displaying distinct signed strikes as
  // the same price; prices below $1 already use finer significant digits.
  if (abs >= 1) return value.toFixed(abs >= 1000 ? 3 : 4);
  // Roughly five significant figures below $1, capped at 8 — the on-chain
  // price resolution (PRICE_SCALE = 1e8).
  const magnitude = Math.floor(Math.log10(abs || 1));
  return value.toFixed(Math.min(8, Math.max(2, 4 - magnitude)));
}
