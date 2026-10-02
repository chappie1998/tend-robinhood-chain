import { createPublicClient, http, getAddress } from "viem";
import fs from "node:fs";

const m = JSON.parse(fs.readFileSync(new URL("../deployments/monad-testnet.json", import.meta.url)));
const c = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });
const F = getAddress(m.contracts.tendSeriesFactory);
const V = getAddress(m.contracts.tendPoolVault);

// seededSeries is an array — one entry per configured market
// (config/markets.ts), in config order (BTC first, then ETH). Verify every
// entry, not just the first.
const seededSeries = m.seededSeries ?? [];
if (seededSeries.length === 0) {
  console.log("No seededSeries entries in the manifest — nothing to verify.");
  process.exit(1);
}

const boolAbi = (name, inType) => [{ type: "function", name, inputs: [{ type: inType }], outputs: [{ type: "bool" }], stateMutability: "view" }];
const totalAssets = await c.readContract({ address: V, abi: [{ type: "function", name: "totalAssets", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }], functionName: "totalAssets" });

// seriesAuth(id) -> struct {enabled, lastTradeAt}
const authAbi = [{ type: "function", name: "seriesAuth", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool", name: "enabled" }, { type: "uint64", name: "lastTradeAt" }], stateMutability: "view" }];

console.log("Pool (shared across every market):");
console.log("  vault.totalAssets       :", (Number(totalAssets) / 1e6).toLocaleString(), "mUSDC", totalAssets >= 100000000000n ? "✓" : "✗");

const now = Math.floor(Date.now() / 1000);

for (const entry of seededSeries) {
  const id = entry.seriesId;
  console.log(`\n${entry.symbol ?? "(unknown symbol)"}:`);

  const seriesExists = await c.readContract({ address: F, abi: boolAbi("seriesExists", "bytes32"), functionName: "seriesExists", args: [id] });
  const isTradable = await c.readContract({ address: F, abi: boolAbi("isTradable", "bytes32"), functionName: "isTradable", args: [id] });

  let auth;
  try { auth = await c.readContract({ address: V, abi: authAbi, functionName: "seriesAuth", args: [id] }); } catch (e) { auth = ["(read failed: " + (e.shortMessage || e.message) + ")"]; }

  console.log("  seriesId                :", id);
  console.log("  factory.seriesExists    :", seriesExists, seriesExists ? "✓" : "✗");
  console.log("  factory.isTradable      :", isTradable, isTradable ? "✓ (tradable now)" : "✗ NOT tradable");
  console.log("  vault.seriesAuth(id)    :", Array.isArray(auth) ? `enabled=${auth[0]} lastTradeAt=${auth[1]}` : auth, (Array.isArray(auth) && auth[0]) ? "✓" : "");
  console.log("  expiry in               :", Math.round((entry.expiry - now) / 60), "min (must be > 0 for tradable)");
}
