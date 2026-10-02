// Operational utility: resolve a SINGLE open Tend pool position on Monad
// testnet, auto-detecting whether it should be SETTLED (a real Pyth payout
// via MockPyth) or REFUNDED (the oracle-timeout refund path) purely from
// on-chain state — no human judgement, no flags to pick the branch.
//
// Why two paths, and how the branch is chosen (all read from the chain):
//   - A series becomes settleable once it has expired and while
//     block.timestamp <= settlementDeadline (= expiry + observationWindow +
//     settlementGrace). In that window a real, current Hermes BTC/USD price
//     is published through MockPyth and the position pays out.
//   - If nobody published a settlement before that deadline passed, the
//     series is instead REFUNDABLE: factory.isRefundable(seriesId) flips to
//     true, and refundPoolPosition returns the buyer's premium and releases
//     the pool's locked collateral. This is the honest fail-safe for a
//     missed settlement.
// This script reads the position and its series timing, then:
//   * block.timestamp < expiry             -> throw (nothing to do yet)
//   * factory.isRefundable(seriesId)        -> REFUND
//   * block.timestamp <= settlementDeadline -> SETTLE
//   * otherwise                             -> throw (a diagnostic dead-zone)
//
// Settlement note (identical to scripts/e2e-monad.ts): Monad testnet's
// canonical Pyth receiver rejects live Hermes Wormhole VAAs
// (InvalidWormholeVaa — a stale on-chain guardian set). The stack was
// redeployed with the factory's `pyth` pointed at MockPyth, which verifies
// only that an update's publishTime falls inside the series' [expiry,
// observationEnd] window (no Wormhole signature check). The PRICE settled is
// REAL, fetched fresh from Hermes right before publishing; only the
// publishTime is stamped to `expiry + 1` (strictly inside the window), since
// by the time a short-dated series actually expires, wall-clock time may
// already be past observationEnd.
//
// This is a thin operational sibling of scripts/e2e-monad.ts: it REUSES the
// shared helpers under scripts/lib/e2e/ (chain, buyer-wallet, errors, format)
// and, crucially, the SAME settlement-publishing routine —
// scripts/lib/e2e/settlement.ts's publishSettlementForSeries, which
// e2e-monad.ts and keeper-monad.ts also call, so the three cannot drift. It
// does NOT create a series, fill a quote, or wait for expiry.
//
// For an unattended sweep over EVERY open position (and automatic re-seeding
// of a tradable series), see scripts/keeper-monad.ts — this script resolves
// exactly one position, on demand.
//
// Usage:
//   POSITION_ID=<decimal> npm run settle:monad
//   (or leave POSITION_ID unset to resolve the position recorded in
//    deployments/monad-e2e.json)
//   Equivalent to: node --env-file=.env node_modules/.bin/hardhat run
//   scripts/settle-monad-position.ts --network monadTestnet
//
// The run uses two wallets, exactly like e2e-monad.ts:
//   - the deployer (MONAD_DEPLOYER_KEY): pays the MockPyth update fee and
//     publishes the settlement.
//   - the fresh "buyer" EOA (.devnet/monad-e2e-buyer.json): triggers its own
//     settlement payout / refund (both are permissionless — sent as the
//     buyer for symmetry with e2e-monad.ts).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { network } from "hardhat";
import { type Hex, createPublicClient, http, parseEventLogs } from "viem";
import { MONAD_TESTNET } from "../config/monad.js";
import { monadTestnetChain, explorerTx } from "./lib/e2e/chain.js";
import { loadOrCreateBuyerWallet } from "./lib/e2e/buyer-wallet.js";
import { explainRevert } from "./lib/e2e/errors.js";
import { formatMUSDC } from "./lib/e2e/format.js";
import { loadSettlementOracle, publishSettlementForSeries } from "./lib/e2e/settlement.js";

