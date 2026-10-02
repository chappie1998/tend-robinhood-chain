/** Real testnet rehearsal against the browser's HTTP quote API.
 * Public receipts are persisted before waiting; rerunning resumes a pending fill.
 * Never use this mock-token / MockPyth flow for real collateral.
 */
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnetChain } from "./lib/e2e/chain.js";
import { loadOrCreateBuyerWallet } from "./lib/e2e/buyer-wallet.js";
import { normalizePrivateKey } from "../quote-service/derive.js";
import { tendSeriesFactoryAbi, tendPoolVaultAbi, mockErc20Abi } from "../web/src/abis/index.js";
import { createSeriesParamsFor, expiryForBucket, tenorQualifiedSymbol } from "../web/src/lib/seriesParams.js";
import { parseSignedQuoteResponse } from "../web/src/lib/quote.js";
import { fetchDemoSettlementPrice } from "../market-data/coinbase.js";
import manifest from "../deployments/monad-testnet.json" with { type: "json" };

// Read through a loose shape so this compiles against the manifest both before
// (mockPyth) and after (priceOracle) the switch to TendPriceOracle.
const oracleContracts = manifest.contracts as { mockPyth?: string; priceOracle?: string };
const oracleAddress = oracleContracts.priceOracle ?? oracleContracts.mockPyth;
if (manifest.chainId !== 10143 || !oracleAddress) throw new Error("Rehearsal requires a Monad testnet settlement oracle.");
const client = createPublicClient({ chain: monadTestnetChain, transport: http() });
if (await client.getChainId() !== 10143) throw new Error("Wrong network.");
const signer = privateKeyToAccount(normalizePrivateKey(process.env.MONAD_DEPLOYER_KEY, "MONAD_DEPLOYER_KEY"));
const operator = createWalletClient({ account: signer, chain: monadTestnetChain, transport: http() });
const buyer = await loadOrCreateBuyerWallet();
const wallet = buyer.walletClient;
const c = manifest.contracts;
const factory = { address: c.tendSeriesFactory as Hex, abi: tendSeriesFactoryAbi } as const;
const vault = { address: c.tendPoolVault as Hex, abi: tendPoolVaultAbi } as const;
const token = { address: c.mockUSDC as Hex, abi: mockErc20Abi } as const;
if ((await client.readContract({ ...factory, functionName: "pyth" })).toLowerCase() !== oracleAddress.toLowerCase()) throw new Error("Factory must use the manifest's settlement oracle.");
const origin = process.env.DEMO_ORIGIN ?? "http://localhost:5173";
const feed = manifest.seededSeries.find((s) => s.symbol === "BTC")!.pythFeedId as Hex;
const evidencePath = "docs/evidence/demo-rehearsal.json";
const MINIMUM_RUNWAY_SECONDS = 5n * 60n;
const LAST_15M_LADDER_OFFSET = -20n;
const REHEARSAL_TILE = 1;
const REHEARSAL_PAYOUT_MULTIPLE = 2n;
let proof: Record<string, unknown> = {};
try { proof = JSON.parse(await readFile(evidencePath, "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
await mkdir("docs/evidence", { recursive: true });
const save = async () => {
  await writeFile(`${evidencePath}.tmp`, JSON.stringify(proof, null, 2) + "\n");
  await rename(`${evidencePath}.tmp`, evidencePath);
};
const confirm = async (hash: Hex) => {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let resume = Boolean(proof.fillTx && proof.status !== "passed" && proof.status !== "refunded");
if (resume) {
  if (proof.buyer !== buyer.address || proof.vault !== vault.address || proof.chainId !== 10143) throw new Error("Pending evidence belongs to another wallet or deployment.");
  const receipt = await client.waitForTransactionReceipt({ hash: proof.fillTx as Hex });
  if (receipt.status === "reverted") {
    proof.status = "fill-reverted"; await save();
    await rename(evidencePath, `docs/evidence/reverted-fill-${proof.fillTx}.json`);
    resume = false; // A reverted fill opened no position; a new rehearsal is safe.
  }
}

if (!resume) {
  const now = (await client.getBlock()).timestamp;
  let chosen: { id: Hex; expiry: bigint } | undefined;
  // Offset +2 is the nearest seeded rung; decreasing offsets move forward
  // through the keeper's 20-rung 15-minute ladder. Stop at first usable rung.
  for (let offset = 2n; offset >= LAST_15M_LADDER_OFFSET; offset--) {
    const expiry = expiryForBucket(now, offset, 900n);
    if (expiry < now + MINIMUM_RUNWAY_SECONDS) continue;
    const params = createSeriesParamsFor({ symbol: tenorQualifiedSymbol("BTC", "15m"), pythFeedId: feed }, token.address, expiry);
    const id = await client.readContract({ ...factory, functionName: "deriveSeriesId", args: [params] });
    const [tradable, auth] = await Promise.all([
      client.readContract({ ...factory, functionName: "isTradable", args: [id] }),
      client.readContract({ ...vault, functionName: "seriesAuth", args: [id] }),
    ]);
    if (tradable && auth[0] && auth[1] > now + MINIMUM_RUNWAY_SECONDS) { chosen = { id, expiry }; break; }
  }
  if (!chosen) throw new Error("No fresh 15m BTC series; run bootstrap:monad first.");
  console.log(`Selected nearest eligible 15m BTC series ${chosen.id}, expiry ${new Date(Number(chosen.expiry) * 1000).toISOString()}`);
  proof = { startedAt: new Date().toISOString(), chainId: 10143, origin, vault: vault.address, buyer: buyer.address, seriesId: chosen.id,
    expiry: new Date(Number(chosen.expiry) * 1000).toISOString(), dataSource: "Coinbase Exchange", oracle: oracleContracts.priceOracle ? "TendPriceOracle (admin-posted, testnet only)" : "MockPyth (testnet only)", status: "preparing" };
  if (await client.getBalance({ address: buyer.address }) < parseEther("0.2")) {
    await confirm(await operator.sendTransaction({ to: buyer.address, value: parseEther("0.5") }));
  }
  // The numerical strike solver may round premium slightly above 100 mUSDC.
  // Approve a bounded ceiling before requesting the short-lived quote, then
  // enforce that same ceiling on the actual signed premium before filling.
  const premiumCeiling = 110_000000n;
  if (await client.readContract({ ...token, functionName: "balanceOf", args: [buyer.address] }) < premiumCeiling) {
    await confirm(await wallet.writeContract({ ...token, functionName: "mint", args: [buyer.address, 1000_000000n], account: wallet.account!, chain: monadTestnetChain }));
  }
  proof.approveTx = await wallet.writeContract({ ...token, functionName: "approve", args: [vault.address, premiumCeiling], account: wallet.account!, chain: monadTestnetChain });
  console.log(`Approval submitted: ${proof.approveTx}`);
  await confirm(proof.approveTx as Hex);
  let response: Response | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Requesting live quote (${attempt}/3)…`);
    try {
      response = await fetch(`${origin}/api/quote`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesId: chosen.id, direction: "up", buyer: buyer.address, premium: "10", tile: REHEARSAL_TILE }),
        signal: AbortSignal.timeout(45_000),
      });
      if (response.status < 500 && response.status !== 429) break;
      if (attempt === 3) break;
      await response.body?.cancel();
    } catch (error) { if (attempt === 3) throw error; }
    await pause(2000);
  }
  if (!response) throw new Error("Live quote request failed.");
  const json = await response.json();
  if (!response.ok) throw new Error(`Quote ${response.status}: ${JSON.stringify(json)}`);
  const signed = parseSignedQuoteResponse(json);
  if (signed.quote.premium > premiumCeiling) throw new Error("Quoted premium exceeds the rehearsal's bounded approval.");
  if (signed.tile !== REHEARSAL_TILE || signed.multiple !== Number(REHEARSAL_PAYOUT_MULTIPLE)) throw new Error("Quote is not the requested tile-1 (2x) payout tier.");
  if (signed.quote.width !== 1n) throw new Error("Quote width is not exactly one raw price tick.");
  if (signed.quote.maxPayout !== signed.quote.premium * REHEARSAL_PAYOUT_MULTIPLE) throw new Error("Quote maxPayout is not exactly twice charged premium.");
  proof.premium = String(signed.quote.premium); proof.maxPayout = String(signed.quote.maxPayout);
  proof.strike = String(signed.quote.strike); proof.width = String(signed.quote.width);
  proof.tier = signed.tile; proof.payoutMultiple = signed.multiple;
  proof.binaryTermsVerified = true;
  proof.balanceBefore = String(await client.readContract({ ...token, functionName: "balanceOf", args: [buyer.address] }));
  proof.lockedBefore = String(await client.readContract({ ...vault, functionName: "lockedCollateral" }));
  const simulation = await client.simulateContract({ ...vault, functionName: "fillPoolQuote", args: [signed.quote, signed.signature], account: buyer.address });
  console.log("Live quote simulated successfully; signing the testnet fill locally.");
  // simulateContract carries a JSON-RPC account when given an address. Restore
  // the local account so writeContract signs here rather than asking the public
  // RPC to act as an unlocked wallet (wallet_sendTransaction is unsupported).
  proof.fillTx = await wallet.writeContract({ ...simulation.request, account: wallet.account!, chain: monadTestnetChain });
  proof.status = "fill-submitted";
  await save();
} else {
  if (proof.buyer !== buyer.address || proof.vault !== vault.address || proof.chainId !== 10143) throw new Error("Pending evidence belongs to another wallet or deployment.");
  console.log(`Resuming ${proof.fillTx}; no new position will be opened.`);
}

const filled = await confirm(proof.fillTx as Hex);
const event = parseEventLogs({ abi: tendPoolVaultAbi, eventName: "PoolQuoteFilled", logs: filled.logs })[0];
if (!event || event.address.toLowerCase() !== vault.address.toLowerCase() || event.args.seriesId !== proof.seriesId) throw new Error("Missing or mismatched vault fill event.");
const positionId = event.args.positionId;
proof.positionId = String(positionId); proof.fillGas = String(filled.gasUsed);
const position = await client.readContract({ ...vault, functionName: "positions", args: [positionId] });
if (position[0].toLowerCase() !== buyer.address.toLowerCase() || position[1] !== proof.seriesId) throw new Error("Position does not match rehearsal buyer / series.");
const premium = position[5]; const maxPayout = position[6];
if (position[2] !== 0 || position[4] !== 1n || maxPayout !== premium * REHEARSAL_PAYOUT_MULTIPLE) throw new Error("Filled position is not a strict binary UP 2x ticket.");
// Older interrupted runs did not retain signed terms. Recover those terms from
// the already-filled on-chain position, then checkpoint them before settlement.
if (proof.strike === undefined) proof.strike = String(position[3]);
if (proof.width === undefined) proof.width = String(position[4]);
if (proof.tier === undefined) proof.tier = REHEARSAL_TILE;
if (proof.payoutMultiple === undefined) proof.payoutMultiple = Number(REHEARSAL_PAYOUT_MULTIPLE);
if (position[3] !== BigInt(String(proof.strike)) || position[4] !== BigInt(String(proof.width)) || proof.tier !== REHEARSAL_TILE || proof.payoutMultiple !== Number(REHEARSAL_PAYOUT_MULTIPLE)) throw new Error("Filled position does not match the public signed-term proof.");
proof.binaryTermsVerified = true;
if (proof.settleTx) {
  const receipt = await client.waitForTransactionReceipt({ hash: proof.settleTx as Hex });
  if (receipt.status === "reverted") {
    const current = await client.readContract({ ...vault, functionName: "positions", args: [positionId] });
    if (current[8]) throw new Error("Reverted settlement followed by external closure; inspect external receipt.");
    proof.revertedSettleTx = proof.settleTx; delete proof.settleTx; await save();
  }
}
if (!resume) {
  const balanceAfter = await client.readContract({ ...token, functionName: "balanceOf", args: [buyer.address] });
  const lockedAfter = await client.readContract({ ...vault, functionName: "lockedCollateral" });
  if (BigInt(String(proof.balanceBefore)) - balanceAfter !== premium || lockedAfter - BigInt(String(proof.lockedBefore)) !== maxPayout) throw new Error("Fill balances do not reconcile.");
  proof.fillBalancesVerified = true;
}
proof.status = "filled"; await save(); console.log(JSON.stringify(proof));
const seriesId = proof.seriesId as Hex;
const series = await client.readContract({ ...factory, functionName: "getSeries", args: [seriesId] });
const deadline = series.expiry + BigInt(series.observationWindow) + BigInt(series.settlementGrace);
console.log("Waiting for the actual on-chain expiry; no fast-forward or simulated time.");
while ((await client.getBlock()).timestamp < series.expiry + 5n) await pause(10_000);

if (proof.publishTx) {
  const receipt = await client.waitForTransactionReceipt({ hash: proof.publishTx as Hex });
  if (receipt.status === "reverted") { proof.revertedPublishTx = proof.publishTx; delete proof.publishTx; await save(); }
}
let existing = await client.readContract({ ...factory, functionName: "getSettlement", args: [seriesId] });
if (!existing.finalized && !position[8]) {
  let price: Awaited<ReturnType<typeof fetchDemoSettlementPrice>> | undefined;
  // Wait for publication / transient upstream recovery, bounded by the real contract deadline.
  while ((await client.getBlock()).timestamp < deadline - 30n) {
    try { price = await fetchDemoSettlementPrice(series.pythFeedId, Number(series.expiry)); break; }
    catch (error) { console.log(`Settlement data pending: ${(error as Error).message}`); await pause(10_000); }
  }
  if (!price) throw new Error("Settlement data unavailable before deadline. Evidence retained: rerun to resume, or use settle:monad for the timeout refund after the deadline.");
  let updateData: Hex[] = [];
  let fee = 0n;
  if (oracleContracts.priceOracle) {
    // Admin-only oracle: post the price as admin (write-once), then settle
    // with empty update data — the factory ignores caller-supplied bytes.
    const adminAbi = parseAbi([
      "function postPrice(bytes32,int64,uint64,int32,uint64)",
      "function priceAt(bytes32,uint64) view returns((int64 price,uint64 conf,int32 expo,uint256 publishTime))",
    ]);
    const oracle = { address: oracleContracts.priceOracle as Hex, abi: adminAbi } as const;
    const posted = await client.readContract({ ...oracle, functionName: "priceAt", args: [series.pythFeedId, BigInt(price.publishTime)] });
    if (posted.price === 0n) {
      const postTx = await operator.writeContract({ ...oracle, functionName: "postPrice", args: [series.pythFeedId, price.price, 0n, -8, BigInt(price.publishTime)] });
      await confirm(postTx);
    }
  } else {
    const mockAbi = parseAbi(["function createPriceFeedUpdateData(bytes32,int64,uint64,int32,int64,uint64,uint64,uint64) view returns(bytes)", "function getUpdateFee(bytes[]) view returns(uint256)"]);
    const update = await client.readContract({ address: oracleAddress as Hex, abi: mockAbi, functionName: "createPriceFeedUpdateData", args: [series.pythFeedId, price.price, 0n, -8, price.price, 0n, BigInt(price.publishTime), 0n] });
    fee = await client.readContract({ address: oracleAddress as Hex, abi: mockAbi, functionName: "getUpdateFee", args: [[update]] });
    updateData = [update];
  }
  // Another keeper may publish while data is fetched.
  existing = await client.readContract({ ...factory, functionName: "getSettlement", args: [seriesId] });
  if (!existing.finalized) {
    proof.publishTx = await operator.writeContract({ ...factory, functionName: "publishSettlement", args: [seriesId, updateData], value: fee });
    await save(); await confirm(proof.publishTx as Hex);
  }
}
if (!proof.settleTx) {
  if (position[8]) throw new Error("Position already closed externally; inspect its settlement/refund receipt before updating evidence.");
  proof.settleTx = await wallet.writeContract({ ...vault, functionName: "settlePoolPosition", args: [positionId], account: wallet.account!, chain: monadTestnetChain });
  await save();
}
const settled = await confirm(proof.settleTx as Hex);
const result = parseEventLogs({ abi: tendPoolVaultAbi, eventName: "PositionSettled", logs: settled.logs })[0];
if (!result || result.args.positionId !== positionId || result.address.toLowerCase() !== vault.address.toLowerCase()) throw new Error("Missing settlement event.");
const finalBalance = await client.readContract({ ...token, functionName: "balanceOf", args: [buyer.address] });
if (finalBalance - BigInt(String(proof.balanceBefore)) !== result.args.payout - premium) throw new Error("Buyer final balance does not reconcile; check for intervening wallet activity.");
if (result.args.payout + result.args.poolAmount + result.args.fee !== premium + maxPayout) throw new Error("Settlement escrow conservation failed.");
const settlement = await client.readContract({ ...factory, functionName: "getSettlement", args: [seriesId] });
// MockPyth accepts arbitrary data from any publisher. Independently verify the
// finalized value even when another process published before this rehearsal.
const reference = await fetchDemoSettlementPrice(series.pythFeedId, Number(series.expiry));
if (settlement.price !== reference.price || settlement.publishTime !== BigInt(reference.publishTime)) {
  proof.status = "settled-source-mismatch"; await save();
  throw new Error("Finalized mock settlement does not match the Coinbase expiry-minute reference.");
}
const expectedPayout = settlement.price > position[3] ? maxPayout : 0n;
if (result.args.settlementPrice !== settlement.price) throw new Error("Settlement event price does not match finalized series price.");
if (result.args.payout !== expectedPayout) throw new Error("Settlement payout does not match strict UP expiry-only terms.");
proof.status = "passed"; proof.payout = String(result.args.payout); proof.settlementPrice = String(result.args.settlementPrice);
proof.settlementSourceVerified = true;
proof.settlementPublishTime = String(settlement.publishTime); proof.escrowConservationVerified = true;
proof.expiryOnlyPayoutVerified = true; proof.expectedPayout = String(expectedPayout);
proof.strictUpWin = settlement.price > position[3];
proof.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify(proof, null, 2));
