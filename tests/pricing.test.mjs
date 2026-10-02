// Pure, network-free behavioral tests for the Black-Scholes pricing engine
// (quote-service/pricing.ts). Unlike the source-inspection tests elsewhere in
// this directory, pricing.ts is a pure module (no network access except
// `realizedVolatility`, which this file never calls), so these tests import
// it directly and exercise the real functions with real numbers — the same
// approach tests/product.test.mjs uses for app/lib/expiries.ts and
// app/lib/options.ts.
import assert from "node:assert/strict";
import test from "node:test";

const {
  blackScholesCall,
  blackScholesPut,
  spreadUnitValue,
  fairValue,
  realizedVolFromCloses,
  realizedVolatility,
  VolatilityUnavailableError,
} = await import(new URL("../quote-service/pricing.ts", import.meta.url));

// A representative short-dated quote, matching the demo's real shape: a BTC-
// scale spot, width = 0.5% of spot (WIDTH_BPS_OF_SPOT in derive.ts), and a
// maxPayout many multiples of width (leverage is built into that ratio, not
// into the option math).
const SPOT = 60_000;
const WIDTH = SPOT * 0.005;
const MAX_PAYOUT = 2500 * 1e6; // raw mUSDC-scale units, arbitrary
const SHORT_TIME_YEARS = 2 / (365 * 24); // 2 hours to expiry
const TYPICAL_VOL = 0.32;

test("put/call parity holds at r=0: C - P = S - K", () => {
  const cases = [
    { spot: SPOT, strike: SPOT, volAnnual: 0.3, timeYears: SHORT_TIME_YEARS },
    { spot: SPOT, strike: SPOT * 1.02, volAnnual: 0.5, timeYears: 1 / 365 },
    { spot: SPOT, strike: SPOT * 0.95, volAnnual: 0.8, timeYears: 7 / 365 },
    { spot: 1.5, strike: 1.4, volAnnual: 0.6, timeYears: 30 / 365 },
  ];
  for (const p of cases) {
    const call = blackScholesCall(p);
    const put = blackScholesPut(p);
    assert.ok(
      Math.abs(call - put - (p.spot - p.strike)) < 1e-8,
      `parity failed for ${JSON.stringify(p)}: C=${call} P=${put} S-K=${p.spot - p.strike}`,
    );
  }
});

test("spread premium rises monotonically with volatility, holding strike/width/time fixed", () => {
  const strike = SPOT * 1.01; // 1% out-of-the-money
  const vols = [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0];
  const values = vols.map((volAnnual) =>
    spreadUnitValue({ direction: "up", spot: SPOT, strike, width: WIDTH, volAnnual, timeYears: SHORT_TIME_YEARS }),
  );
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i] > values[i - 1],
      `expected spread value to rise with vol: vol=${vols[i - 1]}->${values[i - 1]}, vol=${vols[i]}->${values[i]}`,
    );
  }
});

test("spread premium rises monotonically with time to expiry, holding strike/width/vol fixed", () => {
  const strike = SPOT * 1.01;
  const hours = [0.5, 1, 2, 4, 8, 24, 24 * 7];
  const values = hours.map((h) =>
    spreadUnitValue({
      direction: "up",
      spot: SPOT,
      strike,
      width: WIDTH,
      volAnnual: TYPICAL_VOL,
      timeYears: h / (365 * 24),
    }),
  );
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i] > values[i - 1],
      `expected spread value to rise with time: ${hours[i - 1]}h->${values[i - 1]}, ${hours[i]}h->${values[i]}`,
    );
  }
});

