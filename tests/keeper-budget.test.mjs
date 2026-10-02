import assert from "node:assert/strict";
import test from "node:test";
import {
  createKeeperBudget,
  fairRungOrder,
  leastCoveredPairs,
} from "../scripts/lib/keeper-budget.ts";

test("fairRungOrder visits the nearest rung for every pair before deeper rungs", () => {
  const pairs = [
    { pair: "BTC/15m", rungs: [1, 2, 3] },
    { pair: "BTC/1h", rungs: [1, 2] },
    { pair: "ETH/15m", rungs: [1, 2, 3] },
  ];

  assert.deepEqual(
    fairRungOrder(pairs).map(({ pair, rung }) => `${pair}:${rung}`),
    ["BTC/15m:1", "BTC/1h:1", "ETH/15m:1", "BTC/15m:2", "BTC/1h:2", "ETH/15m:2", "BTC/15m:3", "ETH/15m:3"],
  );
});

test("rotating constrained runs give every pair first position", () => {
  const pairs = [
    { pair: "A", rungs: [1, 2] },
    { pair: "B", rungs: [1, 2] },
    { pair: "C", rungs: [1, 2] },
  ];
  const firstPairs = [0, 1, 2].map((start) => fairRungOrder(pairs, start)[0].pair);
  assert.deepEqual(firstPairs, ["A", "B", "C"]);
});

test("oldest or missing coverage leads the next constrained run", () => {
  const pairs = [
    { pair: "A", rungs: [1] },
    { pair: "B", rungs: [1] },
    { pair: "C", rungs: [1] },
  ];
  const expiries = new Map([["A", 300n], ["B", 100n]]);
  assert.deepEqual(leastCoveredPairs(pairs, expiries).map((pair) => pair.pair), ["C", "B", "A"]);
});

test("budget admits affordable work, defers the rest, and preserves reserve", async () => {
  let balance = 1_000n;
  const budget = createKeeperBudget({
    reserveWei: 200n,
    balance: async () => balance,
    gasPrice: async () => 2n,
  });

  const first = await budget.claim({ label: "pair A create", gasUnits: 200n });
  assert.equal(first.allowed, true);
  assert.equal(first.maxCostWei, 600n); // 50% headroom

  balance = 700n;
  const second = await budget.claim({ label: "pair A authorize", gasUnits: 200n });
  assert.equal(second.allowed, false);
  assert.match(second.reason, /reserve/);
  assert.equal(budget.snapshot().committedWei, 600n);
  assert.equal(budget.snapshot().deferred.length, 1);
});

test("dry-run reports operations without reserving balance", async () => {
  const budget = createKeeperBudget({
    reserveWei: 999n,
    dryRun: true,
    balance: async () => 0n,
    gasPrice: async () => 100n,
  });

  const result = await budget.claim({ label: "dry create", gasUnits: 500n });
  assert.equal(result.allowed, true);
  assert.equal(result.dryRun, true);
  assert.equal(budget.snapshot().committedWei, 0n);
  assert.deepEqual(budget.snapshot().deferred, []);
});

test("fresh balance and gas price are read for every live claim", async () => {
  let balanceReads = 0;
  let gasReads = 0;
  const budget = createKeeperBudget({
    reserveWei: 10n,
    balance: async () => (++balanceReads === 1 ? 1_000n : 100n),
    gasPrice: async () => (++gasReads === 1 ? 1n : 10n),
  });

  assert.equal((await budget.claim({ label: "first", gasUnits: 100n })).allowed, true);
  assert.equal((await budget.claim({ label: "second", gasUnits: 100n })).allowed, false);
  assert.equal(balanceReads, 2);
  assert.equal(gasReads, 2);
});

test("held authorization cost protects partial pair coverage", async () => {
  const budget = createKeeperBudget({
    reserveWei: 100n,
    balance: async () => 999n,
    gasPrice: async () => 1n,
  });

  assert.equal(
    (await budget.claim({ label: "seedRung A", gasUnits: 400n, holdGasUnits: 200n })).allowed,
    true,
  );
  assert.equal(budget.snapshot().heldWei, 300n);
  assert.equal((await budget.claim({ label: "seedRung B", gasUnits: 400n })).allowed, false);

  assert.equal((await budget.complete("seedRung A", 200n)).allowed, true);
  assert.equal(budget.snapshot().heldWei, 0n);
  assert.equal((await budget.claim({ label: "authorize existing", gasUnits: 200n })).allowed, true);
});
