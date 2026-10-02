import assert from "node:assert/strict";
import test from "node:test";
import { selectChain, assertMatchingChains } from "../config/chain-selection.mjs";

test("chain selection defaults only when absent and rejects typos", () => {
  assert.equal(selectChain(undefined), "monad");
  assert.equal(selectChain("robinhood"), "robinhood");
  for (const value of ["", "Monad", "arbitrum", "robinhod"]) assert.throws(() => selectChain(value));
});
test("frontend and server must target the same chain, including defaulted values", () => {
  assert.equal(assertMatchingChains(undefined, undefined), "monad");
  assert.equal(assertMatchingChains("robinhood", "robinhood"), "robinhood");
  assert.throws(() => assertMatchingChains("robinhood", undefined));
  assert.throws(() => assertMatchingChains(undefined, "robinhood"));
});
