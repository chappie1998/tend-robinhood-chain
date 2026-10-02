// Network-free behavioral tests for scripts/lib/e2e/hermes.ts's fetch
// wrapper. hermes.ts has no hardhat/network-config dependency (unlike
// e2e-monad.test.mjs / bootstrap-monad.test.mjs, which only inspect source
// text because importing their subjects would require a live hardhat
// network) — it is a plain module built on the platform's own `fetch`, so
// it can be imported and exercised directly with a mocked `fetch`, the same
// approach tests/pricing.test.mjs uses for quote-service/pricing.ts.
import assert from "node:assert/strict";
import test from "node:test";

const { fetchHermesSpotPrice, normalizePythPrice } = await import(
  new URL("../scripts/lib/e2e/hermes.ts", import.meta.url)
);

const BTC_FEED_ID = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

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

test("fetchHermesSpotPrice parses a normal Hermes response (the timeout wrapper doesn't disturb the happy path)", async () => {
  await withMockedFetch(
    async () =>
      new Response(
        JSON.stringify({
          parsed: [
            {
              id: BTC_FEED_ID.slice(2),
              price: { price: "6000000000000", conf: "1500000000", expo: -8, publish_time: 1_700_000_000 },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const result = await fetchHermesSpotPrice(BTC_FEED_ID);
      assert.equal(result.price, 6_000_000_000_000n);
      assert.equal(result.conf, 1_500_000_000n);
      assert.equal(result.expo, -8);
      assert.equal(result.publishTime, 1_700_000_000);
    },
  );
});

test("fetchHermesSpotPrice maps an AbortSignal timeout to a clear, upstream-naming error (not a generic network error)", async () => {
  await withMockedFetch(
    async () => {
      // What AbortSignal.timeout(ms) actually produces on abort: a
      // DOMException-shaped rejection named "TimeoutError". A plain Error
      // with that name is enough to exercise the `err.name === "TimeoutError"`
      // branch without waiting out a real 6s timeout.
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    },
    async () => {
      await assert.rejects(
        () => fetchHermesSpotPrice(BTC_FEED_ID),
        (err) => {
          assert.match(err.message, /Hermes \(https:\/\/hermes\.pyth\.network\)/);
          assert.match(err.message, /did not respond within 6000ms/);
          return true;
        },
      );
    },
  );
});

test("fetchHermesSpotPrice maps a non-timeout fetch failure to an upstream-naming error distinct from the timeout message", async () => {
  await withMockedFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      await assert.rejects(
        () => fetchHermesSpotPrice(BTC_FEED_ID),
        (err) => {
          assert.match(err.message, /Could not reach Hermes/);
          assert.doesNotMatch(err.message, /did not respond within/);
          assert.match(err.message, /ECONNREFUSED/);
          return true;
        },
      );
    },
  );
});

test("normalizePythPrice scales a raw Pyth price to the contract's 1e8 PRICE_SCALE for a negative expo", () => {
  // 60000.00000000 USD at expo -8 (Pyth's typical BTC/USD shape) -> already
  // 1e8-scaled, so normalizePythPrice should be a no-op here.
  assert.equal(normalizePythPrice(6_000_000_000_000n, -8), 6_000_000_000_000n);
});