test("spread unit value is bounded by [0, width], and fairValue by [0, maxPayout], across strikes/vols/times", () => {
  const offsets = [0, 0.001, 0.005, 0.01, 0.02, 0.03, 0.05];
  const vols = [0.05, 0.32, 1.0, 3.0];
  const timesHours = [0.1, 2, 24, 24 * 7];
  for (const direction of ["up", "down"]) {
    for (const offsetFraction of offsets) {
      const offset = SPOT * offsetFraction;
      const strike = direction === "up" ? SPOT + offset : SPOT - offset;
      for (const volAnnual of vols) {
        for (const hours of timesHours) {
          const timeYears = hours / (365 * 24);
          const unitValue = spreadUnitValue({ direction, spot: SPOT, strike, width: WIDTH, volAnnual, timeYears });
          assert.ok(
            unitValue >= -1e-9 && unitValue <= WIDTH + 1e-6,
            `unitValue out of [0, width]: ${unitValue} (width=${WIDTH}) for ${direction} strike=${strike} vol=${volAnnual} hours=${hours}`,
          );
          const fv = fairValue(MAX_PAYOUT, WIDTH, unitValue);
          assert.ok(
            // `unitValue` carries its own tiny (~1e-12) floating-point noise
            // near 0 (erf/normalCdf are only accurate to ~1.5e-7 absolute,
            // and the spread is a difference of two nearly-equal call/put
            // values); fairValue's maxPayout/width scaling (~8.3e6 here)
            // amplifies that noise, so the lower bound needs matching slack.
            fv >= -1e-3 && fv <= MAX_PAYOUT + 1e-3,
            `fairValue out of [0, maxPayout]: ${fv} for unitValue=${unitValue}`,
          );
        }
      }
    }
  }
});

test("deep in-the-money spread value is (numerically) exactly the width, deep out-of-the-money is exactly 0", () => {
  const deepItmStrikeUp = SPOT * 0.5; // strike far below spot: an UP spread here is fully in the money
  const deepOtmStrikeUp = SPOT * 3; // strike far above spot: fully out of the money

  const deepItm = spreadUnitValue({
    direction: "up",
    spot: SPOT,
    strike: deepItmStrikeUp,
    width: WIDTH,
    volAnnual: TYPICAL_VOL,
    timeYears: SHORT_TIME_YEARS,
  });
  const deepOtm = spreadUnitValue({
    direction: "up",
    spot: SPOT,
    strike: deepOtmStrikeUp,
    width: WIDTH,
    volAnnual: TYPICAL_VOL,
    timeYears: SHORT_TIME_YEARS,
  });

  assert.equal(deepItm, WIDTH);
  assert.equal(deepOtm, 0);

  // fairValue scales those straight to the payout bounds.
  assert.equal(fairValue(MAX_PAYOUT, WIDTH, deepItm), MAX_PAYOUT);
  assert.equal(fairValue(MAX_PAYOUT, WIDTH, deepOtm), 0);

  // Same shape holds for the DOWN spread, mirrored around spot.
  const deepItmDown = spreadUnitValue({
    direction: "down",
    spot: SPOT,
    strike: SPOT * 1.5,
    width: WIDTH,
    volAnnual: TYPICAL_VOL,
    timeYears: SHORT_TIME_YEARS,
  });
  const deepOtmDown = spreadUnitValue({
    direction: "down",
    spot: SPOT,
    strike: SPOT * 0.3,
    width: WIDTH,
    volAnnual: TYPICAL_VOL,
    timeYears: SHORT_TIME_YEARS,
  });
  assert.equal(deepItmDown, WIDTH);
  assert.equal(deepOtmDown, 0);
});

