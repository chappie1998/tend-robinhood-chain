import { QUOTE_SELECTION_HEADROOM_SECONDS } from "../../../config/quotes.js";
/** Select a real, fillable expiry nearest to now, independent of RPC ordering.
 * Never pick the far end of the keeper's ladder just to maximize trading time.
 */
export function nearestFillableSeries<T extends { expiry: bigint; lastTradeAt: bigint; fillable: boolean }>(
  candidates: readonly T[], now: bigint,
): T | undefined {
  return candidates.reduce<T | undefined>((best, candidate) => {
    if (!candidate.fillable || candidate.expiry <= now || candidate.lastTradeAt <= now + QUOTE_SELECTION_HEADROOM_SECONDS) return best;
    return !best || candidate.expiry < best.expiry ? candidate : best;
  }, undefined);
}
