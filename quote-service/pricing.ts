import { fetchDemoCandles } from "../market-data/coinbase.js";
// Real options pricing for the PoolQuote pipeline — replaces the old flat,
// leverage-tiered premium table with Black-Scholes fair value on a realized-
// volatility estimate, plus a strike solver that finds the strike a target
// leverage is actually fairly priced at.
//
// Every function here is pure and synchronous EXCEPT `realizedVolatility`,
// which is the one function that talks to the network (Coinbase Exchange) and
// caches its result. Everything else — erf/normalCdf, Black-Scholes,
// spread valuation, the strike solver — takes plain numbers and returns plain
// numbers, so it can be unit-tested with zero network access
// (see tests/pricing.test.mjs).
//
// Units: `spot`/`strike`/`width` are human USD prices (already descaled from
// the contract's 1e8 PRICE_SCALE by the caller). `maxPayout`/`targetPremium`/
// `fairValue`/`premium` are raw settlement-token units (same base-unit
// convention as the contract, e.g. mUSDC's 1e6), but carried as JS `number`
// rather than `bigint` since this module is inherently floating-point (vol,
// Black-Scholes, bisection) — the caller (quote-service/derive.ts) is
// responsible for converting to/from bigint at the boundary.

// ---------------------------------------------------------------------------
// erf / normal CDF — Abramowitz & Stegun 7.1.26 (max absolute error ~1.5e-7).
// No dependency: this is the one piece of math Black-Scholes needs that
// JavaScript doesn't ship, so it's implemented inline rather than pulling in
// a stats library for one function.
// ---------------------------------------------------------------------------
const ERF_P = 0.3275911;
const ERF_A1 = 0.254829592;
const ERF_A2 = -0.284496736;
const ERF_A3 = 1.421413741;
const ERF_A4 = -1.453152027;
const ERF_A5 = 1.061405429;

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + ERF_P * ax);
  const poly = ((((ERF_A5 * t + ERF_A4) * t + ERF_A3) * t + ERF_A2) * t + ERF_A1) * t;
  const y = 1 - poly * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF, N(x), built on `erf` above. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// Black-Scholes, r = 0.
//
// The risk-free rate is fixed at zero deliberately, not left as a parameter:
// every series this demo prices expires in well under 24 hours, and at that
// horizon the risk-free drift on the underlying is immaterial next to
// realized crypto volatility (32%+ annualized against ~4-5% risk-free — the
// drift term contributes a fraction of a basis point over a couple of
// hours). Zero is also the conservative choice: it doesn't let an assumed
// drift inflate the UP side or deflate the DOWN side relative to the other.
// If Tend ever prices multi-day or dated series this assumption should be
// revisited.
// ---------------------------------------------------------------------------
export interface BsParams {
  /** Human USD spot price. */
  spot: number;
  /** Human USD strike price. */
  strike: number;
  /** Annualized volatility, e.g. 0.32 for 32%. */
  volAnnual: number;
  /** Time to expiry in years. */
  timeYears: number;
}

function bsD1D2(p: BsParams): { d1: number; d2: number } {
  const sqrtT = Math.sqrt(p.timeYears);
  const sigmaSqrtT = p.volAnnual * sqrtT;
  const d1 = (Math.log(p.spot / p.strike) + 0.5 * p.volAnnual * p.volAnnual * p.timeYears) / sigmaSqrtT;
  return { d1, d2: d1 - sigmaSqrtT };
}

/** Black-Scholes call price, r=0. Degenerates to intrinsic value when time or vol is non-positive. */
export function blackScholesCall(p: BsParams): number {
  if (p.timeYears <= 0 || p.volAnnual <= 0) return Math.max(p.spot - p.strike, 0);
  const { d1, d2 } = bsD1D2(p);
  return p.spot * normalCdf(d1) - p.strike * normalCdf(d2);
}

