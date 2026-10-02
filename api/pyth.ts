// Server-side proxy for Pyth market data.
//
// WHY THIS EXISTS
//
// Until 2026-08-26 the browser could call Pyth directly: Hermes' spot endpoint
// and the Benchmarks TradingView shim were both unauthenticated. The Pyth Core
// upgrade at 16:00 UTC that day changed both:
//
//   * Hermes now REQUIRES `Authorization: Bearer $PYTH_API_KEY`. Unauthenticated
//     requests return 401 — which is why the header's spot price hung on
//     "Loading Pyth spot price..." forever.
//   * The Benchmarks `/v1/shims/tradingview/*` endpoints were RETIRED outright.
//     They return 404, so a key alone does not revive them; the replacement is
//     Pyth Pro's History API, which implements the same TradingView UDF
//     specification and therefore returns a byte-identical response shape.
//
// A key is now mandatory, and the chart runs in the browser — so the fetch
// CANNOT stay client-side. Anything the frontend bundle can read is public:
// Vite inlines `VITE_`-prefixed values (and any literal) straight into the
// shipped JS, where the first person to open devtools has the key. Routing
// through this endpoint keeps `PYTH_API_KEY` on the server, where Vercel holds
// it as an encrypted environment variable and it never reaches a client.
//
// Deliberately a thin pass-through: it forwards the caller's query parameters
// and returns Pyth's JSON verbatim, so the browser-side parsers in
// web/src/hooks/usePythPrice.ts did not have to change at all. The response
// contract they depend on is Pyth's, not this file's.

import type { IncomingMessage, ServerResponse } from "node:http";

/** Hermes latest-price endpoint. Overridable so a self-hosted or third-party Hermes can be pointed at without a code change. */
const HERMES_BASE_URL = process.env.PYTH_HERMES_URL?.trim() || "https://hermes.pyth.network";

/**
 * Pyth Pro's History API — the documented replacement for the retired
 * Benchmarks TradingView shim. Same UDF contract (`symbol`, `resolution`,
 * `from`, `to` in; `{ s, t, o, h, l, c }` out), so this is a base-URL swap
 * rather than a reintegration.
 */
const PRO_HISTORY_URL =
  process.env.PYTH_HISTORY_URL?.trim() || "https://pyth.dourolabs.app/v1/fixed_rate@200ms/history";

const PYTH_API_KEY = process.env.PYTH_API_KEY?.trim() || "";

/**
 * Upstream timeout. Same reasoning as the quote path's Hermes timeout: this
 * runs as a billed serverless invocation with a hard platform ceiling, so an
 * unbounded fetch is an availability bug rather than mere slowness.
 */
const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * Browser cache windows. Spot moves constantly so it is barely cached; candles
 * are hourly, so caching them meaningfully cuts both latency and Pyth quota
 * usage. `stale-while-revalidate` keeps the chart painted while a refresh runs.
 */
const CACHE_CONTROL: Record<string, string> = {
  spot: "public, max-age=5, stale-while-revalidate=25",
  history: "public, max-age=60, stale-while-revalidate=300",
};

function send(res: ServerResponse, status: number, body: unknown, cacheControl?: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  if (cacheControl) res.setHeader("Cache-Control", cacheControl);
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    send(res, 405, { error: "Only GET is supported." });
    return;
  }

  // `req.url` is path-relative on Vercel, so it needs a base to parse against.
  const incoming = new URL(req.url ?? "", "http://localhost");
  const kind = incoming.searchParams.get("kind");
  if (kind !== "spot" && kind !== "history") {
    send(res, 400, { error: '`kind` must be "spot" or "history".' });
    return;
  }

  if (!PYTH_API_KEY) {
    // Fail loudly and specifically. A missing key is an operator mistake, and
    // the generic 401 it would otherwise produce sent us on a long hunt once
    // already.
    send(res, 503, {
      error:
        "PYTH_API_KEY is not configured on the server. Pyth has required authentication since 2026-08-26; "
        + "set it in the deployment environment (Vercel: Project Settings -> Environment Variables).",
    });
    return;
  }

  // Forward every parameter except our own routing key, so the browser keeps
  // full control of the upstream query (feed ids, resolution, time window) and
  // this file needs no knowledge of their meaning.
  const upstream =
    kind === "spot" ? new URL("/v2/updates/price/latest", HERMES_BASE_URL) : new URL(PRO_HISTORY_URL);
  incoming.searchParams.forEach((value, key) => {
    if (key !== "kind") upstream.searchParams.append(key, value);
  });

  let response: Response;
  try {
    response = await fetch(upstream, {
      headers: { Authorization: `Bearer ${PYTH_API_KEY}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    send(res, 504, {
      error: timedOut
        ? `Pyth did not respond within ${UPSTREAM_TIMEOUT_MS}ms.`
        : `Could not reach Pyth: ${String(err)}`,
    });
    return;
  }

  if (!response.ok) {
    // Map the two upstream failures that actually happen to messages that say
    // what to DO, rather than passing a bare status through to the UI.
    if (response.status === 401) {
      send(res, 502, { error: "Pyth rejected the server's API key (401). It may be expired or revoked." });
      return;
    }
    if (response.status === 403) {
      send(res, 502, {
        error:
          "Pyth accepted the key but the plan is not entitled to this feed (403). "
          + "Crypto feeds are covered on the trial tier; equity feeds require a paid plan.",
      });
      return;
    }
    send(res, 502, { error: `Pyth returned HTTP ${response.status} ${response.statusText}.` });
    return;
  }

  const payload = await response.json().catch(() => null);
  if (payload === null) {
    send(res, 502, { error: "Pyth returned a response that was not valid JSON." });
    return;
  }
  send(res, 200, payload, CACHE_CONTROL[kind]);
}
