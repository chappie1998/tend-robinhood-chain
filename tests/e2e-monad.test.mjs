import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("e2e-monad wires the chain-agnostic BTC/USD feed and stays within factory/vault bounds", async () => {
  const source = await readFile(new URL("scripts/e2e-monad.ts", root), "utf8");

  // Same chain-agnostic Hermes BTC/USD feed id used by scripts/bootstrap-monad.ts.
  assert.match(source, /0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43/);

  // Reads on-chain bounds rather than hardcoding assumptions about them.
  assert.match(source, /factory\.read\.MIN_SERIES_LEAD/);
  assert.match(source, /factory\.read\.MAX_OBSERVATION_WINDOW/);
  assert.match(source, /factory\.read\.MAX_SETTLEMENT_GRACE/);
  assert.match(source, /factory\.read\.MAX_CONFIDENCE_BPS/);
  assert.match(source, /vault\.read\.MIN_TRADE_LEAD/);

  // Never deploys — only reads the existing deploy manifest and proves the
  // live protocol against it.
  assert.doesNotMatch(source, /deployContract/);
  assert.match(source, /No manifest found at/);

  // Writes its own manifest, never the deploy script's.
  assert.match(source, /deployments\/monad-e2e\.json/);
  assert.doesNotMatch(source, /writeFile\(DEPLOY_MANIFEST_PATH/);

  // Buyer key handling: persisted, reused, never logged.
  assert.match(source, /loadOrCreateBuyerWallet/);
  assert.doesNotMatch(source, /console\.log\([^)]*privateKey/i);

  // The full lifecycle is present: sign, verify locally, fill, wait, publish, settle, reconcile.
  assert.match(source, /signTypedData/);
  assert.match(source, /verifyPoolQuoteSignatureOffchain/);
  assert.match(source, /fillPoolQuote/);
  assert.match(source, /waitUntil/);
  assert.match(source, /publishSettlement/);
  assert.match(source, /settlePoolPosition/);
  assert.match(source, /calculatePayout/);
  assert.match(source, /createPublicClient/); // independent, clean-client verification
});

test("package.json exposes e2e:monad and loads .env without a dotenv dependency", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(
    pkg.scripts["e2e:monad"],
    "node --env-file=.env node_modules/.bin/hardhat run scripts/e2e-monad.ts --network monadTestnet",
  );
});

test(".devnet (buyer key persistence) is gitignored", async () => {
  const gitignore = await readFile(new URL(".gitignore", root), "utf8");
  assert.match(gitignore, /\/\.devnet\//);
});

test("buyer-wallet helper never writes the key file world/group readable", async () => {
  const source = await readFile(new URL("scripts/lib/e2e/buyer-wallet.ts", root), "utf8");
  assert.match(source, /0o600/);
});

test("EIP-712 PoolQuote types mirror POOL_QUOTE_TYPEHASH's exact field order", async () => {
  const [quoteSource, vaultSource] = await Promise.all([
    readFile(new URL("scripts/lib/e2e/quote.ts", root), "utf8"),
    readFile(new URL("contracts/TendPoolVault.sol", root), "utf8"),
  ]);

  const typehashMatch = vaultSource.match(/POOL_QUOTE_TYPEHASH = keccak256\(\s*"PoolQuote\(([^)]*)\)"/);
  assert.ok(typehashMatch, "could not find POOL_QUOTE_TYPEHASH in TendPoolVault.sol");
  const fieldNames = typehashMatch[1].split(",").map((field) => field.trim().split(" ")[1]);

  const typesMatch = quoteSource.match(/PoolQuote: \[([\s\S]*?)\],\s*\n\}/);
  assert.ok(typesMatch, "could not find POOL_QUOTE_TYPES in scripts/lib/e2e/quote.ts");
  const scriptFieldNames = [...typesMatch[1].matchAll(/name:\s*"(\w+)"/g)].map((m) => m[1]);

  assert.deepEqual(scriptFieldNames, fieldNames);
});
