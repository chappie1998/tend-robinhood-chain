import assert from "node:assert/strict";
import test from "node:test";
import { explorerTx } from "../scripts/lib/e2e/chain.ts";

test("keeper receipt links follow the actual client chain", () => {
  assert.equal(explorerTx("0xabc", 46630), "https://explorer.testnet.chain.robinhood.com/tx/0xabc");
  assert.equal(explorerTx("0xabc", 10143), "https://testnet.monadscan.com/tx/0xabc");
  assert.equal(explorerTx("0xabc", 31337), "0xabc");
});
