// Proves the early-exit path end to end against a LIVE deployment: buy a real
// position with a signed quote, then sell it straight back at the desk's
// signed bid, asserting the chain's own state at every step.
//
// Usage:
//   npm run verify:early-exit:monad
//
// This spends testnet funds: one premium (returned, less the desk spread and
// gas) plus gas for approve + fill + close. It is the only honest way to know
// closePosition works on the deployed vault — the Solidity tests prove the
// logic, this proves the deployment.
import { network } from "hardhat";
import { formatUnits, parseEventLogs, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAndSignQuote, normalizePrivateKey } from "../quote-service/derive.js";
import { deriveAndSignCloseQuote } from "../quote-service/closeQuote.js";
import { explorerTx } from "./lib/e2e/chain.js";
import { explainRevert } from "./lib/e2e/errors.js";
import { closeQuoteTuple, poolQuoteTuple } from "./lib/e2e/quote.js";
import { readDeployManifest } from "./lib/e2e/seed-series.js";

/// Small on purpose: this is a proof, not a demo trade. The payout this buys
/// comes back from the strike ladder's price — it is never requested.
const PREMIUM_HUMAN = "10";
const TILE = 1;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  const manifest = await readDeployManifest();
  const vaultAddress = manifest.contracts.tendPoolVault as Hex;
  const factoryAddress = manifest.contracts.tendSeriesFactory as Hex;
  const tokenAddress = manifest.contracts.mockUSDC as Hex;

  // A 1h rung: long enough that the quote's own 30s window and the close that
  // follows are never racing the series' expiry.
  const seeded = (manifest.seededSeries ?? []).find((s) => s.tenorId === "1h") ?? (manifest.seededSeries ?? [])[0];
  if (!seeded) throw new Error("Manifest has no seededSeries — run `npm run bootstrap:monad` first.");
  const seriesId = seeded.seriesId as Hex;

  const connection = await network.create();
  const { viem } = connection;
  const publicClient = (await viem.getPublicClient()) as unknown as PublicClient;
  const [walletClient] = await viem.getWalletClients();
  if (!walletClient) throw new Error("No account configured — set MONAD_DEPLOYER_KEY.");
  const buyer = walletClient.account.address as Hex;

  const account = privateKeyToAccount(normalizePrivateKey(process.env.QUOTE_AUTHORITY_KEY, "QUOTE_AUTHORITY_KEY"));
  console.log(`Vault : ${vaultAddress}`);
  console.log(`Series: ${seriesId} (${seeded.symbol}/${seeded.tenorId})`);
  console.log(`Buyer : ${buyer}`);

  const token = await viem.getContractAt("MockERC20", tokenAddress);
  const vault = await viem.getContractAt("TendPoolVault", vaultAddress);
  const decimals = Number(await token.read.decimals());
  const fmt = (raw: bigint) => `${formatUnits(raw, decimals)} mUSDC`;
  const balanceBefore = (await token.read.balanceOf([buyer])) as bigint;

  // 1. A real signed quote, from the same pipeline the app uses.
  const { json: quoteJson } = await deriveAndSignQuote({
    publicClient,
    account,
    factory: factoryAddress,
    vault: vaultAddress,
    body: { seriesId, direction: "up", buyer, premium: PREMIUM_HUMAN, tile: TILE },
  });
  const quote = {
    nonce: BigInt(quoteJson.quote.nonce),
    direction: Number(quoteJson.quote.direction),
    strike: BigInt(quoteJson.quote.strike),
    width: BigInt(quoteJson.quote.width),
    premium: BigInt(quoteJson.quote.premium),
    maxPayout: BigInt(quoteJson.quote.maxPayout),
    quoteExpiry: BigInt(quoteJson.quote.quoteExpiry),
    seriesId: quoteJson.quote.seriesId,
    buyer: quoteJson.quote.buyer,
  };
  console.log(`\nQuote : premium ${fmt(quote.premium)} for max payout ${fmt(quote.maxPayout)}`);

  // 2. Approve + fill.
  const approveHash = await token.write.approve([vaultAddress, quote.premium]);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  let fillHash: Hex;
  try {
    fillHash = await vault.write.fillPoolQuote([poolQuoteTuple(quote) as unknown as never, quoteJson.signature]);
  } catch (error) {
    throw new Error(`fillPoolQuote reverted: ${explainRevert(error)}`);
  }
  const fillReceipt = await publicClient.waitForTransactionReceipt({ hash: fillHash });
  const filled = parseEventLogs({ abi: vault.abi, eventName: "PoolQuoteFilled", logs: fillReceipt.logs });
  const positionId = filled[0]?.args.positionId as bigint | undefined;
  assert(positionId !== undefined, "fill emitted no PoolQuoteFilled");
  console.log(`Fill  : position #${positionId}  ${explorerTx(fillHash)}`);

  const lockedAfterFill = (await vault.read.lockedCollateral()) as bigint;
  assert(lockedAfterFill >= quote.maxPayout, "escrow was not locked for the new position");

  // 3. The desk's bid for that exact position.
  const { json: closeJson } = await deriveAndSignCloseQuote({
    publicClient,
    account,
    factory: factoryAddress,
    vault: vaultAddress,
    body: { positionId: positionId!.toString(), seller: buyer },
  });
  const bid = BigInt(closeJson.bid);
  console.log(`Bid   : ${fmt(bid)} (model value ${fmt(BigInt(closeJson.mark))}, ${closeJson.spreadBps / 100}% spread)`);
  assert(bid > 0n, "bid must be positive");
  assert(bid <= quote.maxPayout, "bid exceeds the escrow the pool holds — the contract would reject it");

  // 4. Sell it back.
  let closeHash: Hex;
  try {
    closeHash = await vault.write.closePosition([
      closeQuoteTuple({
        nonce: BigInt(closeJson.quote.nonce),
        positionId: BigInt(closeJson.quote.positionId),
        bid: BigInt(closeJson.quote.bid),
        quoteExpiry: BigInt(closeJson.quote.quoteExpiry),
        seller: closeJson.quote.seller,
      }) as unknown as never,
      closeJson.signature,
    ]);
  } catch (error) {
    throw new Error(`closePosition reverted: ${explainRevert(error)}`);
  }
  const closeReceipt = await publicClient.waitForTransactionReceipt({ hash: closeHash });
  const closed = parseEventLogs({ abi: vault.abi, eventName: "PositionClosed", logs: closeReceipt.logs });
  assert(closed.length === 1, "close emitted no PositionClosed");
  console.log(`Close : ${explorerTx(closeHash)}`);

  // 5. What the chain says afterwards.
  const position = (await vault.read.positions([positionId!])) as readonly unknown[];
  const settledFlag = position[8] as boolean;
  const closedFlag = position[9] as boolean;
  const recordedBid = position[10] as bigint;
  assert(settledFlag && closedFlag, "position is not marked closed on-chain");
  assert(recordedBid === bid, `recorded exit price ${recordedBid} != bid ${bid}`);

  const lockedAfterClose = (await vault.read.lockedCollateral()) as bigint;
  assert(lockedAfterClose === lockedAfterFill - quote.maxPayout, "escrow was not released by the close");

  const balanceAfter = (await token.read.balanceOf([buyer])) as bigint;
  const net = balanceAfter - balanceBefore;
  console.log(`\nPaid ${fmt(quote.premium)}, received ${fmt(bid)} back — net ${net < 0n ? "-" : "+"}${fmt(net < 0n ? -net : net)}`);
  console.log(`Position #${positionId} records its exit price on-chain: ${fmt(recordedBid)}`);
  console.log("\nEarly exit verified on the live deployment.");

  await connection.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