const DEPLOY_MANIFEST_PATH = path.join(process.cwd(), "deployments", "monad-testnet.json");
const E2E_MANIFEST_PATH = path.join(process.cwd(), "deployments", "monad-e2e.json");

// The public `positions(uint256)` getter flattens the Position struct into
// multiple named return values, so viem returns them as an *array* tuple —
// NOT an object with named keys (this exact object-vs-array trap already bit
// scripts/e2e-monad.ts). Field order (see contracts/TendPoolVault.sol
// `struct Position`): [buyer, seriesId, direction, strike, width, premium,
// maxPayout, feeBps, settled].
const POS_BUYER = 0;
const POS_SERIES_ID = 1;
const POS_DIRECTION = 2;
const POS_STRIKE = 3;
const POS_WIDTH = 4;
const POS_PREMIUM = 5;
const POS_MAX_PAYOUT = 6;
const POS_SETTLED = 8;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface DeployManifest {
  deployer: string;
  contracts: {
    mockUSDC: string;
    mockPyth?: string;
    priceOracle?: string;
    tendSeriesFactory: string;
    tendPoolVault: string;
  };
}

async function readDeployManifest(): Promise<DeployManifest> {
  let raw: string;
  try {
    raw = await readFile(DEPLOY_MANIFEST_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No manifest found at ${DEPLOY_MANIFEST_PATH}. Run "npm run deploy:monad" first — this utility ` +
          `only resolves a position on an already-deployed protocol, it never deploys.`,
      );
    }
    throw error;
  }
  return JSON.parse(raw) as DeployManifest;
}

/// Resolves the target positionId: POSITION_ID env var (decimal) wins; else
/// the position recorded in deployments/monad-e2e.json (its fill.positionId);
/// else a clear instruction to set POSITION_ID.
async function resolvePositionId(): Promise<bigint> {
  const fromEnv = process.env.POSITION_ID;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    let parsed: bigint;
    try {
      parsed = BigInt(fromEnv.trim());
    } catch {
      throw new Error(`POSITION_ID="${fromEnv}" is not a valid decimal integer.`);
    }
    if (parsed <= 0n) throw new Error(`POSITION_ID must be a positive integer (got ${parsed}).`);
    console.log(`Target positionId ${parsed} (from POSITION_ID env var).`);
    return parsed;
  }

  let raw: string;
  try {
    raw = await readFile(E2E_MANIFEST_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `POSITION_ID is not set and no e2e manifest exists at ${E2E_MANIFEST_PATH} to fall back on. Set ` +
          `POSITION_ID=<decimal position id> and re-run (e.g. "POSITION_ID=1 npm run settle:monad").`,
      );
    }
    throw error;
  }
  const manifest = JSON.parse(raw) as { fill?: { positionId?: string } };
  const recorded = manifest.fill?.positionId;
  if (recorded === undefined || recorded.trim() === "") {
    throw new Error(
      `POSITION_ID is not set and ${E2E_MANIFEST_PATH} has no recorded fill.positionId to fall back on ` +
        `(its last run may not have reached the fill step). Set POSITION_ID=<decimal position id> and re-run.`,
    );
  }
  const parsed = BigInt(recorded);
  console.log(`Target positionId ${parsed} (from ${E2E_MANIFEST_PATH} fill.positionId; POSITION_ID unset).`);
  return parsed;
}

async function main() {
  const deployManifest = await readDeployManifest();
  const positionId = await resolvePositionId();

  const connection = await network.create();
  const { viem, networkName } = connection;

  try {
    if (networkName !== MONAD_TESTNET.name) {
      throw new Error(
        `Connected to "${networkName}", not "${MONAD_TESTNET.name}". Run with "--network monadTestnet" ` +
          `(i.e. "npm run settle:monad").`,
      );
    }

    const [deployerClient] = await viem.getWalletClients();
    if (deployerClient === undefined) {
      throw new Error(
        `No account configured for "${networkName}". Set MONAD_DEPLOYER_KEY (a funded Monad testnet ` +
          `private key) in .env and retry.`,
      );
    }
    const deployer = deployerClient.account.address;
    const publicClient = createPublicClient({ chain: monadTestnetChain, transport: http(MONAD_TESTNET.rpcUrl) });

    console.log(`Network: ${networkName} (chainId ${MONAD_TESTNET.chainId})`);
    console.log(`Deployer (settlement publisher): ${deployer}`);

    const factory = await viem.getContractAt(
      "TendSeriesFactory",
      deployManifest.contracts.tendSeriesFactory as Hex,
    );
    const vault = await viem.getContractAt("TendPoolVault", deployManifest.contracts.tendPoolVault as Hex);
    const mockUSDC = await viem.getContractAt("MockERC20", deployManifest.contracts.mockUSDC as Hex);
    // The settlement oracle: factory.pyth() points here, not at Monad
    // testnet's canonical Pyth receiver — see the header comment for why.
    const { mockPyth, priceOracle } = await loadSettlementOracle(viem, deployManifest.contracts);

    // The buyer EOA reused from the e2e run: it owns the position and triggers
    // its own settle/refund (both permissionless). Built exactly like
    // e2e-monad.ts's buyerVault.
    const buyer = await loadOrCreateBuyerWallet();
    const buyerVault = await viem.getContractAt(
      "TendPoolVault",
      deployManifest.contracts.tendPoolVault as Hex,
      { client: { public: publicClient, wallet: buyer.walletClient as never } },
    );

    // -----------------------------------------------------------------------
    // 1. Read the position (flattened tuple — see field-index constants).
    // -----------------------------------------------------------------------
    const position = (await vault.read.positions([positionId])) as readonly unknown[];
    const positionBuyer = position[POS_BUYER] as Hex;
    if (positionBuyer.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(`PositionNotFound: no position exists at id ${positionId} (buyer is the zero address).`);
    }
    const alreadySettled = position[POS_SETTLED] as boolean;
    if (alreadySettled) {
      console.log(`\nPosition ${positionId} is already settled/refunded, nothing to do.`);
      return;
    }

    const seriesId = position[POS_SERIES_ID] as Hex;
    const direction = position[POS_DIRECTION] as number;
    const strike = position[POS_STRIKE] as bigint;
    const width = position[POS_WIDTH] as bigint;
    const premium = position[POS_PREMIUM] as bigint;
    const maxPayout = position[POS_MAX_PAYOUT] as bigint;

    console.log(`\nPosition ${positionId}:`);
    console.log(`  buyer:     ${positionBuyer}`);
    console.log(`  seriesId:  ${seriesId}`);
    console.log(`  direction: ${direction === 0 ? "UP" : direction === 1 ? "DOWN" : `unknown(${direction})`}`);
    console.log(`  strike:    ${(Number(strike) / 1e8).toFixed(2)} (raw ${strike})`);
    console.log(`  width:     ${(Number(width) / 1e8).toFixed(2)} (raw ${width})`);
    console.log(`  premium:   ${formatMUSDC(premium)} mUSDC`);
    console.log(`  maxPayout: ${formatMUSDC(maxPayout)} mUSDC`);
    if (positionBuyer.toLowerCase() !== buyer.address.toLowerCase()) {
      console.log(
        `  Warning: the cached buyer wallet (${buyer.address}) is NOT this position's buyer ` +
          `(${positionBuyer}). settle/refund are permissionless so this still works, but the payout/refund ` +
          `goes to the position's recorded buyer, not the wallet sending the tx.`,
      );
    }

    // -----------------------------------------------------------------------
    // 2. Read series timing + current chain time, then decide the branch.
    //    getSeries returns the Series struct as an object; uint32/uint16
    //    fields (observationWindow/settlementGrace/maxConfidenceBps) come back
    //    as `number`, only uint64 `expiry` is a bigint — so widen with BigInt.
    // -----------------------------------------------------------------------
    const series = await factory.read.getSeries([seriesId]);
    const expiry = series.expiry;
    const observationWindow = BigInt(series.observationWindow);
    const settlementGrace = BigInt(series.settlementGrace);
    const seriesMaxConfidenceBps = BigInt(series.maxConfidenceBps);
    const observationEnd = expiry + observationWindow;
    const settlementDeadline = observationEnd + settlementGrace;

    const block = await publicClient.getBlock();
    const now = block.timestamp;

    console.log(`\nSeries timing:`);
    console.log(`  expiry:            ${expiry} (${new Date(Number(expiry) * 1000).toISOString()})`);
    console.log(`  observationWindow: ${observationWindow}s -> observationEnd    = ${observationEnd}`);
    console.log(`  settlementGrace:   ${settlementGrace}s -> settlementDeadline = ${settlementDeadline}`);
    console.log(`  maxConfidenceBps:  ${seriesMaxConfidenceBps}`);
    console.log(`  chain time now:    ${now} (${new Date(Number(now) * 1000).toISOString()})`);

    if (now < expiry) {
      throw new Error(
        `Series ${seriesId} has not expired yet (chain time ${now} < expiry ${expiry}, ` +
          `${Number(expiry - now)}s remaining). Nothing to settle or refund. Re-run after expiry.`,
      );
    }

    const refundable = await factory.read.isRefundable([seriesId]);
    console.log(`  factory.isRefundable(seriesId) == ${refundable}`);

    // =======================================================================
    // REFUND PATH — series is past settlementDeadline with no finalized
    // settlement; return the premium and release collateral (permissionless,
    // sent as the buyer for symmetry with the settle path).
    // =======================================================================
    if (refundable) {
      console.log(`\n=== REFUND PATH (series past settlementDeadline, no settlement published) ===`);

      const lockedBefore = (await vault.read.lockedCollateral()) as bigint;
      const openBefore = (await vault.read.openPositions()) as bigint;
      const buyerMusdcBefore = (await mockUSDC.read.balanceOf([positionBuyer])) as bigint;
      console.log(`  lockedCollateral before: ${formatMUSDC(lockedBefore)} mUSDC`);
      console.log(`  openPositions before:    ${openBefore}`);
      console.log(`  buyer mUSDC before:      ${formatMUSDC(buyerMusdcBefore)} mUSDC`);

      let refundTxHash: Hex;
      try {
        refundTxHash = await buyerVault.write.refundPoolPosition([positionId]);
      } catch (error) {
        throw new Error(`refundPoolPosition reverted: ${explainRevert(error)}`);
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash: refundTxHash });
      console.log(`  refundPoolPosition tx: ${refundTxHash}`);
      console.log(`  explorer:              ${explorerTx(refundTxHash)}`);

      const refundedEvents = parseEventLogs({ abi: vault.abi, eventName: "PositionRefunded", logs: receipt.logs });
      if (refundedEvents.length === 0) {
        throw new Error("refundPoolPosition succeeded but emitted no PositionRefunded event.");
      }
      const refundedArgs = refundedEvents[0].args as { premium: bigint; collateral: bigint };
      console.log(
        `  PositionRefunded: premium=${formatMUSDC(refundedArgs.premium)} mUSDC, ` +
          `collateral=${formatMUSDC(refundedArgs.collateral)} mUSDC`,
      );

      const positionAfter = (await vault.read.positions([positionId])) as readonly unknown[];
      const settledAfter = positionAfter[POS_SETTLED] as boolean;
      const lockedAfter = (await vault.read.lockedCollateral()) as bigint;
      const openAfter = (await vault.read.openPositions()) as bigint;
      const buyerMusdcAfter = (await mockUSDC.read.balanceOf([positionBuyer])) as bigint;

      console.log(`\nRefund read-back:`);
      console.log(`  position.settled: ${settledAfter}`);
      console.log(
        `  lockedCollateral: ${formatMUSDC(lockedBefore)} -> ${formatMUSDC(lockedAfter)} ` +
          `(delta ${formatMUSDC(lockedAfter - lockedBefore)}, expected -${formatMUSDC(maxPayout)})`,
      );
      console.log(`  openPositions:    ${openBefore} -> ${openAfter} (delta ${openAfter - openBefore}, expected -1)`);
      console.log(
        `  buyer mUSDC:      ${formatMUSDC(buyerMusdcBefore)} -> ${formatMUSDC(buyerMusdcAfter)} ` +
          `(delta +${formatMUSDC(buyerMusdcAfter - buyerMusdcBefore)}, expected +${formatMUSDC(premium)})`,
      );

      if (!settledAfter) throw new Error("positions(positionId).settled is still false after refundPoolPosition.");
      if (lockedAfter - lockedBefore !== -maxPayout) {
        throw new Error("lockedCollateral did not fall by exactly maxPayout after refund.");
      }
      if (openAfter - openBefore !== -1n) throw new Error("openPositions did not decrease by exactly 1 after refund.");
      if (buyerMusdcAfter - buyerMusdcBefore !== premium) {
        throw new Error("Buyer's mUSDC balance did not rise by exactly the premium after refund.");
      }
      if (refundedArgs.premium !== premium) {
        throw new Error("PositionRefunded.premium does not match the position's premium.");
      }
      if (refundedArgs.collateral !== maxPayout) {
        throw new Error("PositionRefunded.collateral does not match the position's maxPayout.");
      }

      console.log(
        `\n=== RESULT: REFUNDED position ${positionId} — premium ${formatMUSDC(premium)} mUSDC returned to ` +
          `${positionBuyer}, ${formatMUSDC(maxPayout)} mUSDC collateral released (lockedCollateral ` +
          `-${formatMUSDC(maxPayout)}, openPositions -1). ===`,
      );
      return;
    }

    // =======================================================================
    // SETTLE PATH — expired and inside the settlement window. The publish half
    // is the shared helper in scripts/lib/e2e/settlement.ts (the same one
    // scripts/keeper-monad.ts uses): a real, current Hermes price pushed
    // through MockPyth with an in-window stamped publishTime. This script then
    // settles the position as the buyer.
    // =======================================================================
    if (now <= settlementDeadline) {
      console.log(`\n=== SETTLE PATH (series expired, within settlement window) ===`);

      const published = await publishSettlementForSeries({
        publicClient,
        factory,
        mockPyth,
        priceOracle,
        seriesId,
        series,
        publisher: deployer,
      });
      // Non-null in a live (non dry-run) publish — this guard only exists so
      // the shared helper's dry-run-aware return type narrows cleanly here.
      const settlementPrice = published.settledPrice;
      if (settlementPrice === null) {
        throw new Error("publishSettlementForSeries returned no settled price for a live publish.");
      }

      // Settle the position (buyer triggers their own payout — permissionless).
      const expectedPayout = (await vault.read.calculatePayout([
        direction,
        strike,
        width,
        settlementPrice,
        maxPayout,
      ])) as bigint;
      console.log(`\nExpected payout (vault.calculatePayout, pre-settle): ${formatMUSDC(expectedPayout)} mUSDC`);

      const lockedBefore = (await vault.read.lockedCollateral()) as bigint;
      const openBefore = (await vault.read.openPositions()) as bigint;
      const buyerMusdcBefore = (await mockUSDC.read.balanceOf([positionBuyer])) as bigint;

      let settleTxHash: Hex;
      try {
        settleTxHash = await buyerVault.write.settlePoolPosition([positionId]);
      } catch (error) {
        throw new Error(`settlePoolPosition reverted: ${explainRevert(error)}`);
      }
      const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleTxHash });
      console.log(`settlePoolPosition tx: ${settleTxHash}`);
      console.log(`explorer:              ${explorerTx(settleTxHash)}`);

      const settledEvents = parseEventLogs({ abi: vault.abi, eventName: "PositionSettled", logs: settleReceipt.logs });
      if (settledEvents.length === 0) throw new Error("settlePoolPosition succeeded but emitted no PositionSettled event.");
      const settledArgs = settledEvents[0].args as {
        settlementPrice: bigint;
        payout: bigint;
        poolAmount: bigint;
        fee: bigint;
      };
      console.log(
        `  actual payout: ${formatMUSDC(settledArgs.payout)} mUSDC, poolAmount: ${formatMUSDC(settledArgs.poolAmount)}, ` +
          `fee: ${formatMUSDC(settledArgs.fee)}`,
      );

      if (settledArgs.payout !== expectedPayout) {
        throw new Error(
          `Actual payout (${settledArgs.payout}) does not match vault.calculatePayout's prediction ` +
            `(${expectedPayout}) — investigate before trusting this run.`,
        );
      }

      const positionAfter = (await vault.read.positions([positionId])) as readonly unknown[];
      const settledAfter = positionAfter[POS_SETTLED] as boolean;
      const lockedAfter = (await vault.read.lockedCollateral()) as bigint;
      const openAfter = (await vault.read.openPositions()) as bigint;
      const buyerMusdcAfter = (await mockUSDC.read.balanceOf([positionBuyer])) as bigint;

      console.log(`\nSettle read-back:`);
      console.log(`  position.settled: ${settledAfter}`);
      console.log(
        `  lockedCollateral: ${formatMUSDC(lockedBefore)} -> ${formatMUSDC(lockedAfter)} ` +
          `(delta ${formatMUSDC(lockedAfter - lockedBefore)}, expected -${formatMUSDC(maxPayout)})`,
      );
      console.log(`  openPositions:    ${openBefore} -> ${openAfter} (delta ${openAfter - openBefore}, expected -1)`);
      console.log(
        `  buyer mUSDC:      ${formatMUSDC(buyerMusdcBefore)} -> ${formatMUSDC(buyerMusdcAfter)} ` +
          `(delta +${formatMUSDC(buyerMusdcAfter - buyerMusdcBefore)}, expected +${formatMUSDC(settledArgs.payout)})`,
      );

      if (!settledAfter) throw new Error("positions(positionId).settled is still false after settlePoolPosition.");
      if (lockedAfter - lockedBefore !== -maxPayout) {
        throw new Error("lockedCollateral did not fall by exactly maxPayout after settlement.");
      }
      if (openAfter - openBefore !== -1n) {
        throw new Error("openPositions did not decrease by exactly 1 after settlement.");
      }
      if (buyerMusdcAfter - buyerMusdcBefore !== settledArgs.payout) {
        throw new Error("Buyer's mUSDC balance did not rise by exactly the payout after settlement.");
      }

      console.log(
        `\n=== RESULT: SETTLED position ${positionId} — payout ${formatMUSDC(settledArgs.payout)} mUSDC to ` +
          `${positionBuyer} at settled price $${(Number(settlementPrice) / 1e8).toFixed(2)} (lockedCollateral ` +
          `-${formatMUSDC(maxPayout)}, openPositions -1). ===`,
      );
      return;
    }

    // =======================================================================
    // DEAD-ZONE — past the settlement deadline yet isRefundable() is somehow
    // still false (e.g. an already-finalized settlement). Fail closed with the
    // raw timing numbers so the operator can resolve it manually.
    // =======================================================================
    throw new Error(
      `Position ${positionId} is in a settlement dead-zone: chain time ${now} is past the settlementDeadline ` +
        `(${settlementDeadline} = expiry ${expiry} + observationWindow ${observationWindow} + settlementGrace ` +
        `${settlementGrace}), yet factory.isRefundable(${seriesId}) returned false. This usually means a ` +
        `settlement was already finalized (so the position should settle, not refund) but the deadline check ` +
        `above no longer allows publishing. Inspect factory.getSettlement(seriesId) and resolve manually.`,
    );
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
