// Network-free unit tests for the shared sliding-window rate limiter
// (quote-service/rateLimit.ts) used by both api/quote.ts (IP-keyed) and
// quote-service/server.ts (buyer-keyed).
import assert from "node:assert/strict";
import test from "node:test";

const { createRateLimiter, clientIpFromHeaders } = await import(
  new URL("../quote-service/rateLimit.ts", import.meta.url)
);

test("createRateLimiter allows up to maxPerKey hits for one key, then rejects", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxPerKey: 3, maxTotal: 100 });
  assert.equal(limiter.check("1.2.3.4"), true);
  assert.equal(limiter.check("1.2.3.4"), true);
  assert.equal(limiter.check("1.2.3.4"), true);
  assert.equal(limiter.check("1.2.3.4"), false, "4th hit within the window must be rejected");
});

test("createRateLimiter keeps distinct keys independent, up to maxPerKey each", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxPerKey: 2, maxTotal: 100 });
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("a"), false);
  // A different key is unaffected by "a" having exhausted its own budget.
  assert.equal(limiter.check("b"), true);
  assert.equal(limiter.check("b"), true);
  assert.equal(limiter.check("b"), false);
});

test("createRateLimiter enforces maxTotal across all keys combined, even when no single key is over its own limit", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxPerKey: 100, maxTotal: 3 });
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("b"), true);
  assert.equal(limiter.check("c"), true);
  // Each of a/b/c is well under maxPerKey (100), but the coarse global cap (3) is now spent.
  assert.equal(limiter.check("d"), false);
  assert.equal(limiter.check("a"), false);
});

test("createRateLimiter's sliding window forgets hits once they age past windowMs", async () => {
  const limiter = createRateLimiter({ windowMs: 30, maxPerKey: 1, maxTotal: 100 });
  assert.equal(limiter.check("x"), true);
  assert.equal(limiter.check("x"), false, "still within the 30ms window");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(limiter.check("x"), true, "window has elapsed — the old hit must no longer count");
});

test("clientIpFromHeaders takes the first hop of X-Forwarded-For", () => {
  assert.equal(clientIpFromHeaders({ "x-forwarded-for": "203.0.113.5, 70.41.3.18, 150.172.238.178" }), "203.0.113.5");
  assert.equal(clientIpFromHeaders({ "x-forwarded-for": "203.0.113.5" }), "203.0.113.5");
});

test("clientIpFromHeaders falls back to a shared 'unknown' bucket when the header is absent", () => {
  assert.equal(clientIpFromHeaders({}), "unknown");
  assert.equal(clientIpFromHeaders({ "x-forwarded-for": "" }), "unknown");
});

test("clientIpFromHeaders takes the array form's first entry (Node may present a repeated header as an array)", () => {
  assert.equal(clientIpFromHeaders({ "x-forwarded-for": ["203.0.113.5", "70.41.3.18"] }), "203.0.113.5");
});