/** Black-Scholes put price, r=0. Degenerates to intrinsic value when time or vol is non-positive. */
export function blackScholesPut(p: BsParams): number {
  if (p.timeYears <= 0 || p.volAnnual <= 0) return Math.max(p.strike - p.spot, 0);
  const { d1, d2 } = bsD1D2(p);
  return p.strike * normalCdf(-d2) - p.spot * normalCdf(-d1);
}

// ---------------------------------------------------------------------------
// The instrument: a call/put SPREAD, not a vanilla option.
//
// TendPoolVault.calculatePayout:
//   delta  = direction == Up ? max(S-K,0) : max(K-S,0)
//   delta  = min(delta, width)
//   payout = maxPayout * delta / width
//
// i.e. (maxPayout/width) units of a spread struck at K, capped at K±width:
//   UP  : (maxPayout/width) * [ C(K) - C(K+width) ]
//   DOWN: (maxPayout/width) * [ P(K) - P(K-width) ]
// ---------------------------------------------------------------------------
export type SpreadDirection = "up" | "down";

export interface SpreadParams {
  direction: SpreadDirection;
  spot: number;
  strike: number;
  width: number;
  volAnnual: number;
  timeYears: number;
}

/**
 * Present value of ONE unit of the spread — the terminal payoff
 * min(max(delta, 0), width), NOT yet scaled by maxPayout/width.
 *
 * Bounded to [0, width] by construction: a vanilla call/put is monotonic and
 * at most 1-Lipschitz in strike (|dC/dK| = N(d2) <= 1, |dP/dK| = N(-d2) <= 1),
 * so the difference of the same option at two strikes `width` apart can never
 * exceed `width`, and — since call value strictly decreases in strike / put
 * value strictly increases in strike — the difference is never negative
 * either. That mirrors the contract's own `min(delta, width)` clamp exactly.
 */
export function spreadUnitValue(p: SpreadParams): number {
  if (p.direction === "up") {
    return (
      blackScholesCall({ spot: p.spot, strike: p.strike, volAnnual: p.volAnnual, timeYears: p.timeYears }) -
      blackScholesCall({
        spot: p.spot,
        strike: p.strike + p.width,
        volAnnual: p.volAnnual,
        timeYears: p.timeYears,
      })
    );
  }
  return (
    blackScholesPut({ spot: p.spot, strike: p.strike, volAnnual: p.volAnnual, timeYears: p.timeYears }) -
    blackScholesPut({
      spot: p.spot,
      strike: p.strike - p.width,
      volAnnual: p.volAnnual,
      timeYears: p.timeYears,
    })
  );
}

/** Scales a per-unit spread value up to the position's maxPayout — in [0, maxPayout] since spreadUnitValue is in [0, width]. */
export function fairValue(maxPayout: number, width: number, unitValue: number): number {
  if (width <= 0) return 0;
  return maxPayout * (unitValue / width);
}

// ---------------------------------------------------------------------------
// Maker edge — the pool's compensation for selling the risk, applied on top
// of fair value. A named constant (not folded into fair value silently) so
// the response can report `fairValue` and `makerEdgeBps` separately and the
// markup stays inspectable rather than baked invisibly into `premium`.
// ---------------------------------------------------------------------------
export const MAKER_EDGE_BPS = 1_500; // 15% over fair value.

export function applyMakerEdge(fair: number, edgeBps: number = MAKER_EDGE_BPS): number {
  return fair * (1 + edgeBps / 10_000);
}

// ---------------------------------------------------------------------------
// Probability of finishing in the money — the honest counterweight to a big
// leverage number. N(d2) is exactly the risk-neutral P(S_T > K) for a call
// (P(S_T < K) = N(-d2) for a put), which is r=0 here since the whole engine
// prices with r=0 throughout.
// ---------------------------------------------------------------------------
export function probabilityItm(
  direction: SpreadDirection,
  spot: number,
  strike: number,
  volAnnual: number,
  timeYears: number,
): number {
  if (timeYears <= 0 || volAnnual <= 0) {
    const itm = direction === "up" ? spot > strike : spot < strike;
    return itm ? 1 : 0;
  }
  const { d2 } = bsD1D2({ spot, strike, volAnnual, timeYears });
  return direction === "up" ? normalCdf(d2) : normalCdf(-d2);
}

