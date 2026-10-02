// PROOF: TendSeriesFactory.publishSettlement against Pyth's REAL canonical
// EVM receiver — real Wormhole VAA verification and a real update fee,
// exercised here for the first time anywhere in this repo. Every other
// test and every live Monad testnet settlement
// (contracts/TendSeriesFactory.t.sol, scripts/e2e-monad.ts,
// scripts/keeper-monad.ts, scripts/settle-monad-position.ts) runs against
// MockPyth, because Monad testnet's own canonical receiver reverts
// `InvalidWormholeVaa` (see scripts/diagnose-pyth.mjs and the header
// comment in scripts/e2e-monad.ts) — a stale on-chain Wormhole guardian
// set, not a bug in this codebase. On mainnet, `parsePriceFeedUpdates`'s
// real signature-verification path would run for the very first time with
// real money on the line. This script forks Base mainnet (a chain whose
// canonical receiver DOES work — verified below and in config/base-fork.ts)
// to run that path first, deliberately, against a throwaway deployment and
// real Hermes data.
//
// Usage:
//   npm run test:pyth-fork
//   (equivalent to: node_modules/.bin/hardhat run scripts/pyth-fork-settlement.ts)
//
// This is NOT part of `npm run test:contracts` (the offline forge-std
// suite) or `npm run check` — it needs live network access to a public
// Base RPC and to Hermes, so it must not make the default suite flaky.
// Run it on demand; see README-monad.md for more.
//
// --- Finding from running this against the real receiver ----------------
// `TendSeriesFactory.InvalidObservationTime` (contracts/TendSeriesFactory.sol)
// appears to be UNREACHABLE dead code. The factory calls
// `pyth.parsePriceFeedUpdates(updateData, priceIds, uint64(series.expiry),
// uint64(observationEnd))` — Pyth's own `minPublishTime`/`maxPublishTime`
// bounds — and Pyth's implementation enforces that bound itself, reverting
// with ITS OWN `PriceFeedNotFoundWithinRange` (selector 0x45805f5d) before
// ever returning a price back to the factory. This is true of BOTH the
// real canonical receiver (confirmed empirically the first time this
// script ran) AND MockPyth (confirmed by reading
// `@pythnetwork/pyth-sdk-solidity/MockPyth.sol`'s own
// `parsePriceFeedUpdatesWithConfig`, which carries the identical
// `minAllowedPublishTime <= publishTime <= maxAllowedPublishTime` guard) —
// so this is not a MockPyth-vs-real-receiver discrepancy at all. It was
// simply never caught before, because no test anywhere in this repo
// (contracts/TendSeriesFactory.t.sol included) had ever sent an
// out-of-window publishTime through `publishSettlement`. See the
// `expectRevert(...)` calls for the LATE/EARLY series below, which assert
// `PriceFeedNotFoundWithinRange` — the reason actually observed — rather
// than `InvalidObservationTime`.
//
// --- The timing trick ---------------------------------------------------
// Hardhat 3's `edr-simulated` network forks Base at a PINNED historical
// block (config/base-fork.ts) and — verified directly against this exact
// setup before writing this file — the forked chain's clock STARTS at that
// block's own timestamp and only advances when this script mines a block;
// it does not jump to the real wall-clock "now". That means a series can
// be created with an `expiry` shortly after the fork block's own
// timestamp, and Hermes' historical endpoint can then serve a REAL VAA
// whose publishTime falls inside `[expiry, expiry + observationWindow]` —
// even though, in real wall-clock time, that whole window is hours in the
// past by the time this script actually runs.
//
// One Hermes fetch buys four series' worth of assertions: the same real
// update bytes and publishTime are reused across all of them, varying only
// each series' own `expiry`/`observationWindow` so the SAME real VAA lands
// inside one series' window (the happy path) and outside three others'
// (the negative cases), instead of making four separate live Hermes calls.
//
// --- The cherry-picking fix (MAX_PUBLISH_TIME_SLACK) --------------------
// `publishSettlement` used to accept ANY tick with publishTime anywhere in
// [expiry, expiry+observationWindow] and finalize on it permanently. Pyth
// bounds publishTime but not freshness against block.timestamp, and signed
// VAAs stay submittable indefinitely, so whoever called publishSettlement
// first could choose the settlement price out of the entire window (up to
// 1 hour at MAX_OBSERVATION_WINDOW) -- a real, measured drain on LP capital.
//
// The intended fix was Pyth's TWAP: `parseTwapPriceFeedUpdates` makes the
// settlement price a deterministic function of the window instead of a pick
// from within it, which removes selection entirely rather than merely
// shrinking it. That was verified NOT viable here: Hermes has deprecated its
// historical TWAP-update endpoint --
//   curl https://hermes.pyth.network/v2/updates/twap/60/latest?ids[]=...
//   -> "The TWAP endpoint has been deprecated and is no longer available."
// (confirmed live against the production service; also absent from Hermes'
// current OpenAPI spec and docs, which only list
// /v2/updates/price/{latest,stream,{publish_time}}). So the fallback
// documented alongside the vulnerability was implemented instead:
// `TendSeriesFactory.MAX_PUBLISH_TIME_SLACK`, a fixed 15-second cap
// (independent of, and never wider than, a series' own observationWindow)
// on how far past `expiry` an accepted publishTime may be.
//
// The fifth series created below ("CHERRY") proves that fix against the
// REAL receiver: it shares OK's `expiry` and its wide (300s) declared
// `observationWindow`, but is settled with a SEPARATE real historical VAA
// whose publishTime sits well inside that 300s window yet past the 15s
// slack -- i.e. a tick that the PRE-FIX contract would have accepted (and a
// racer could have cherry-picked) and that the POST-FIX contract now
// rejects, using real Wormhole signature verification the whole way.
import { network } from "hardhat";
import { type Hex, stringToHex } from "viem";
import { BASE_FORK } from "../config/base-fork.js";
import { explainRevert } from "./lib/e2e/errors.js";
import { normalizePythPrice } from "./lib/e2e/hermes.js";
import { matchPythErrorSelector } from "./lib/e2e/pyth-errors.js";