test("realizedVolFromCloses recovers a known-volatility synthetic series", () => {
  // Deterministic PRNG (mulberry32) + Box-Muller — reproducible, no
  // Math.random, no network. Simulates hourly GBM closes at a chosen
  // annualized vol and checks the estimator recovers it within tolerance.
  function mulberry32(seed) {
    let a = seed;
    return function rng() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randn(rng) {
    const u1 = rng();
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  const HOURS_PER_YEAR = 24 * 365;
  const trueAnnualVol = 0.4;
  const hourlyVol = trueAnnualVol / Math.sqrt(HOURS_PER_YEAR);
  const rng = mulberry32(12345);

  let price = 100;
  const closes = [price];
  for (let i = 0; i < 24 * 30; i += 1) {
    // 30 days of hourly closes
    price *= Math.exp(randn(rng) * hourlyVol);
    closes.push(price);
  }

  const estimated = realizedVolFromCloses(closes);
  const relativeError = Math.abs(estimated - trueAnnualVol) / trueAnnualVol;
  assert.ok(
    relativeError < 0.1,
    `estimated vol ${estimated} too far from true vol ${trueAnnualVol} (relative error ${relativeError})`,
  );
});

// A strike this far out on a short-dated series is worth exactly nothing to
// the model. It is why asking for a MULTIPLE could fail: the old solver hunted
// this range for a premium target and found only zeros. The ladder instead
// pulls a rung back until it has a price (see strikeLadder.ts), so this
// underflow can no longer reach a trader as a failed quote.
test("spreadUnitValue underflows to an exact 0 far out of the money on a short-dated series", () => {
  const atMax = spreadUnitValue({
    direction: "up",
    spot: SPOT,
    strike: SPOT * 1.05,
    width: WIDTH,
    volAnnual: TYPICAL_VOL,
    timeYears: SHORT_TIME_YEARS,
  });
  assert.equal(atMax, 0);
});

// ---------------------------------------------------------------------------
// realizedVolatility: fetch timeout mapping + negative caching. These are
// network-free by mocking globalThis.fetch, not by skipping the network
// path — they exercise the real `realizedVolatility` (and, through it,
// `fetchHourlyCloses`'s try/catch) with a stand-in fetch, and assert on the
// actual error thrown and how many times fetch was actually invoked.
//
// The two Pyth Benchmarks symbols this engine maps (BTC, ETH — see
// BENCHMARKS_SYMBOL_BY_FEED_ID in pricing.ts) are split one per test below
// so the two tests can't collide through pricing.ts's module-level
// volCache/volFailureCache, which persist for the lifetime of this test
// file's process.
// ---------------------------------------------------------------------------
const BTC_FEED_ID = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const ETH_FEED_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

/** Swaps in a mock `fetch` for the duration of `fn`, always restoring the original afterward (even on throw). */
async function withMockedFetch(mockFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("realizedVolatility maps an AbortSignal timeout to a clear, upstream-naming VolatilityUnavailableError (not a generic network error)", async () => {
  await withMockedFetch(
    async () => {
      // What AbortSignal.timeout(ms) actually produces on abort: a DOMException-
      // shaped rejection named "TimeoutError". A plain Error with that name is
      // enough to exercise pricing.ts's `err.name === "TimeoutError"` branch
      // without waiting out a real 6s timeout.
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    },
    async () => {
      await assert.rejects(
        () => realizedVolatility(BTC_FEED_ID),
        (err) => {
          assert.ok(err instanceof VolatilityUnavailableError);
          assert.match(err.message, /Coinbase/);
          assert.match(err.message, /did not respond within 6000ms/);
          return true;
        },
      );
    },
  );
});

test("realizedVolatility fails closed on a Benchmarks fetch failure and caches that failure so an immediate retry does not hit the network again", async () => {
  let fetchCalls = 0;
  await withMockedFetch(
    async () => {
      fetchCalls += 1;
      throw new Error("simulated connection failure");
    },
    async () => {
      await assert.rejects(() => realizedVolatility(ETH_FEED_ID), VolatilityUnavailableError);
      assert.equal(fetchCalls, 1, "first call should hit the network exactly once");

      // Immediately retrying must hit the cached failure, not the network —
      // this is the whole point of the negative cache: an outage costs one
      // fetch per VOL_FAILURE_CACHE_TTL_MS window, not one per request.
      await assert.rejects(
        () => realizedVolatility(ETH_FEED_ID),
        (err) => {
          assert.ok(err instanceof VolatilityUnavailableError);
          assert.match(err.message, /cached failure/);
          return true;
        },
      );
      assert.equal(fetchCalls, 1, "second call within the failure TTL must not re-fetch");
    },
  );
});
