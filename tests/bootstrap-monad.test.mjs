import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("bootstrap-monad wires the Pyth feeds and stays within factory/vault bounds", async () => {
  const source = await readFile(new URL("scripts/bootstrap-monad.ts", root), "utf8");
  // The feed ids and the series bounds moved OUT of bootstrap-monad.ts: feeds
  // to config/markets.ts when multi-market (BTC + ETH) support landed, bounds
  // to scripts/lib/e2e/seed-series.ts so the seeder and the keeper cannot
  // drift. Assert against those real sources rather than re-grepping a script
  // that no longer declares them — the previous version of this test kept
  // greping bootstrap-monad.ts and failed the moment the constants moved,
  // which is a stale test rather than a real regression.
  const markets = await readFile(new URL("config/markets.ts", root), "utf8");
  const seed = await readFile(new URL("scripts/lib/e2e/seed-series.ts", root), "utf8");

  // Chain-agnostic Hermes feed ids — only the IPyth receiver address is Monad-specific.
  assert.match(markets, /0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43/);
  assert.match(markets, /0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace/);

  // Series bounds: TendSeriesFactory enforces MIN_SERIES_LEAD = 15 min,
  // MAX_OBSERVATION_WINDOW = 1h, MAX_SETTLEMENT_GRACE = 24h, MAX_CONFIDENCE_BPS = 2000.
  assert.match(seed, /OBSERVATION_WINDOW_SECONDS = 60/);
  assert.match(seed, /MAX_CONFIDENCE_BPS = 500/);

  // Trader-chosen tenors + the ladder that keeps each one actually fillable
  // between unpredictable keeper runs (see the TENORS comment in seed-series.ts
  // for the measured cadence and the ladder-sizing arithmetic). Three tenors,
  // each with its own lead time and ladder depth — asserting the concrete
  // numbers here catches "simplified back to one series per tenor" regressions.
  assert.match(seed, /id: "15m".*leadSeconds: 15n \* 60n.*ladderSize: 20/);
  assert.match(seed, /id: "1h".*leadSeconds: 60n \* 60n.*ladderSize: 5/);
  assert.match(seed, /id: "12h".*leadSeconds: 12n \* 60n \* 60n.*ladderSize: 1/);

  // Pool authorization bound: TendPoolVault enforces MIN_TRADE_LEAD = 15 min
  // and lastTradeAt < series.expiry.
  assert.match(seed, /MIN_TRADE_LEAD_SECONDS = 15n \* 60n/);

  // Idempotency: reuses an existing series/deposit/authorization rather than
  // re-sending transactions or overwriting prior tx hashes with null. This
  // logic lives in the shared seeder, which bootstrap-monad.ts and the keeper
  // both call — asserting it here rather than in the thin script wrapper is
  // what keeps this test meaningful instead of merely green.
  assert.match(seed, /seriesExists/);
  assert.match(seed, /exists — reusing/);
  assert.match(seed, /already holds >= target/);
  assert.match(seed, /already authorized \(lastTradeAt=/);

  // Never deploys — only reads the existing manifest and seeds against it.
  // The manifest guard moved into the shared seeder alongside the rest of the
  // reusable logic; the "never deploys" half still belongs on the script,
  // since that is the file a careless edit would add a deploy call to.
  assert.match(seed, /No manifest found at/);
  assert.doesNotMatch(source, /deployContract/);
});

test("package.json exposes bootstrap:monad and loads .env without a dotenv dependency", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(
    pkg.scripts["bootstrap:monad"],
    "node --env-file=.env node_modules/.bin/hardhat run scripts/bootstrap-monad.ts --network monadTestnet",
  );
});
