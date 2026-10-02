import { useQuery } from "@tanstack/react-query";
import type { UTCTimestamp } from "lightweight-charts";
import type { Hex } from "viem";

// Legacy hook/type names are retained for component compatibility. The demo's
// actual upstream is Coinbase Exchange through /api/market-data. Only the
// configured BTC/ETH feed IDs are supported. Responses use integer price/expo
// and TradingView UDF candle shapes; they are not Pyth oracle attestations.
const HERMES_LATEST_URL = "/api/market-data?kind=spot";
const BENCHMARKS_HISTORY_URL = "/api/market-data?kind=history";

const HOUR_SECONDS = 3600;
const HISTORY_HOURS = 24;

/** How often the candle series is refreshed, so the newest bar keeps moving. */
const BARS_REFRESH_MS = 60_000;

// Explicit supported markets, matching market-data/coinbase.ts.
const BENCHMARKS_SYMBOL_BY_FEED_ID: Record<string, string> = {
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": "Crypto.BTC/USD",
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace": "Crypto.ETH/USD",
  "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1": "Crypto.MON/USD",
};

/** Lowercases and 0x-prefixes a bytes32 feed id, or undefined if it isn't one. */
function normalizeFeedId(feedId: string | undefined): Hex | undefined {
  if (!feedId) return undefined;
  const clean = (feedId.startsWith("0x") ? feedId.slice(2) : feedId).toLowerCase();
  return /^[0-9a-f]{64}$/.test(clean) ? (`0x${clean}` as Hex) : undefined;
}

/**
 * The Benchmarks symbol for a feed id, if this demo knows one. Exported so a
 * caller can tell "no history for this feed" apart from "history failed" and
 * render accordingly instead of showing an error for an expected gap.
 */
export function benchmarksSymbolFor(feedId: string | undefined): string | undefined {
  const id = normalizeFeedId(feedId);
  return id ? BENCHMARKS_SYMBOL_BY_FEED_ID[id] : undefined;
}

/**
 * Benchmarks `resolution` values this app asks for: minutes as a number-string,
 * or "D" for daily. Narrowed to the set the chart's timeframes use so a typo
 * can't reach the wire.
 */
export type PythResolution = "1" | "5" | "15" | "60" | "240" | "D";

/** Shared query-string builder for the TradingView shim's `history` endpoint. */
function benchmarksHistoryUrl(symbol: string, resolution: PythResolution, from: number, to: number): string {
  return (
    `${BENCHMARKS_HISTORY_URL}&symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}`
  );
}

export interface PythSpot {
  /** Human price — the normalized integer already scaled by `10 ** expo`. */
  price: number;
  /** Exchange trade time for this price, unix seconds. */
  publishTime: number;
  /** The feed's exponent (negative), kept so callers can show the raw scale. */
  expo: number;
}

export interface PythSpotQuery {
  data: PythSpot | undefined;
  isLoading: boolean;
  isError: boolean;
  error: string | undefined;
}

export interface PythHistory {
  /** Hourly closes, oldest first. */
  points: number[];
  firstClose: number;
  lastClose: number;
}

export interface PythHistoryQuery {
  data: PythHistory | undefined;
  isLoading: boolean;
  isError: boolean;
  error: string | undefined;
  /** True when the feed id has no Benchmarks symbol — no history is expected, and that is not an error. */
  unsupportedFeed: boolean;
}

/**
 * One OHLC candle, shaped as Lightweight Charts' `CandlestickData` so it can go
 * straight into `series.setData()` with no adapter layer in between. `time` is
 * unix seconds, which is what Benchmarks returns and what `UTCTimestamp` is.
 */
export interface PythBar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PythBarsQuery {
  /** Bars oldest-first, or undefined while loading / on error / when the window is empty. */
  data: PythBar[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: string | undefined;
  /** True when the feed id has no Benchmarks symbol — no candles are expected, and that is not an error. */
  unsupportedFeed: boolean;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Market data returned a malformed ${label}.`);
  }
  return value as Record<string, unknown>;
}

/** Pyth sends `price`/`conf` as decimal strings; anything else is a malformed payload. */
function requireIntegerString(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new Error(`Market data field \`${field}\` is not an integer string.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Market data field \`${field}\` is not a finite number: ${value}`);
  return parsed;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Market data field \`${field}\` is not an integer.`);
  }
  return value;
}

/** Benchmarks sends OHLC values as plain JSON numbers; anything else is malformed. */
function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Benchmarks field \`${field}\` is not a finite number.`);
  }
  return value;
}

/**
 * Parses Hermes' `/v2/updates/price/latest` payload into a human price.
 * Fail-closed: a missing/malformed field throws rather than yielding a number
 * that looks plausible but is off by orders of magnitude — a wrong price is
 * far worse here than no price.
 */
function parseHermesLatest(raw: unknown): PythSpot {
  const root = asRecord(raw, "Hermes response");
  const parsed = root.parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Market data returned no price for this feed id.");
  }
  const price = asRecord(asRecord(parsed[0], "Hermes entry").price, "Hermes price");

  const rawPrice = requireIntegerString(price.price, "price.price");
  const expo = requireInteger(price.expo, "price.expo");
  const publishTime = requireInteger(price.publish_time, "price.publish_time");

  const human = rawPrice * 10 ** expo;
  if (!Number.isFinite(human)) throw new Error("Market price does not resolve to a finite number.");

  return { price: human, publishTime, expo };
}

