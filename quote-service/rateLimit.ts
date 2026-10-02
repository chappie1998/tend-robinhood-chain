// Minimal in-memory sliding-window rate limiter, shared by the standalone
// quote service (quote-service/server.ts, keyed on the validated buyer
// address) and the Vercel serverless function (api/quote.ts, keyed on client
// IP — see clientIpFromHeaders below for why buyer isn't usable there).
//
// HONEST LIMITATION — read before relying on this for anything but
// best-effort abuse deterrence:
//
// This is per-PROCESS memory. `server.ts` is a single long-lived Node
// process, so the limiter is a real, continuously-enforced limit there.
// Vercel serverless functions do NOT share memory across instances: each
// concurrently-spun-up instance (and every cold start) gets its own empty
// map. So on Vercel this only throttles a single warm instance getting
// hammered — a client that fans requests out across many parallel
// invocations, or simply keeps triggering fresh cold starts, is not caught
// by it. It is real protection against a single dumb/looping client, not
// protection against a determined attacker.
//
// The actual fix for a public deployment is rate limiting that has a shared
// view across instances: Vercel's edge/WAF firewall rules, or a shared store
// (Upstash Redis, Vercel KV) checked before the function even runs. That is
// deliberately NOT implemented here — tracked as follow-up work, configured
// outside this application rather than half-built inside it, so nobody
// mistakes this in-memory limiter for that protection.
export interface RateLimiterOptions {
  /** Sliding window length, in ms, over which hits are counted. */
  windowMs: number;
  /** Max hits from one key within the window. */
  maxPerKey: number;
  /** Max hits from ALL keys combined within the window — a coarse global cap so many distinct keys can't collectively overwhelm the instance. */
  maxTotal: number;
}

export interface RateLimiter {
  /** Records a hit for `key` and returns whether it's allowed (false = caller should reject with 429). */
  check(key: string): boolean;
}

/** Builds an independent limiter instance — each caller (server.ts, api/quote.ts) owns its own map, its own window/limits. */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const cutoff = now - opts.windowMs;

      // Sweep expired timestamps everywhere (not just `key`) so `total` below
      // is accurate and the map doesn't grow unboundedly across many distinct
      // keys/IPs over the process lifetime.
      let total = 0;
      for (const [k, timestamps] of hits) {
        const kept = timestamps.filter((t) => t > cutoff);
        if (kept.length === 0) hits.delete(k);
        else hits.set(k, kept);
        total += kept.length;
      }

      const mine = hits.get(key) ?? [];
      if (mine.length >= opts.maxPerKey || total >= opts.maxTotal) return false;
      mine.push(now);
      hits.set(key, mine);
      return true;
    },
  };
}

/**
 * Best-effort client IP from the first hop of X-Forwarded-For.
 *
 * Trust note: on Vercel, the platform's own edge sets/overwrites this header
 * with the real client chain before the function ever sees it, so it is
 * trustworthy there — a caller cannot simply send their own
 * `X-Forwarded-For` and have it believed, because Vercel's proxy appends the
 * real connecting IP regardless of what the client sent. Off Vercel (e.g. a
 * bare reverse proxy that blindly forwards client headers) this header WOULD
 * be spoofable; this function only claims to identify "the IP the deployment
 * platform attributes the request to", not an authenticated identity.
 *
 * Falls back to "unknown" (a single shared bucket) when the header is
 * absent — still enforces the coarse global cap even if per-client keying
 * degrades.
 */
export function clientIpFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  const forwarded = headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",")[0].trim();
  }
  return "unknown";
}
