import assert from "node:assert/strict";
import test from "node:test";
import { inspectOracle, loadLocalMockPythRuntimeCode, LocalMockPythArtifactError, runtimeCodeHash } from "../scripts/lib/oracle-inventory.ts";

const factory = "0x1111111111111111111111111111111111111111";
const oracle = "0x2222222222222222222222222222222222222222";
const otherOracle = "0x3333333333333333333333333333333333333333";
const localRuntime = "0x6001600055";
const manifest = { chainId: 10143, contracts: { tendSeriesFactory: factory }, pythAddress: oracle };

function client(overrides = {}) {
  return {
    chain: { id: 10143 },
    getChainId: async () => 10143,
    readContract: async () => oracle,
    getCode: async () => localRuntime,
    ...overrides,
  };
}

test("exact local DeployableMockPyth runtime is identified as demo-only", async () => {
  const inventory = await inspectOracle(client(), manifest, localRuntime);
  assert.equal(inventory.oracleType, "exact-demo-mock-pyth");
  assert.equal(inventory.wiringVerified, true);
  assert.equal(inventory.authenticatedSettlementVerified, false);
  assert.equal(inventory.runtimeCodeHash, runtimeCodeHash(localRuntime));
});

test("different runtime code remains unknown and never authenticates settlement", async () => {
  const inventory = await inspectOracle(client({ getCode: async () => "0x6002600055" }), manifest, localRuntime);
  assert.equal(inventory.oracleType, "unknown-oracle-unverified");
  assert.equal(inventory.authenticatedSettlementVerified, false);
});

test("zero code, factory wiring mismatch, and chain mismatch fail closed", async () => {
  const missingCode = await inspectOracle(client({ getCode: async () => "0x" }), manifest, localRuntime);
  assert.equal(missingCode.oracleType, "no-runtime-code");

  const wrongOracle = await inspectOracle(client({ readContract: async () => otherOracle }), manifest, localRuntime);
  assert.equal(wrongOracle.oracleType, "manifest-oracle-mismatch");
  assert.equal(wrongOracle.wiringVerified, false);

  const wrongChain = await inspectOracle(client({ getChainId: async () => 1 }), manifest, localRuntime);
  assert.equal(wrongChain.oracleType, "manifest-oracle-mismatch");
  assert.equal(wrongChain.wiringVerified, false);
});

test("missing local MockPyth artifact fails clearly before any oracle can be verified", async () => {
  await assert.rejects(
    loadLocalMockPythRuntimeCode(new URL("file:///private/tmp/tend-missing-DeployableMockPyth.json")),
    (error) => error instanceof LocalMockPythArtifactError && /npx hardhat compile/.test(error.message),
  );
});

test("exact TendPriceOracle runtime is identified as admin-posted, never authenticated", async () => {
  const adminRuntime = "0x6001600155";
  const inventory = await inspectOracle(client({ getCode: async () => adminRuntime }), manifest, localRuntime, adminRuntime);
  assert.equal(inventory.oracleType, "exact-admin-price-oracle");
  assert.equal(inventory.runtimeCodeHash, runtimeCodeHash(adminRuntime));
  assert.equal(inventory.authenticatedSettlementVerified, false);
});

test("an admin-oracle artifact that does not match stays unknown", async () => {
  const inventory = await inspectOracle(client({ getCode: async () => "0x6002600055" }), manifest, localRuntime, "0x6001600155");
  assert.equal(inventory.oracleType, "unknown-oracle-unverified");
});
