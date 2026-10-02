/**
 * A spot print older than this reads STALE rather than LIVE. Spot refetches
 * every 10s; a minute of silence means the feed, not the refetch, has gone
 * quiet — and real-time data must never look fresher than it is.
 */
export const SPOT_STALE_SECONDS = 60;

export type SpotMode = "live" | "stale" | "loading";

/** One rule for every live/stale badge on the page (strip chip, price row, chart source). */
export function spotMode(publishTime: number | undefined, nowSec: number): SpotMode {
  if (publishTime === undefined) return "loading";
  return nowSec - publishTime <= SPOT_STALE_SECONDS ? "live" : "stale";
}
