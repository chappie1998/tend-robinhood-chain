import { createPublicClient, http, getAddress, decodeErrorResult, parseAbi } from "viem";
import fs from "node:fs";

const m = JSON.parse(fs.readFileSync(new URL("../deployments/monad-testnet.json", import.meta.url)));
const e2e = { pythFeedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" };
const F = getAddress(m.contracts.tendSeriesFactory);
const PYTH = getAddress(m.pythAddress);
const seriesId = "0xe8ce8e6bfe1444faaa2ce50b6026047b0be2c7c25c0d479a8dfdd35d1c7bb6d9";
const c = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });

// series timing
const seriesAbi = parseAbi(["function getSeries(bytes32) view returns (address creator, bytes32 pythFeedId, address settlementToken, uint64 expiry, uint32 observationWindow, uint32 settlementGrace, uint16 maxConfidenceBps, bytes32 symbol, bool enabled)"]);
let series;
try { series = await c.readContract({ address: F, abi: seriesAbi, functionName: "getSeries", args: [seriesId] }); } catch (e) { console.log("getSeries shape differs:", e.shortMessage); }
const blk = await c.getBlock();
const now = Number(blk.timestamp);
if (series) {
  const expiry = Number(series[3]), ow = Number(series[4]), grace = Number(series[5]);
  console.log(`  expiry=${expiry} observationEnd=${expiry + ow} settlementDeadline=${expiry + ow + grace}`);
  console.log(`  chain now=${now}  -> observation window ${now <= expiry + ow ? "OPEN" : "CLOSED (publish needs publishTime in [expiry, observationEnd])"}, past deadline: ${now > expiry + ow + grace}`);
}

// fetch fresh Hermes update + fee
const feedId = e2e.pythFeedId || "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const hres = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&encoding=hex`).then(r => r.json());
const updateData = ["0x" + hres.binary.data[0]];
const pubTime = hres.parsed[0].price.publish_time;
console.log(`  Hermes latest publishTime=${pubTime}`);

const pythAbi = parseAbi([
  "function getUpdateFee(bytes[] updateData) view returns (uint256)",
  // Pyth custom errors (IPythEvents/PythErrors) so we can decode the revert:
  "error InsufficientFee()",
  "error InvalidUpdateData()",
  "error InvalidUpdateDataSource()",
  "error PriceFeedNotFoundWithinRange()",
  "error NoFreshUpdate()",
  "error StalePrice()",
  "error InvalidGovernanceMessage()",
  "error InvalidWormholeVaa()",
  "error InvalidArgument()",
]);
let fee;
try { fee = await c.readContract({ address: PYTH, abi: pythAbi, functionName: "getUpdateFee", args: [updateData] }); console.log(`  getUpdateFee = ${fee} wei`); } catch (e) { console.log("  getUpdateFee failed:", e.shortMessage); }

// Simulate publishSettlement raw and decode the revert reason
const factoryErrAbi = parseAbi([
  "function publishSettlement(bytes32 seriesId, bytes[] updateData) payable returns (uint256)",
  "error SeriesNotFound()", "error AlreadyFinalized()", "error SeriesNotExpired()", "error SettlementWindowClosed()",
  "error InsufficientFee()", "error InvalidOraclePrice()", "error InvalidObservationTime()", "error OracleConfidenceTooWide()", "error RefundFailed()",
  ...pythAbi,
]);
try {
  await c.simulateContract({ address: F, abi: factoryErrAbi, functionName: "publishSettlement", args: [seriesId, updateData], value: fee ?? 0n, account: getAddress(m.deployer) });
  console.log("  SIMULATE: publishSettlement would SUCCEED now");
} catch (e) {
  const data = e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data;
  let decoded = "(no revert data — pre-execution or window/fee guard)";
  if (data && data !== "0x") {
    try { const r = decodeErrorResult({ abi: factoryErrAbi, data }); decoded = r.errorName + (r.args?.length ? "(" + r.args.join(",") + ")" : "()"); } catch { decoded = "unknown selector " + data.slice(0, 10); }
  }
  console.log("  SIMULATE REVERT:", decoded);
  console.log("  (raw:", (e.shortMessage || e.message).slice(0, 100) + ")");
}
