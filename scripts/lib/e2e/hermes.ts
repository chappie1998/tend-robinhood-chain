// Hermes (Pyth's public price service) client used to fetch real BTC/USD
// prices for the e2e proof: once to pick a realistic at-the-money strike
// when signing the quote (step 3), and again to fetch the real, current
// price settled on-chain via MockPyth once the series has expired (step 6
// — see scripts/e2e-monad.ts's header comment for why MockPyth rather than
// a Hermes-fetched update's raw bytes). Only the platform's native fetch()
// is used — no SDK dependency — so this stays a thin, auditable wrapper
// around the one Hermes response shape Tend actually needs.
// Pyth made Hermes authentication MANDATORY on 2026-08-26 16:00 UTC. Every
// unauthenticated request now returns 401, which took the live quote API
// down: `/api/quote` could not fetch spot, so no quote could be signed and
// nobody could trade. Both are overridable by env so a key can be rotated,
// or a self-hosted/third-party Hermes pointed at, without a code change.
//
// NOTE on entitlement: a key is entitled to specific feeds. The trial tier
// covers CRYPTO feeds (BTC, ETH, SOL) — which is exactly what this demo
// trades — but NOT equity or tokenized-equity feeds, which return 403
// "Not entitled" rather than 401. A 403 here means the key is valid but the
// plan does not cover that feed id; that is a billing question, not a bug.
const HERMES_BASE_URL = process.env.PYTH_HERMES_URL?.trim() || "https://hermes.pyth.network";
const PYTH_API_KEY = process.env.PYTH_API_KEY?.trim() || "";

/// Auth headers for Hermes, or none when no key is configured (which is the
/// local-dev-against-a-self-hosted-instance case). Kept in one place so
/// every Hermes call site authenticates identically.
// Exported so other server-side Pyth call sites (quote-service/pricing.ts's
// realized-vol history fetch, the web/ proxy endpoints in api/) can attach
// the identical auth header instead of re-deriving PYTH_API_KEY handling —
// same key, same "no key configured -> no header" fallback, one place.
export function hermesHeaders(): HeadersInit | undefined {
  return PYTH_API_KEY ? { Authorization: `Bearer ${PYTH_API_KEY}` } : undefined;
}

// Hermes is a live upstream a quote request blocks on — without a timeout, a
// hung Hermes response pins the caller indefinitely. On the Vercel serverless
// path (api/quote.ts) that caller is a billed invocation with a hard platform
// execution ceiling, so an unbounded fetch here is a real availability bug,
// not just slowness. Reproduced: a server that accepts the connection but
// never responds hangs this call past 15s with no error.
//
// 6s is the chosen ceiling: Hermes's `/v2/updates/price/latest` is normally a
// sub-second lookup, so 6s is generous slack for real network variance while
// still leaving headroom for the rest of the quote pipeline (9 on-chain
// reads, EIP-712 signing, and the parallel Pyth Benchmarks fetch in
// quote-service/pricing.ts, which shares this same 6s budget since the two
// run concurrently via Promise.all in quote-service/derive.ts) to finish
// inside typical serverless function time limits.
const HERMES_FETCH_TIMEOUT_MS = 6_000;

export interface HermesParsedPrice {
  price: bigint; // raw Pyth price (int64, scaled by 10**expo)
  conf: bigint;
  expo: number;
  publishTime: number; // unix seconds
}

interface HermesPriceEntry {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

interface HermesLatestPriceResponse {
  parsed?: HermesPriceEntry[];
}

function toParsedPrice(entry: HermesPriceEntry): HermesParsedPrice {
  return {
    price: BigInt(entry.price.price),
    conf: BigInt(entry.price.conf),
    expo: entry.price.expo,
    publishTime: entry.price.publish_time,
  };
}

/// Fetches the latest parsed BTC/USD price from Hermes — used both to pick a
/// strike near current spot before signing the quote, and to read the real,
/// current price this e2e proof settles on-chain via MockPyth.
export async function fetchHermesSpotPrice(feedId: string): Promise<HermesParsedPrice> {
  const url = new URL("/v2/updates/price/latest", HERMES_BASE_URL);
  url.searchParams.append("ids[]", feedId);

  let response: Response;
  try {
    response = await fetch(url, { headers: hermesHeaders(), signal: AbortSignal.timeout(HERMES_FETCH_TIMEOUT_MS) });
  } catch (err) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError"
    // — distinguished from other fetch failures (DNS, connection refused,
    // TLS) so the caller sees exactly what happened rather than a generic
    // "network error", and always names the upstream that failed.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        `Hermes (${HERMES_BASE_URL}) did not respond within ${HERMES_FETCH_TIMEOUT_MS}ms for ${url.toString()}.`,
      );
    }
    throw new Error(`Could not reach Hermes (${HERMES_BASE_URL}) for ${url.toString()}: ${String(err)}`);
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Hermes rejected the request as unauthenticated (401). Pyth made authentication mandatory on 2026-08-26; "
        + "set PYTH_API_KEY in the environment (Vercel: Project Settings -> Environment Variables).",
      );
    }
    if (response.status === 403) {
      throw new Error(
        `Hermes accepted the key but the plan is not entitled to feed ${feedId} (403). `
        + "Crypto feeds are covered on the trial tier; equity feeds require a paid plan.",
      );
    }
    throw new Error(`Hermes request failed (${response.status} ${response.statusText}) for ${url.toString()}`);
  }
  const body = (await response.json()) as HermesLatestPriceResponse;
  const parsed = body.parsed?.[0];
  if (parsed === undefined) throw new Error(`Hermes returned no parsed price for feed ${feedId}`);
  return toParsedPrice(parsed);
}

/// Mirrors `TendSeriesFactory._normalizePrice` exactly: scales a raw Pyth
/// price to the contract's fixed PRICE_SCALE (1e8), so an off-chain strike
/// choice lands in the same units the contract will compare against at
/// settlement (contracts/TendSeriesFactory.sol).
export function normalizePythPrice(rawPrice: bigint, expo: number): bigint {
  const PRICE_SCALE = 10n ** 8n;
  const absExpo = BigInt(Math.abs(expo));
  const power = 10n ** absExpo;
  return expo >= 0 ? rawPrice * PRICE_SCALE * power : (rawPrice * PRICE_SCALE) / power;
}