const BTC_USD_PYTH_FEED_ID: Hex = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const HERMES_BASE_URL = "https://hermes.pyth.network";

// Series terms shared by every series this script creates unless noted.
const OBSERVATION_WINDOW_STANDARD = 300; // 5 minutes
const OBSERVATION_WINDOW_SHORT = 60; // deliberately short — closes before the fetched VAA's publishTime
const SETTLEMENT_GRACE_SECONDS = 3_600; // 1 hour
const MAX_CONFIDENCE_BPS = 2_000; // 20% — generous; real BTC/USD confidence is ~0.03% of price

// How far past the fork block's own timestamp each series' `expiry` sits.
// Built via BigInt() calls rather than `n`-suffixed literals so this file
// type-checks under the repo's ES2017 tsconfig target (see scripts/deploy.ts).
const LEAD_OK_SECONDS = BigInt(1_200); // 20 minutes — the happy-path / fee / already-finalized series
const LEAD_LATE_SECONDS = BigInt(960); // 16 minutes — just past MIN_SERIES_LEAD (15 min); its short window closes before the VAA's publishTime
const EARLY_EXTRA_SECONDS = BigInt(3_600); // pushes a 4th series' expiry an hour further out, so the SAME VAA is "too early" for it
const SETTLE_JUMP_BUFFER_SECONDS = BigInt(30); // how far past `expiry` the chain's clock is set before attempting to settle

// Requested at `expiryOk` itself (offset 0): Hermes' historical endpoint
// returns "the first update whose publish_time is >= the provided value"
// (its own OpenAPI description), so requesting the earliest possible instant
// gives the returned tick the most possible room to still land inside
// MAX_PUBLISH_TIME_SLACK before this script has to fail loudly instead of
// silently accepting a false pass.
const HERMES_TARGET_OFFSET_SECONDS = BigInt(0);
// How far PAST MAX_PUBLISH_TIME_SLACK to target the CHERRY series' VAA.
// Because Hermes guarantees the returned publishTime is >= the requested
// timestamp, targeting strictly past the slack boundary deterministically
// guarantees the returned tick is also past it -- independent of how dense
// Hermes' actual historical update cadence is at this fork block.
const CHERRY_PAST_SLACK_BUFFER_SECONDS = BigInt(30);