// ---------------------------------------------------------------------------
// The strike solver that used to live here is gone. It took a MULTIPLE as its
// input and searched for a strike whose spread priced at maxPayout/leverage,
// so a quote could simply fail to exist ("25x is not reachable at the current
// volatility and time to expiry") whenever no strike inside the allowed band
// priced that cheaply — routinely, close to expiry. Strikes now come from a
// ladder and the multiple is derived from the strike it lands on: see
// quote-service/strikeLadder.ts. Do not reintroduce solving for a multiple.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Realized volatility from completed Coinbase hourly candles, using the same
// products as the chart and spot quote. The adapter enforces timeouts and bounds.
// No API key is required. Unknown feeds fail closed.
const BENCHMARKS_SYMBOL_BY_FEED_ID: Record<string, string> = {
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": "Crypto.BTC/USD",
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace": "Crypto.ETH/USD",
  "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1": "Crypto.MON/USD",
};

const HOUR_SECONDS = 3600;
const HISTORY_DAYS = 7;
const HISTORY_HOURS = HISTORY_DAYS * 24;
const HOURS_PER_YEAR = 24 * 365;

/** How long a symbol's realized-vol estimate is reused before refetching — an explicit cache, not a refetch-per-quote. */
export const VOL_CACHE_TTL_MS = 5 * 60_000;

/** Sanity bounds on the annualized estimate — outside this range the estimate is treated as a data error, never used. */
export const MIN_ANNUAL_VOL = 0.05; // 5%
export const MAX_ANNUAL_VOL = 3.0; // 300%

export class VolatilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VolatilityUnavailableError";
  }
}

function normalizeFeedIdKey(feedId: string): string {
  const clean = (feedId.startsWith("0x") ? feedId.slice(2) : feedId).toLowerCase();
  return `0x${clean}`;
}

/** The Benchmarks symbol for a feed id, if this engine can price it — undefined means "cannot estimate vol for this feed", which the caller must treat as a hard failure (never a fallback constant). */
export function benchmarksSymbolForFeedId(feedId: string): string | undefined {
  return BENCHMARKS_SYMBOL_BY_FEED_ID[normalizeFeedIdKey(feedId)];
}

async function fetchHourlyCloses(symbol: string): Promise<number[]> {
  // Use only completed hourly candles for a consistent realized-vol estimate.
  const to = Math.floor(Date.now() / 3_600_000) * 3600;
  const bars = await fetchDemoCandles(symbol, "60", to - HISTORY_HOURS * HOUR_SECONDS, to)
    .catch((error: unknown) => { throw new VolatilityUnavailableError(error instanceof Error ? error.message : "Coinbase history unavailable."); });
  if (bars.length < 24 || bars.at(-1)!.time < to - 3600 || bars.some((bar, i) => i > 0 && bar.time - bars[i - 1].time !== 3600)) {
    throw new VolatilityUnavailableError("Coinbase hourly history is insufficient, stale or has gaps.");
  }
  return bars.map(bar => bar.close);
}

/**
 * Annualized realized volatility from a series of hourly closes: close-to-
 * close log-return standard deviation, annualized by sqrt(24*365). Pure and
 * network-free — the part of the estimator that's unit-tested directly
 * (see tests/pricing.test.mjs); `realizedVolatility` below is the thin,
 * network-touching, caching wrapper around it.
 */
export function realizedVolFromCloses(closes: number[]): number {
  if (closes.length < 2) {
    throw new VolatilityUnavailableError("Need at least 2 closes to estimate realized volatility.");
  }
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
  const variance =
    logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / Math.max(logReturns.length - 1, 1);
  const hourlyStd = Math.sqrt(variance);
  return hourlyStd * Math.sqrt(HOURS_PER_YEAR);
}

interface VolCacheEntry {
  volAnnual: number;
  expiresAt: number;
}
const volCache = new Map<string, VolCacheEntry>();