/**
 * Parses the Benchmarks TradingView shim's `history` payload. A `s !== "ok"`
 * status or an empty close array means "no history for this window" — a
 * legitimate answer, returned as null rather than thrown, so the caller can
 * simply omit the sparkline.
 */
function parseBenchmarksHistory(raw: unknown): PythHistory | null {
  const root = asRecord(raw, "Benchmarks response");
  if (root.s !== "ok") return null;

  const closes = root.c;
  if (!Array.isArray(closes) || closes.length === 0) return null;

  const points = closes.map((close, index) => requireFiniteNumber(close, `c[${index}]`));

  return { points, firstClose: points[0], lastClose: points[points.length - 1] };
}

/** The parallel arrays the shim returns, in the order `parseBenchmarksBars` reads them. */
const BAR_COLUMNS = ["t", "o", "h", "l", "c"] as const;

/**
 * Parses the same `history` payload into candles. Follows the closes parser's
 * contract: `s !== "ok"` or an empty window is "no history here", returned as
 * null rather than thrown. A payload that claims `ok` but has ragged or
 * non-numeric columns does throw — candles assembled from misaligned arrays
 * would render as confident, completely wrong price action.
 *
 * The ascending-time check is not pedantry: Lightweight Charts asserts that
 * ordering inside `setData` and throws if it is violated, which would take the
 * whole panel down. Checking here turns that into an ordinary query error.
 */
function parseBenchmarksBars(raw: unknown): PythBar[] | null {
  const root = asRecord(raw, "Benchmarks response");
  if (root.s !== "ok") return null;

  const columns = BAR_COLUMNS.map((field) => {
    const column = root[field];
    if (!Array.isArray(column)) throw new Error(`Benchmarks field \`${field}\` is not an array.`);
    return column;
  });
  const [times, opens, highs, lows, closes] = columns;

  if (times.length === 0) return null;
  if (columns.some((column) => column.length !== times.length)) {
    throw new Error("Benchmarks OHLC columns have mismatched lengths.");
  }

  let previousTime = -Infinity;
  return times.map((time, index) => {
    const seconds = requireInteger(time, `t[${index}]`);
    if (seconds <= previousTime) {
      throw new Error("Benchmarks bars are not strictly ascending in time.");
    }
    previousTime = seconds;
    return {
      time: seconds as UTCTimestamp,
      open: requireFiniteNumber(opens[index], `o[${index}]`),
      high: requireFiniteNumber(highs[index], `h[${index}]`),
      low: requireFiniteNumber(lows[index], `l[${index}]`),
      close: requireFiniteNumber(closes[index], `c[${index}]`),
    };
  });
}

/**
 * Parses Hermes' `/v2/updates/price/latest` payload when it was requested
 * with more than one `ids[]=`, into a map keyed by feed id. Each entry carries
 * its own `id` field (unlike the single-feed case, which can assume
 * `parsed[0]` is the requested feed). A malformed individual entry is skipped
 * rather than failing the whole batch — one bad feed shouldn't blank out
 * every other position's live spot.
 */
function parseHermesLatestMany(raw: unknown): Record<string, PythSpot> {
  const root = asRecord(raw, "Hermes response");
  const parsed = root.parsed;
  if (!Array.isArray(parsed)) throw new Error("Market data returned no parsed price array.");

  const map: Record<string, PythSpot> = {};
  for (const entryRaw of parsed) {
    let entry: Record<string, unknown>;
    try {
      entry = asRecord(entryRaw, "Hermes entry");
    } catch {
      continue;
    }
    const id = normalizeFeedId(typeof entry.id === "string" ? entry.id : undefined);
    if (!id) continue;
    try {
      const price = asRecord(entry.price, "Hermes price");
      const rawPrice = requireIntegerString(price.price, "price.price");
      const expo = requireInteger(price.expo, "price.expo");
      const publishTime = requireInteger(price.publish_time, "price.publish_time");
      const human = rawPrice * 10 ** expo;
      if (!Number.isFinite(human)) continue;
      map[id] = { price: human, publishTime, expo };
    } catch {
      continue;
    }
  }
  return map;
}

/**
 * Live spot for a supported BTC/ETH feed id, refreshed every 10s.
 * nothing about the underlying is hardcoded, so this is the same price the
 * series settles against.
 *
 * `data` is cleared whenever the query is in an error state: a price that
 * failed to refresh is not a live price, and showing the last good number as
 * if it were current would be a lie. Callers render the error instead.
 */
export function usePythSpot(feedId?: Hex): PythSpotQuery {
  const id = normalizeFeedId(feedId);

  const query = useQuery({
    queryKey: ["pyth-spot", id],
    queryFn: async () => {
      const response = await fetch(`${HERMES_LATEST_URL}&ids[]=${id}&parsed=true`);
      if (!response.ok) throw new Error(`Market data returned HTTP ${response.status}.`);
      return parseHermesLatest(await response.json());
    },
    enabled: Boolean(id),
    refetchInterval: 10_000,
    retry: 1,
  });

  return {
    data: query.isError ? undefined : query.data,
    isLoading: Boolean(id) && query.isPending,
    isError: query.isError,
    error: query.error ? query.error.message : undefined,
  };
}

