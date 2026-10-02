/** Public exchange data for the Monad testnet demo. No API key or trading account.
 * This is single-exchange data, not a cryptographically verified settlement oracle.
 */
const PRODUCTS: Record<string, string> = {
  e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43: "BTC-USD",
  ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace: "ETH-USD",
  "31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1": "MON-USD",
  "Crypto.BTC/USD": "BTC-USD",
  "Crypto.ETH/USD": "ETH-USD",
  "Crypto.MON/USD": "MON-USD",
};
export const DATA_SOURCE = "Coinbase Exchange";
export function productForFeed(feed: string): string {
  const product = PRODUCTS[feed.replace(/^0x/, "").toLowerCase()] ?? PRODUCTS[feed];
  if (!product) throw new Error("Unsupported market. This demo supports BTC/USD, ETH/USD and MON/USD.");
  return product;
}
async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`https://api.exchange.coinbase.com${path}`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000),
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("Coinbase did not respond within 6000ms.");
    throw new Error("Could not reach Coinbase market data.");
  });
  if (!response.ok) throw new Error(`Coinbase market data returned HTTP ${response.status}.`);
  return response.json();
}
export function parseTicker(raw: unknown, nowSec = Math.floor(Date.now() / 1000)) {
  const row = raw as Record<string, unknown> | null;
  const price = Number(row?.price);
  const publishTime = typeof row?.time === "string" ? Math.floor(Date.parse(row.time) / 1000) : NaN;
  if (!Number.isFinite(price) || price <= 0 || price > 100_000_000 || !Number.isFinite(publishTime)) {
    throw new Error("Coinbase returned an invalid price or timestamp.");
  }
  if (nowSec - publishTime > 60 || publishTime > nowSec + 10) throw new Error("Coinbase price is stale or has a future timestamp.");
  return { price: BigInt(Math.round(price * 1e8)), expo: -8, conf: 0n, publishTime, source: DATA_SOURCE };
}
// Coalesce the multiple components / simultaneous quotes reading the same market.
const spotCache = new Map<string, { until: number; value: Promise<ReturnType<typeof parseTicker>> }>();
export async function fetchDemoSpotPrice(feed: string) {
  const product = productForFeed(feed);
  const cached = spotCache.get(product);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = getJson(`/products/${product}/ticker`).then((raw) => parseTicker(raw));
  const entry = { until: Date.now() + 3000, value };
  spotCache.set(product, entry);
  try { return await value; } catch (error) { if (spotCache.get(product) === entry) spotCache.delete(product); throw error; }
}
export interface Candle { time: number; low: number; high: number; open: number; close: number }
export function parseCandles(raw: unknown, from: number, to: number): Candle[] {
  if (!Array.isArray(raw)) throw new Error("Coinbase returned invalid candle data.");
  const bars = new Map<number, Candle>();
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5 || row.slice(0, 5).some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new Error("Coinbase returned a malformed candle.");
    const [time, low, high, open, close] = row as number[];
    if (!Number.isInteger(time) || low <= 0 || high < low || open < low || open > high || close < low || close > high) throw new Error("Coinbase returned invalid OHLC prices.");
    if (time >= from && time < to) bars.set(time, { time, low, high, open, close });
  }
  return [...bars.values()].sort((a, b) => a.time - b.time);
}
const historyCache = new Map<string, { until: number; value: Promise<Candle[]> }>();
export async function fetchDemoCandles(feed: string, resolution: string, from: number, to: number): Promise<Candle[]> {
  const product = productForFeed(feed);
  const interval = ({ "1": 60, "5": 300, "15": 900, "60": 3600, "240": 14400, D: 86400 } as Record<string, number>)[resolution];
  if (!interval || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to - from > interval * 300 || to > Date.now() / 1000 + interval) throw new Error("Invalid candle window or resolution (maximum 300 candles).");
  const start = Math.floor(from / interval) * interval;
  const end = Math.ceil(to / interval) * interval;
  const key = `${product}/${resolution}/${start}/${end}`;
  const cached = historyCache.get(key);
  if (cached && cached.until > Date.now()) return (await cached.value).filter((c) => c.time >= from && c.time < to);
  const value = (async () => {
    const granularity = interval === 14400 ? 3600 : interval;
    const all: Candle[] = [];
    for (let cursor = start; cursor < end; cursor += granularity * 299) {
      const stop = Math.min(end, cursor + granularity * 299);
      const params = new URLSearchParams({ granularity: String(granularity), start: new Date(cursor * 1000).toISOString(), end: new Date(stop * 1000).toISOString() });
      all.push(...parseCandles(await getJson(`/products/${product}/candles?${params}`), cursor, stop));
    }
    if (interval !== 14400) return all;
    const groups = new Map<number, Candle>();
    for (const bar of all) {
      const time = Math.floor(bar.time / interval) * interval;
      const prev = groups.get(time);
      groups.set(time, prev ? { ...prev, high: Math.max(prev.high, bar.high), low: Math.min(prev.low, bar.low), close: bar.close } : { ...bar, time });
    }
    return [...groups.values()];
  })();
  // Bound memory even when callers request many distinct date windows.
  if (historyCache.size >= 100) historyCache.delete(historyCache.keys().next().value!);
  const entry = { until: Date.now() + 60_000, value };
  historyCache.set(key, entry);
  try {
    const bars = await value;
    // A newly opened expiry minute may not exist yet; let the next retry fetch it.
    if (bars.length === 0 && historyCache.get(key) === entry) historyCache.delete(key);
    return bars.filter((c) => c.time >= from && c.time < to);
  } catch (error) { if (historyCache.get(key) === entry) historyCache.delete(key); throw error; }
}

/** Testnet-only settlement reference: the opening price of the expiry minute.
 * The timestamp is the actual candle bucket, never a later spot stamped backwards.
 * This still is NOT a signed oracle attestation and requires MockPyth.
 */
export async function fetchDemoSettlementPrice(feed: string, expiry: number) {
  if (!Number.isInteger(expiry) || expiry % 60 !== 0) throw new Error("Demo settlement requires a minute-aligned expiry; an unsupported legacy series can use the timeout refund.");
  if (expiry >= Date.now() / 1000) throw new Error("Series has not expired.");
  const bars = await fetchDemoCandles(feed, "1", expiry, expiry + 60);
  const bar = bars.find((c) => c.time === expiry);
  if (!bar) throw new Error("Coinbase has not published the expiry-minute candle yet. Retry shortly.");
  return { price: BigInt(Math.round(bar.open * 1e8)), expo: -8, conf: 0n, publishTime: bar.time, source: `${DATA_SOURCE} expiry-minute open` };
}