/**
 * How long a FAILED estimate (fetch error, bad data, out-of-bounds result) is
 * remembered before the next call retries the upstream, so a Hermes/
 * Benchmarks outage costs roughly one fetch per window rather than one per
 * quote request — without this, every quote during an outage independently
 * re-attempts (and, pre-timeout-fix, would each hang for
 * BENCHMARKS_FETCH_TIMEOUT_MS). Short relative to VOL_CACHE_TTL_MS (~5 min
 * for a SUCCESSFUL estimate) so a real recovery is picked back up quickly —
 * 45s means at most ~45s of continued failures after Benchmarks comes back,
 * versus a stale success being served for up to 5 minutes after the market
 * has moved. This does NOT change the fail-closed behaviour: a cached
 * failure still throws `VolatilityUnavailableError`, it just skips the
 * network round-trip while doing so.
 */
export const VOL_FAILURE_CACHE_TTL_MS = 45_000;

interface VolFailureCacheEntry {
  message: string;
  expiresAt: number;
}
const volFailureCache = new Map<string, VolFailureCacheEntry>();

/**
 * Realized volatility for a Pyth feed id, from the last 7 days of Benchmarks
 * hourly closes, cached per symbol for `VOL_CACHE_TTL_MS` (~5 minutes) so a
 * burst of quote requests doesn't refetch history per quote.
 *
 * Fails closed on every kind of bad data — no feed→symbol mapping, a fetch/
 * HTTP error, too little history, or an estimate outside
 * [MIN_ANNUAL_VOL, MAX_ANNUAL_VOL] — by throwing `VolatilityUnavailableError`.
 * The caller (quote-service/derive.ts) maps that to a 502: a wrong price is
 * worse than no price, so there is deliberately no fallback constant here.
 *
 * A failure is itself cached for `VOL_FAILURE_CACHE_TTL_MS` (see above) —
 * during a Benchmarks outage, every request still fails the quote (never
 * fabricates a vol), it just fails fast from cache instead of re-attempting
 * the fetch (and, pre-timeout-fix, re-hanging) on every single request.
 */
export async function realizedVolatility(feedId: string): Promise<number> {
  const symbol = benchmarksSymbolForFeedId(feedId);
  if (!symbol) {
    throw new VolatilityUnavailableError(
      `No Pyth Benchmarks symbol mapped for feed ${feedId} — cannot estimate realized volatility for it.`,
    );
  }

  const now = Date.now();
  const cached = volCache.get(symbol);
  if (cached && cached.expiresAt > now) return cached.volAnnual;

  const cachedFailure = volFailureCache.get(symbol);
  if (cachedFailure && cachedFailure.expiresAt > now) {
    const retryInSeconds = Math.ceil((cachedFailure.expiresAt - now) / 1000);
    throw new VolatilityUnavailableError(`${cachedFailure.message} (cached failure, retrying in ${retryInSeconds}s)`);
  }

  try {
    const closes = await fetchHourlyCloses(symbol);
    const volAnnual = realizedVolFromCloses(closes);
    if (!Number.isFinite(volAnnual) || volAnnual < MIN_ANNUAL_VOL || volAnnual > MAX_ANNUAL_VOL) {
      throw new VolatilityUnavailableError(
        `Realized volatility for ${symbol} is out of sane bounds: ${(volAnnual * 100).toFixed(1)}% annualized ` +
          `(expected between ${MIN_ANNUAL_VOL * 100}% and ${MAX_ANNUAL_VOL * 100}%). Refusing to price on a bad estimate.`,
      );
    }

    volCache.set(symbol, { volAnnual, expiresAt: now + VOL_CACHE_TTL_MS });
    volFailureCache.delete(symbol); // clear any stale failure record now that the upstream is healthy again
    return volAnnual;
  } catch (err) {
    const message = err instanceof VolatilityUnavailableError ? err.message : String(err);
    volFailureCache.set(symbol, { message, expiresAt: Date.now() + VOL_FAILURE_CACHE_TTL_MS });
    if (err instanceof VolatilityUnavailableError) throw err;
    throw new VolatilityUnavailableError(message);
  }
}
