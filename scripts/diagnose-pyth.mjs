import { createPublicClient, http, getAddress, decodeErrorResult } from "viem";
import fs from "node:fs";

const m = JSON.parse(fs.readFileSync(new URL("../deployments/monad-testnet.json", import.meta.url)));
const PYTH = getAddress(m.pythAddress);
const feedId = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const c = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });

const hres = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&encoding=hex`).then((r) => r.json());
const updateData = ["0x" + hres.binary.data[0]];
const pubTime = hres.parsed[0].price.publish_time;
console.log("  Hermes latest publishTime:", pubTime);

// Full IPyth ABI subset + Pyth custom errors so a revert decodes.
const errors = [
  "InsufficientFee", "InvalidUpdateData", "InvalidUpdateDataSource", "PriceFeedNotFoundWithinRange",
  "NoFreshUpdate", "StalePrice", "InvalidGovernanceMessage", "InvalidWormholeVaa", "InvalidArgument",
  "InvalidGovernanceTarget", "InvalidGovernanceDataSource", "OldGovernanceMessage",
].map((name) => ({ type: "error", name, inputs: [] }));
const abi = [
  { type: "function", name: "getUpdateFee", stateMutability: "view", inputs: [{ type: "bytes[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "parsePriceFeedUpdates", stateMutability: "payable",
    inputs: [{ type: "bytes[]", name: "updateData" }, { type: "bytes32[]", name: "priceIds" }, { type: "uint64", name: "minPublishTime" }, { type: "uint64", name: "maxPublishTime" }],
    outputs: [{ type: "tuple[]", components: [
      { type: "bytes32", name: "id" },
      { type: "tuple", name: "price", components: [{ type: "int64", name: "price" }, { type: "uint64", name: "conf" }, { type: "int32", name: "expo" }, { type: "uint256", name: "publishTime" }] },
      { type: "tuple", name: "emaPrice", components: [{ type: "int64", name: "price" }, { type: "uint64", name: "conf" }, { type: "int32", name: "expo" }, { type: "uint256", name: "publishTime" }] },
    ] }] },
  ...errors,
];

const fee = await c.readContract({ address: PYTH, abi, functionName: "getUpdateFee", args: [updateData] });
console.log("  getUpdateFee:", fee, "wei");

// Wide window so the ONLY thing tested is: can Monad's Pyth verify this Hermes update at all?
try {
  const res = await c.simulateContract({ address: PYTH, abi, functionName: "parsePriceFeedUpdates", args: [updateData, [feedId], 0n, 4000000000n], value: fee });
  const p = res.result[0];
  console.log("  parsePriceFeedUpdates SUCCEEDS ✓ — VAA verifies on Monad. price:", p.price.price.toString(), "expo:", p.price.expo, "pub:", p.price.publishTime.toString());
} catch (e) {
  // Walk the viem error tree for the raw revert hex.
  let raw;
  const seen = new Set();
  let cur = e;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const d = cur.data;
    if (typeof d === "string" && d.startsWith("0x")) { raw = d; break; }
    if (d && typeof d === "object" && typeof d.data === "string") { raw = d.data; break; }
    if (typeof cur.raw === "string" && cur.raw.startsWith("0x")) { raw = cur.raw; break; }
    cur = cur.cause;
  }
  let decoded = "(no revert data found)";
  if (raw && raw.length >= 10) {
    console.log("  revert selector:", raw.slice(0, 10));
    try { decoded = decodeErrorResult({ abi, data: raw }).errorName; } catch { decoded = "unknown (selector " + raw.slice(0, 10) + ")"; }
  }
  console.log("  parsePriceFeedUpdates REVERTS:", decoded);
  console.log("  msg:", (e.shortMessage || e.message).split("\n")[0].slice(0, 100));
}
