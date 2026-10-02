import { useEffect, useState } from "react";

/**
 * Ticking wall-clock second, shared by every countdown/publish-age display in
 * the app (quote expiry, series expiry, spot publish-age) instead of each one
 * running its own `setInterval`. Countdowns rendered in minutes don't need a
 * 1s tick — `intervalMs` lets slower-changing displays (e.g. an expiry badge)
 * poll less often than a live quote-expiry second-counter.
 */
export function useNowSeconds(intervalMs = 1000): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return nowSec;
}