interface SeriesParams {
  pythFeedId: Hex;
  settlementToken: Hex;
  expiry: bigint;
  observationWindow: number;
  settlementGrace: number;
  maxConfidenceBps: number;
  symbol: Hex;
}

interface HermesHistoricalUpdate {
  updateHex: Hex;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
}

async function fetchHermesHistorical(feedId: Hex, unixTimestamp: bigint): Promise<HermesHistoricalUpdate> {
  const url = new URL(`/v2/updates/price/${unixTimestamp.toString()}`, HERMES_BASE_URL);
  url.searchParams.append("ids[]", feedId);
  url.searchParams.append("encoding", "hex");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hermes historical request failed (${response.status} ${response.statusText}) for ${url.toString()}`);
  }
  const body = (await response.json()) as {
    binary?: { data?: string[] };
    parsed?: Array<{ price: { price: string; conf: string; expo: number; publish_time: number } }>;
  };
  const updateData = body.binary?.data?.[0];
  const parsed = body.parsed?.[0];
  if (updateData === undefined || parsed === undefined) {
    throw new Error(`Hermes returned no historical update for feed ${feedId} at unix ${unixTimestamp}`);
  }
  return {
    updateHex: `0x${updateData}` as Hex,
    price: BigInt(parsed.price.price),
    conf: BigInt(parsed.price.conf),
    expo: parsed.price.expo,
    publishTime: BigInt(parsed.price.publish_time),
  };
}

/// Runs `fn`, asserts it reverts, and asserts the revert reason contains
/// `expectedReason` (a factory custom-error name, or a raw Pyth error name
/// recovered via `matchPythErrorSelector`). Throws loudly — rather than
/// swallowing the mismatch — if the call either succeeds or reverts for a
/// DIFFERENT reason than expected: a mismatch here is exactly the kind of
/// "the real receiver disagrees with what MockPyth would have allowed"
/// finding this script exists to surface.
async function expectRevert(label: string, expectedReason: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pythReason = matchPythErrorSelector(message);
    const reason = pythReason ?? message;
    if (!reason.includes(expectedReason)) {
      throw new Error(
        `[MISMATCH] "${label}" reverted, but NOT with the expected "${expectedReason}".\n` +
          `  Got instead: ${explainRevert(error)}\n` +
          `  Raw message: ${message.slice(0, 300)}`,
      );
    }
    console.log(`  [OK] ${label}\n       -> reverted with ${expectedReason}, as expected.`);
    return;
  }
  throw new Error(`[MISMATCH] expected "${label}" to revert with ${expectedReason}, but the call SUCCEEDED.`);
}

const IPYTH_MIN_ABI = [
  {
    type: "function",
    name: "getUpdateFee",
    stateMutability: "view",
    inputs: [{ type: "bytes[]" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getPriceUnsafe",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { type: "int64", name: "price" },
          { type: "uint64", name: "conf" },
          { type: "int32", name: "expo" },
          { type: "uint256", name: "publishTime" },
        ],
      },
    ],
  },
] as const;

async function main() {
  console.log("=".repeat(78));
  console.log("Pyth REAL-receiver fork proof -- TendSeriesFactory.publishSettlement");
  console.log("=".repeat(78));

  const connection = await network.connect("baseFork");
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployerClient] = await viem.getWalletClients();
  if (deployerClient === undefined) throw new Error("No test account available on baseFork.");
  const deployer = deployerClient.account.address;
  const deployerBalance = await publicClient.getBalance({ address: deployer });

  console.log(`Fork network: ${BASE_FORK.name} (chainId ${BASE_FORK.chainId}), RPC ${BASE_FORK.rpcUrl}`);
  console.log(`Pinned fork block: ${BASE_FORK.blockNumber}`);
  console.log(`Deployer/publisher: ${deployer} (balance ${deployerBalance} wei)`);

  // --- Step 1: verify the receiver ON THE FORK -- not from memory or docs ---
  const forkBlock = await publicClient.getBlock();
  console.log(
    `\nFork chain head right after connecting: block ${forkBlock.number}, timestamp ${forkBlock.timestamp} ` +
      `(${new Date(Number(forkBlock.timestamp) * 1000).toISOString()})`,
  );
  if (forkBlock.number !== BigInt(BASE_FORK.blockNumber)) {
    throw new Error(`Expected to be forked at block ${BASE_FORK.blockNumber}, but head is ${forkBlock.number}.`);
  }

  const pythAddress = BASE_FORK.pythAddress as Hex;
  const receiverCode = await publicClient.getCode({ address: pythAddress });
  if (receiverCode === undefined || receiverCode === "0x") {
    throw new Error(`No bytecode at ${pythAddress} on the fork -- this is not a live receiver.`);
  }
  console.log(`Receiver bytecode size on fork: ${(receiverCode.length - 2) / 2} bytes`);

  const emptyFee = await publicClient.readContract({
    address: pythAddress,
    abi: IPYTH_MIN_ABI,
    functionName: "getUpdateFee",
    args: [[]],
  });
  console.log(`getUpdateFee([]) on fork responds: ${emptyFee} wei (receiver is live and callable)`);

  const storedBtcPrice = await publicClient.readContract({
    address: pythAddress,
    abi: IPYTH_MIN_ABI,
    functionName: "getPriceUnsafe",
    args: [BTC_USD_PYTH_FEED_ID],
  });
  const storedExpo = Number(storedBtcPrice.expo);
  console.log(
    `getPriceUnsafe(BTC/USD) on fork: price=${storedBtcPrice.price} expo=${storedExpo} ` +
      `(~$${(Number(storedBtcPrice.price) * 10 ** storedExpo).toFixed(2)}) ` +
      `publishTime=${storedBtcPrice.publishTime} (${new Date(Number(storedBtcPrice.publishTime) * 1000).toISOString()})`,
  );
  console.log("  -> confirms this is genuinely Pyth's live BTC/USD feed, not just any contract at this address.\n");

  // --- Step 2: deploy the factory pointed at the REAL receiver ---
  const factory = await viem.deployContract("TendSeriesFactory", [deployer, deployer, pythAddress]);
  console.log(`TendSeriesFactory deployed at ${factory.address}, pyth=${await factory.read.pyth()}`);

  const minLead = await factory.read.MIN_SERIES_LEAD();
  if (LEAD_LATE_SECONDS <= minLead) {
    throw new Error(`LEAD_LATE_SECONDS (${LEAD_LATE_SECONDS}) must exceed the contract's MIN_SERIES_LEAD (${minLead}).`);
  }

  // Read the fix's own bound off the deployed contract rather than
  // hardcoding it here, so this script stays correct if the constant is
  // ever retuned.
  const publishSlack = await factory.read.MAX_PUBLISH_TIME_SLACK();
  console.log(`factory.MAX_PUBLISH_TIME_SLACK() = ${publishSlack}s\n`);

  // --- Step 3: create five series off the SAME fork-block timestamp ---
  const t0 = forkBlock.timestamp;
  const expiryOk = t0 + LEAD_OK_SECONDS;
  const expiryLate = t0 + LEAD_LATE_SECONDS;
  const expiryEarly = expiryOk + EARLY_EXTRA_SECONDS;

  function seriesParams(symbol: string, expiry: bigint, observationWindow: number): SeriesParams {
    return {
      pythFeedId: BTC_USD_PYTH_FEED_ID,
      settlementToken: deployer, // never touched by the factory itself; just needs to be non-zero
      expiry,
      observationWindow,
      settlementGrace: SETTLEMENT_GRACE_SECONDS,
      maxConfidenceBps: MAX_CONFIDENCE_BPS,
      symbol: stringToHex(symbol, { size: 32 }),
    };
  }

  const paramsOk = seriesParams("PYTHFORK-OK", expiryOk, OBSERVATION_WINDOW_STANDARD);
  const paramsFee = seriesParams("PYTHFORK-FEE", expiryOk, OBSERVATION_WINDOW_STANDARD);
  const paramsLate = seriesParams("PYTHFORK-LATE", expiryLate, OBSERVATION_WINDOW_SHORT);
  const paramsEarly = seriesParams("PYTHFORK-EARLY", expiryEarly, OBSERVATION_WINDOW_STANDARD);
  // Shares OK's expiry AND its wide (300s) declared observationWindow, but is
  // settled below with a tick well inside that window yet past
  // MAX_PUBLISH_TIME_SLACK -- exactly the cherry-picked tick the pre-fix
  // contract would have accepted.
  const paramsCherry = seriesParams("PYTHFORK-CHERRY", expiryOk, OBSERVATION_WINDOW_STANDARD);

  async function createSeries(params: SeriesParams): Promise<Hex> {
    const seriesId = await factory.read.deriveSeriesId([params]);
    const txHash = await factory.write.createSeries([params]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const onChain = await factory.read.getSeries([seriesId]);
    if (!onChain.enabled) throw new Error(`Series ${seriesId} was not created as expected.`);
    return seriesId;
  }

  const seriesIdLate = await createSeries(paramsLate);
  const seriesIdOk = await createSeries(paramsOk);
  const seriesIdFee = await createSeries(paramsFee);
  const seriesIdEarly = await createSeries(paramsEarly);
  const seriesIdCherry = await createSeries(paramsCherry);

  console.log(`\nCreated 5 series off fork timestamp t0=${t0}:`);
  console.log(`  OK     expiry=${expiryOk}  window=${OBSERVATION_WINDOW_STANDARD}s  id=${seriesIdOk}`);
  console.log(`  FEE    expiry=${expiryOk}  window=${OBSERVATION_WINDOW_STANDARD}s  id=${seriesIdFee}`);
  console.log(`  LATE   expiry=${expiryLate}  window=${OBSERVATION_WINDOW_SHORT}s  id=${seriesIdLate}`);
  console.log(`  EARLY  expiry=${expiryEarly}  window=${OBSERVATION_WINDOW_STANDARD}s  id=${seriesIdEarly}`);
  console.log(`  CHERRY expiry=${expiryOk}  window=${OBSERVATION_WINDOW_STANDARD}s  id=${seriesIdCherry}`);

  // --- Step 4: fetch ONE real historical Hermes VAA, timed to land inside
  // MAX_PUBLISH_TIME_SLACK of OK/FEE's expiry and outside LATE's (too late)
  // and EARLY's (too early) ---
  const hermesTargetTs = expiryOk + HERMES_TARGET_OFFSET_SECONDS;
  console.log(
    `\nFetching REAL historical Hermes VAA for unix ${hermesTargetTs} ` +
      `(${new Date(Number(hermesTargetTs) * 1000).toISOString()})...`,
  );
  const hermes = await fetchHermesHistorical(BTC_USD_PYTH_FEED_ID, hermesTargetTs);
  console.log(
    `Hermes returned publishTime=${hermes.publishTime} (${new Date(Number(hermes.publishTime) * 1000).toISOString()}), ` +
      `price=${hermes.price} expo=${hermes.expo} conf=${hermes.conf} (~$${(Number(hermes.price) * 10 ** hermes.expo).toFixed(2)})`,
  );

  const maxAcceptableOk = expiryOk + publishSlack;
  const obsEndOk = expiryOk + BigInt(OBSERVATION_WINDOW_STANDARD);
  const obsEndLate = expiryLate + BigInt(OBSERVATION_WINDOW_SHORT);
  if (hermes.publishTime < expiryOk || hermes.publishTime > maxAcceptableOk) {
    throw new Error(
      `Hermes VAA publishTime ${hermes.publishTime} is not inside OK's post-fix acceptance window ` +
        `[${expiryOk}, ${maxAcceptableOk}] (expiry + MAX_PUBLISH_TIME_SLACK) -- adjust HERMES_TARGET_OFFSET_SECONDS.`,
    );
  }
  if (hermes.publishTime <= obsEndLate) {
    throw new Error(
      `Hermes VAA publishTime ${hermes.publishTime} is not past LATE's window end ${obsEndLate} -- the "too late" negative test needs it to be.`,
    );
  }
  if (hermes.publishTime >= expiryEarly) {
    throw new Error(
      `Hermes VAA publishTime ${hermes.publishTime} is not before EARLY's expiry ${expiryEarly} -- the "too early" negative test needs it to be.`,
    );
  }

  const updateData = [hermes.updateHex];
  const fee = await publicClient.readContract({
    address: pythAddress,
    abi: IPYTH_MIN_ABI,
    functionName: "getUpdateFee",
    args: [updateData],
  });
  console.log(`Real getUpdateFee(1 update) on fork: ${fee} wei`);
  if (fee === BigInt(0)) {
    throw new Error("Real update fee came back 0 wei -- the underpay negative test would not be meaningful.");
  }

  // --- Step 4b: fetch a SECOND real historical Hermes VAA for CHERRY,
  // targeted strictly past expiry+MAX_PUBLISH_TIME_SLACK but still well
  // inside OK's 300s declared observationWindow. Hermes' historical endpoint
  // guarantees the returned publishTime is >= the requested timestamp, so
  // targeting past the slack boundary deterministically guarantees the
  // returned tick is too -- this is the same shape of tick the pre-fix
  // contract would have accepted from a cherry-picking racer. ---
  const cherryTargetTs = expiryOk + publishSlack + CHERRY_PAST_SLACK_BUFFER_SECONDS;
  console.log(
    `\nFetching a SECOND real historical Hermes VAA (for CHERRY) at unix ${cherryTargetTs} ` +
      `(${new Date(Number(cherryTargetTs) * 1000).toISOString()}) -- past the slack, still inside the 300s window...`,
  );
  const hermesCherry = await fetchHermesHistorical(BTC_USD_PYTH_FEED_ID, cherryTargetTs);
  console.log(
    `Hermes returned publishTime=${hermesCherry.publishTime} ` +
      `(${new Date(Number(hermesCherry.publishTime) * 1000).toISOString()}), price=${hermesCherry.price} ` +
      `expo=${hermesCherry.expo} conf=${hermesCherry.conf} ` +
      `(~$${(Number(hermesCherry.price) * 10 ** hermesCherry.expo).toFixed(2)})`,
  );
  if (hermesCherry.publishTime <= maxAcceptableOk) {
    throw new Error(
      `CHERRY's Hermes VAA publishTime ${hermesCherry.publishTime} is not past the slack boundary ${maxAcceptableOk} -- ` +
        `increase CHERRY_PAST_SLACK_BUFFER_SECONDS.`,
    );
  }
  if (hermesCherry.publishTime > obsEndOk) {
    throw new Error(
      `CHERRY's Hermes VAA publishTime ${hermesCherry.publishTime} is past OK's declared window end ${obsEndOk} -- ` +
        `it needs to still be inside the pre-fix acceptance window to prove this was previously exploitable. ` +
        `Reduce CHERRY_PAST_SLACK_BUFFER_SECONDS.`,
    );
  }
  const updateDataCherry = [hermesCherry.updateHex];
  const feeCherry = await publicClient.readContract({
    address: pythAddress,
    abi: IPYTH_MIN_ABI,
    functionName: "getUpdateFee",
    args: [updateDataCherry],
  });

  // --- Step 5: advance the fork's clock past OK/FEE/LATE's expiry (nowhere
  // near EARLY's yet) and settle the happy path ---
  async function jumpTo(timestamp: bigint): Promise<void> {
    await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(timestamp)] });
    await connection.provider.request({ method: "evm_mine", params: [] });
    const block = await publicClient.getBlock();
    console.log(
      `  chain clock -> block ${block.number}, timestamp ${block.timestamp} ` +
        `(${new Date(Number(block.timestamp) * 1000).toISOString()})`,
    );
  }

  console.log(`\nAdvancing EVM time to ${expiryOk + SETTLE_JUMP_BUFFER_SECONDS} (past OK/FEE/LATE's expiry)...`);
  await jumpTo(expiryOk + SETTLE_JUMP_BUFFER_SECONDS);

  console.log("\n[Happy path] publishSettlement(OK) against the REAL receiver...");
  const publishTxHash = await factory.write.publishSettlement([seriesIdOk, updateData], { value: fee });
  const publishReceipt = await publicClient.waitForTransactionReceipt({ hash: publishTxHash });
  if (publishReceipt.status !== "success") throw new Error("publishSettlement(OK) transaction reverted unexpectedly.");

  const settlementOk = await factory.read.getSettlement([seriesIdOk]);
  if (!settlementOk.finalized) throw new Error("Settlement(OK) did not finalize after a successful publishSettlement call.");

  const expectedPrice = normalizePythPrice(hermes.price, hermes.expo);
  console.log(`  tx: ${publishTxHash}`);
  console.log(`  settlement.finalized = ${settlementOk.finalized}`);
  console.log(`  settlement.publishTime = ${settlementOk.publishTime} (Hermes reported ${hermes.publishTime})`);
  console.log(`  settlement.price (1e8-scaled) = ${settlementOk.price}  (~$${(Number(settlementOk.price) / 1e8).toFixed(2)})`);
  console.log(`  Hermes price, normalized the same way = ${expectedPrice}  (~$${(Number(expectedPrice) / 1e8).toFixed(2)})`);
  if (settlementOk.price !== expectedPrice) {
    throw new Error(`Settled price ${settlementOk.price} does not match Hermes-derived price ${expectedPrice}.`);
  }
  if (settlementOk.publishTime !== hermes.publishTime) {
    throw new Error(`Settled publishTime ${settlementOk.publishTime} does not match Hermes publishTime ${hermes.publishTime}.`);
  }
  console.log("  [OK] REAL Pyth receiver verified a real historical Wormhole VAA and TendSeriesFactory settled it correctly.\n");

  // --- Step 6: negative cases against the SAME real receiver ---
  console.log("Negative cases against the real receiver:");

  await expectRevert("publishSettlement(OK) a second time", "AlreadyFinalized", () =>
    factory.write.publishSettlement([seriesIdOk, updateData], { value: fee }),
  );

  await expectRevert("publishSettlement(FEE) underpaying by 1 wei", "InsufficientFee", () =>
    factory.write.publishSettlement([seriesIdFee, updateData], { value: fee - BigInt(1) }),
  );
  console.log("  (proving that revert was specifically about the fee amount: retrying FEE with the exact fee...)");
  const feeTxHash = await factory.write.publishSettlement([seriesIdFee, updateData], { value: fee });
  const feeReceipt = await publicClient.waitForTransactionReceipt({ hash: feeTxHash });
  if (feeReceipt.status !== "success") throw new Error("publishSettlement(FEE) with the exact fee unexpectedly reverted.");
  const settlementFee = await factory.read.getSettlement([seriesIdFee]);
  if (!settlementFee.finalized) throw new Error("Settlement(FEE) did not finalize after paying the exact fee.");
  console.log("  [OK] FEE settles once the exact real fee is paid -- confirms the earlier revert was fee-specific.\n");

  // *** FINDING (see the header comment block above `main` and the report
  // this script prints at the very end for the full writeup): these two
  // calls do NOT revert with `TendSeriesFactory.InvalidObservationTime`,
  // even though that is the custom error TendSeriesFactory.sol declares
  // and checks for exactly this condition
  // (`pythPrice.publishTime < series.expiry || pythPrice.publishTime >
  // observationEnd`). The factory calls `pyth.parsePriceFeedUpdates(...,
  // uint64(series.expiry), uint64(observationEnd))` — i.e. it hands Pyth's
  // OWN `minPublishTime`/`maxPublishTime` bounds-check the exact same
  // window — and Pyth's own implementation enforces that bound ITSELF,
  // reverting with its own `PriceFeedNotFoundWithinRange` (selector
  // 0x45805f5d, @pythnetwork/pyth-sdk-solidity/PythErrors.sol) before ever
  // returning a price back to the factory. This is true of BOTH the real
  // receiver (confirmed empirically right here) AND MockPyth (confirmed by
  // reading MockPyth.sol's own `parsePriceFeedUpdatesWithConfig` — see the
  // identical `minAllowedPublishTime <= publishTime <= maxAllowedPublishTime`
  // guard there) — so `TendSeriesFactory.InvalidObservationTime` appears to
  // be UNREACHABLE dead code on both oracles, simply because no test
  // anywhere in this repo (contracts/TendSeriesFactory.t.sol included) had
  // ever actually sent an out-of-window publishTime through
  // `publishSettlement` before this script did.
  await expectRevert(
    "publishSettlement(LATE) -- VAA publishTime is past this series' (short) observation window",
    "PriceFeedNotFoundWithinRange",
    () => factory.write.publishSettlement([seriesIdLate, updateData], { value: fee }),
  );

  // *** THE FIX, PROVEN AGAINST THE REAL RECEIVER: CHERRY shares OK's expiry
  // AND its wide 300s declared observationWindow -- under the PRE-FIX rule
  // ([expiry, expiry+observationWindow]), hermesCherry's publishTime is
  // comfortably inside that window (checked above) and this call would have
  // succeeded, finalizing CHERRY at hermesCherry.price. That is precisely
  // the cherry-picking vulnerability this fix closes: a racer settling late
  // could always reach for a real, validly-signed tick anywhere in the full
  // window. Post-fix, the factory caps the acceptable range at
  // expiry+MAX_PUBLISH_TIME_SLACK regardless of observationWindow, so Pyth's
  // OWN bounds check on the real receiver now rejects it first.
  console.log(
    `\n[THE FIX] publishSettlement(CHERRY) against the REAL receiver -- a tick well inside the declared 300s ` +
      `window but past MAX_PUBLISH_TIME_SLACK (${publishSlack}s)...`,
  );
  await expectRevert(
    "publishSettlement(CHERRY) -- VAA publishTime is inside the declared observationWindow but past MAX_PUBLISH_TIME_SLACK",
    "PriceFeedNotFoundWithinRange",
    () => factory.write.publishSettlement([seriesIdCherry, updateDataCherry], { value: feeCherry }),
  );
  console.log(
    "  [OK] Pre-fix this tick would have settled CHERRY; post-fix the REAL receiver rejects it before a price " +
      "is ever read. The cherry-picking window is now capped at MAX_PUBLISH_TIME_SLACK, not observationWindow.\n",
  );

  console.log(`\nAdvancing EVM time to ${expiryEarly + SETTLE_JUMP_BUFFER_SECONDS} (past EARLY's expiry)...`);
  await jumpTo(expiryEarly + SETTLE_JUMP_BUFFER_SECONDS);
  await expectRevert(
    "publishSettlement(EARLY) -- VAA publishTime is before this series' (much later) expiry",
    "PriceFeedNotFoundWithinRange",
    () => factory.write.publishSettlement([seriesIdEarly, updateData], { value: fee }),
  );

  console.log(`\n${"=".repeat(78)}`);
  console.log("ALL ASSERTIONS PASSED against Pyth's REAL canonical receiver on a Base");
  console.log("mainnet fork. Summary:");
  console.log(`  Chain: Base mainnet (chainId 8453), RPC ${BASE_FORK.rpcUrl}`);
  console.log(`  Receiver: ${pythAddress}`);
  console.log(`  Fork block: ${BASE_FORK.blockNumber} (timestamp ${t0}, ${new Date(Number(t0) * 1000).toISOString()})`);
  console.log(`  Real VAA publishTime: ${hermes.publishTime} (${new Date(Number(hermes.publishTime) * 1000).toISOString()})`);
  console.log(
    `  Settled price: ${settlementOk.price} (1e8-scaled, ~$${(Number(settlementOk.price) / 1e8).toFixed(2)}) ` +
      `vs Hermes ~$${(Number(hermes.price) * 10 ** hermes.expo).toFixed(2)}`,
  );
  console.log(
    "  FINDING: TendSeriesFactory.InvalidObservationTime looks unreachable -- the LATE/EARLY/CHERRY\n" +
      "  cases above all reverted with Pyth's OWN PriceFeedNotFoundWithinRange (0x45805f5d),\n" +
      "  not the factory's InvalidObservationTime. See this file's header comment.",
  );
  console.log(
    `  CHERRY-PICK FIX CONFIRMED: a real tick at publishTime=${hermesCherry.publishTime} -- inside OK's\n` +
      `  declared ${OBSERVATION_WINDOW_STANDARD}s observationWindow but past MAX_PUBLISH_TIME_SLACK\n` +
      `  (${publishSlack}s) -- was rejected by the REAL receiver. Pre-fix this same tick would have\n` +
      `  finalized CHERRY. See "THE FIX" section above.`,
  );
  console.log("=".repeat(78));

  await connection.close();
}

main().catch((error) => {
  console.error("\nFORK PROOF FAILED:\n", error);
  process.exitCode = 1;
});
