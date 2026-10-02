import { formatCountdown, formatTimestamp } from "../lib/format";
import { useNowSeconds } from "../hooks/useNowSeconds";

/**
 * "expires in 1h 12m" (or "expired"), ticking — traders think in
 * time-to-expiry, not raw timestamps, so this is what's shown front and
 * center wherever an expiry appears (market selector, trade ticket, series
 * table). The exact timestamp is never hidden, just demoted to a hover:
 * `title` always carries it via `formatTimestamp`.
 *
 * Purely presentational: `expiry` is always a value already read from the
 * chain elsewhere (getSeries, a quote's own terms) — this component derives
 * no new figures, only reformats an existing one against the clock.
 */
export function ExpiryCountdown({
  expiry,
  tickMs = 30_000,
  className,
}: {
  expiry: bigint;
  /** Tick granularity — 30s is plenty for a minute-granularity countdown badge. */
  tickMs?: number;
  className?: string;
}) {
  const nowSec = useNowSeconds(tickMs);
  const label = formatCountdown(expiry, nowSec);
  const expired = label === "expired";

  return (
    <span className={`expiry-countdown${className ? ` ${className}` : ""}`} data-expired={expired || undefined} title={formatTimestamp(expiry)}>
      {expired ? "expired" : `expires in ${label}`}
    </span>
  );
}
