import { createPublicClient, http, getAddress } from "viem";
import fs from "node:fs";

const m = JSON.parse(fs.readFileSync(new URL("../deployments/monad-testnet.json", import.meta.url)));
const c = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });
const F = getAddress(m.contracts.tendSeriesFactory);
const V = getAddress(m.contracts.tendPoolVault);
const U = getAddress(m.contracts.mockUSDC);
const D = getAddress(m.deployer);

for (const [n, a] of [["factory", F], ["vault", V], ["mUSDC", U]]) {
  const code = await c.getBytecode({ address: a });
  console.log(`  ${n} code: ${code && code.length > 2 ? "present (" + (code.length - 2) / 2 + " bytes)" : "MISSING"}`);
}

const call = (address, name, outType, args = []) => {
  const inputs = args.length ? [{ type: "address" }] : [];
  const abi = [{ type: "function", name, inputs, outputs: [{ type: outType }], stateMutability: "view" }];
  return c.readContract({ address, abi, functionName: name, args });
};
const eq = (a, b) => getAddress(a) === getAddress(b);

console.log("  factory.owner        ==", eq(await call(F, "owner", "address"), D) ? "deployer ✓" : "MISMATCH ✗");
const pyth = await call(F, "pyth", "address");
console.log("  factory.pyth         ==", pyth, eq(pyth, "0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379") ? "(Monad Pyth ✓)" : "MISMATCH ✗");
console.log("  vault.asset          ==", eq(await call(V, "asset", "address"), U) ? "mUSDC ✓" : "MISMATCH ✗");
console.log("  vault.manager        ==", eq(await call(V, "manager", "address"), D) ? "deployer ✓" : "MISMATCH ✗");
console.log("  vault.quoteAuthority ==", eq(await call(V, "quoteAuthority", "address"), D) ? "deployer ✓" : "MISMATCH ✗");
console.log("  vault caps           == util", await call(V, "maxUtilizationBps", "uint16"), "| pos", await call(V, "maxPositionBps", "uint16"), "| fee", await call(V, "feeBps", "uint16"), "(expect 8000/2500/0)");
console.log("  mUSDC.decimals       ==", await call(U, "decimals", "uint8"), "(expect 6)");
console.log("  mUSDC.balanceOf(dep) ==", (await call(U, "balanceOf", "uint256", [D])).toString(), "(expect 10000000000000)");
