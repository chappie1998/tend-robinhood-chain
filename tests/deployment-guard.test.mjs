import assert from "node:assert/strict";
import test from "node:test";
import { assertRuntimeMode, verifyDeploymentIdentity } from "../quote-service/deploymentGuard.ts";

const factory = "0x1111111111111111111111111111111111111111";
const vault = "0x2222222222222222222222222222222222222222";
const asset = "0x3333333333333333333333333333333333333333";
const oracle = "0x4444444444444444444444444444444444444444";
const authority = "0x5555555555555555555555555555555555555555";
const manifest = { chainId: 10143, contracts: { tendSeriesFactory: factory, tendPoolVault: vault, mockUSDC: asset }, pythAddress: oracle };
function client(overrides = {}) {
  return { chain: { id: 10143 }, getChainId: async () => 10143,
    readContract: async ({ functionName }) => ({ factory, asset, pyth: oracle, quoteAuthority: authority })[functionName], ...overrides };
}
test("runtime refuses production trading and unknown modes", () => {
  assert.doesNotThrow(() => assertRuntimeMode("demo"));
  assert.throws(() => assertRuntimeMode("production"), /authenticated settlement/);
  assert.throws(() => assertRuntimeMode("prod"), /TEND_MODE/);
});
test("deployment identity verifies chain and immutable wiring", async () => {
  assert.equal((await verifyDeploymentIdentity(client(), manifest)).authority, authority);
  await assert.rejects(verifyDeploymentIdentity(client({ getChainId: async () => 1 }), manifest), /chain/);
  for (const changed of ["factory", "asset", "pyth"]) {
    const rpc = client();
    const read = rpc.readContract;
    rpc.readContract = async (request) => request.functionName === changed ? vault : read(request);
    await assert.rejects(verifyDeploymentIdentity(rpc, manifest), /does not match/);
  }
});
test("identity does not retain stale authorization or swallow RPC failures", async () => {
  const rpc = client();
  assert.equal((await verifyDeploymentIdentity(rpc, manifest)).authority, authority);
  const read = rpc.readContract;
  rpc.readContract = async (request) => request.functionName === "quoteAuthority" ? asset : read(request);
  assert.equal((await verifyDeploymentIdentity(rpc, manifest)).authority, asset);
  rpc.getChainId = async () => { throw new Error("unavailable"); };
  await assert.rejects(verifyDeploymentIdentity(rpc, manifest), /unavailable/);
});