export interface PythSpotBatchQuery {
  /** Keyed by normalized (0x-prefixed, lowercased) feed id. A missing entry means "no live spot yet", never a stale one. */
  data: Record<string, PythSpot>;
  isLoading: boolean;
  isError: boolean;
  error: string | undefined;
}

/**
 * Live spot for several Pyth feed ids at once, in a single Hermes request —
 * used by the positions panel, which may need a spot per distinct series
 * rather than one. Fetching N feeds individually would mean N hook instances
 * (impossible with a dynamic, per-render list) or N sequential requests;
 * Hermes accepts multiple `ids[]=` in one call, so this stays one query no
 * matter how many open positions the connected wallet holds.
 *
 * Same honest-state rule as `usePythSpot`: an error clears `data` entirely
 * rather than leaving a stale batch on screen.
 */
export function usePythSpotBatch(feedIds: readonly (Hex | undefined)[]): PythSpotBatchQuery {
  const ids = Array.from(new Set(feedIds.map((id) => normalizeFeedId(id)).filter((id): id is Hex => Boolean(id)))).sort();
  const key = ids.join(",");

  const query = useQuery({
    queryKey: ["pyth-spot-batch", key],
    queryFn: async () => {
      const qs = ids.map((id) => `ids[]=${id}`).join("&");
      const response = await fetch(`${HERMES_LATEST_URL}&${qs}&parsed=true`);
      if (!response.ok) throw new Error(`Market data returned HTTP ${response.status}.`);
      return parseHermesLatestMany(await response.json());
    },
    enabled: ids.length > 0,
    refetchInterval: 10_000,
    retry: 1,
  });

  return {
    data: query.isError ? {} : (query.data ?? {}),
    isLoading: ids.length > 0 && query.isPending,
    isError: query.isError,
    error: query.error ? query.error.message : undefined,
  };
}

/**
 * The last 24h of hourly closes for a feed, for the sparkline. Only enabled
 * when the feed id maps to a Benchmarks symbol — an unknown feed reports
 * `unsupportedFeed` rather than erroring, since a missing sparkline is a known
 * gap in this demo's symbol map, not a failure.
 *
 * The window is computed inside the query fn so the cache key stays stable
 * (a `now` in the key would invalidate on every render).
 */
export function usePythHistory(feedId?: Hex): PythHistoryQuery {
  const symbol = benchmarksSymbolFor(feedId);

  const query = useQuery({
    queryKey: ["pyth-history", symbol],
    queryFn: async () => {
      const to = Math.floor(Date.now() / 1000);
      const from = to - HISTORY_HOURS * HOUR_SECONDS;
      const response = await fetch(benchmarksHistoryUrl(symbol!, "60", from, to));
      if (!response.ok) throw new Error(`Market data returned HTTP ${response.status}.`);
      return parseBenchmarksHistory(await response.json());
    },
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return {
    data: query.isError ? undefined : (query.data ?? undefined),
    isLoading: Boolean(symbol) && query.isPending,
    isError: query.isError,
    error: query.error ? query.error.message : undefined,
    unsupportedFeed: symbol === undefined,
  };
}

/**
 * OHLC candles for a feed at a given Benchmarks resolution, for the price
 * chart. Same shape and same rules as `usePythHistory` — enabled only for feeds
 * this demo can name a Benchmarks symbol for, `unsupportedFeed` instead of an
 * error when it can't, and `data` cleared on error so a failed refresh never
 * leaves last minute's candles on screen pretending to be current.
 *
 * `lookbackSeconds` is part of the cache key but the absolute window is
 * computed inside the query fn, so switching timeframes and back reuses the
 * cache instead of thrashing on a `now` that moves every render.
 */
export function usePythBars(
  feedId: Hex | undefined,
  resolution: PythResolution,
  lookbackSeconds: number,
): PythBarsQuery {
  const symbol = benchmarksSymbolFor(feedId);

  const query = useQuery({
    queryKey: ["pyth-bars", symbol, resolution, lookbackSeconds],
    queryFn: async () => {
      const to = Math.floor(Date.now() / 1000);
      const from = to - lookbackSeconds;
      const response = await fetch(benchmarksHistoryUrl(symbol!, resolution, from, to));
      if (!response.ok) throw new Error(`Market data returned HTTP ${response.status}.`);
      return parseBenchmarksBars(await response.json());
    },
    enabled: Boolean(symbol),
    staleTime: BARS_REFRESH_MS,
    refetchInterval: BARS_REFRESH_MS,
    retry: 1,
  });

  return {
    data: query.isError ? undefined : (query.data ?? undefined),
    isLoading: Boolean(symbol) && query.isPending,
    isError: query.isError,
    error: query.error ? query.error.message : undefined,
    unsupportedFeed: symbol === undefined,
  };
}
