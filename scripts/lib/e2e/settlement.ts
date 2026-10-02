import { fetchDemoSettlementPrice } from "../../../market-data/coinbase.js";
// Testnet settlement uses the real Coinbase expiry-minute opening price through
// MockPyth. No price or timestamp is fabricated, but the exchange candle is not
// a signed oracle attestation and the mock confidence field is zero (unknown).
// Quotes, chart and settlement use the same BTC/ETH exchange products.
import type { Hex } from "viem";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import { MONAD_TESTNET } from "../../../config/monad.js";
import { explorerTx } from "./chain.js";
import { explainRevert } from "./errors.js";
import { formatMON } from "./format.js";
import { normalizePythPrice, type HermesParsedPrice } from "./hermes.js";
import { matchPythErrorSelector } from "./pyth-errors.js";

/// The contracts this helper touches, typed exactly as
/// `viem.getContractAt(...)` returns them so callers can pass theirs straight
/// through with no casting.
export type SettlementFactoryContract = ContractReturnType<"TendSeriesFactory">;
export type SettlementMockPythContract = ContractReturnType<"DeployableMockPyth">;
export type SettlementPriceOracleContract = ContractReturnType<"TendPriceOracle">;

/// The slice of a viem PublicClient this helper needs. Kept structural (and
/// deliberately minimal) because callers supply different concrete clients —
/// e2e-monad.ts uses Hardhat's `viem.getPublicClient()`, while the settle
/// utility and the keeper build their own `createPublicClient(...)`.
export interface SettlementPublicClient {
  getBlock(): Promise<{ timestamp: bigint }>;
  getBalance(args: { address: Hex }): Promise<bigint>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<unknown>;
}

/// The series fields settlement depends on. This is exactly the shape
/// `factory.getSeries(seriesId)` returns (a named-struct OBJECT, unlike the
/// vault's flattened `positions` getter): `expiry` comes back as a bigint
/// while the uint32/uint16 fields come back as `number`, so both are accepted
/// and widened internally.
export interface SettlementSeries {
  pythFeedId: Hex;
  expiry: bigint;
  observationWindow: number | bigint;
  settlementGrace: number | bigint;
  maxConfidenceBps: number | bigint;
}

export interface PublishSettlementParams {
  publicClient: SettlementPublicClient;
  factory: SettlementFactoryContract;
  /// Legacy MockPyth deployments. Anyone can post to MockPyth, so these are
  /// only kept until each chain is redeployed on TendPriceOracle.
  mockPyth?: SettlementMockPythContract;
  /// Admin-only oracle (TendPriceOracle). When present it is used instead of
  /// mockPyth, and `publisher` must be its admin.
  priceOracle?: SettlementPriceOracleContract;
  seriesId: Hex;
  series: SettlementSeries;
  /// The address that pays the MockPyth update fee — used only to check it
  /// holds enough MON before sending, so an underfunded key fails with a
  /// fund-me message rather than a raw revert.
  publisher: Hex;
  /// When true, everything up to (and excluding) the publishSettlement
  /// transaction runs — exchange candle fetch, confidence check, update-data
  /// construction and fee quote are all read-only — but no transaction is
  /// sent. `publishTxHash` and `settledPrice` come back null.
  dryRun?: boolean;
  /// Injected so callers control their own log prefixes/indentation.
  log?: (line: string) => void;
}

export interface PublishSettlementResult {
  /// null in dry-run mode (nothing was sent).
  publishTxHash: Hex | null;
  /// The on-chain settled price read back after publishing; null in dry-run.
  settledPrice: bigint | null;
  /// The publishTime the factory actually recorded; null in dry-run.
  settledPublishTime: bigint | null;
  stampedPublishTime: bigint;
  observationEnd: bigint;
  settlementDeadline: bigint;
  /** Legacy result field name; contains Coinbase expiry-minute data in demo mode. */
  hermes: HermesParsedPrice;
  impliedConfidenceBps: bigint;
  updateFee: bigint;
  dryRun: boolean;
}

/// Publishes the settlement for ONE series (never per position — a series has
/// a single settlement, and a second publish reverts AlreadyFinalized).
/// Callers must check `factory.getSettlement(seriesId).finalized` first if the
/// settlement may already exist.
///
/// Throws on any failure with a message that names the violated bound; the
/// nested MockPyth reverts (which viem can only print as a bare selector,
/// since they are not in TendSeriesFactory's ABI) are additionally matched
/// against Pyth's own known error selectors.
export async function publishSettlementForSeries(
  params: PublishSettlementParams,
): Promise<PublishSettlementResult> {
  const { publicClient, factory, mockPyth, seriesId, series, publisher } = params;
  const dryRun = params.dryRun ?? false;
  const log = params.log ?? ((line: string) => console.log(line));

  const expiry = series.expiry;
  const observationWindow = BigInt(series.observationWindow);
  const settlementGrace = BigInt(series.settlementGrace);
  const maxConfidenceBps = BigInt(series.maxConfidenceBps);
  const observationEnd = expiry + observationWindow;
  const settlementDeadline = observationEnd + settlementGrace;

  // Re-read chain time immediately before publishing rather than trusting a
  // timestamp read earlier in the caller: an intervening exchange candle fetch or a
  // slow RPC can easily push the run past the deadline.
  const blockBeforePublish = await publicClient.getBlock();
  if (blockBeforePublish.timestamp > settlementDeadline) {
    throw new Error(
      `block.timestamp (${blockBeforePublish.timestamp}) is already past this series' settlementDeadline ` +
        `(${settlementDeadline}) — publishSettlement would revert with SettlementWindowClosed.`,
    );
  }

  const spot = await fetchDemoSettlementPrice(series.pythFeedId, Number(expiry));
  const stampedPublishTime = BigInt(spot.publishTime); // Actual expiry-minute bucket timestamp.
  const humanPrice = normalizePythPrice(spot.price, spot.expo);
  log(
    `Real Coinbase price fetched for DEMO settlement: $${(Number(humanPrice) / 1e8).toFixed(2)} ` +
      `(raw price=${spot.price}, conf=${spot.conf}, expo=${spot.expo}, Coinbase's own ` +
      `publishTime=${spot.publishTime}, feed ${series.pythFeedId})`,
  );
  log(`  Using Coinbase expiry-minute open at ${stampedPublishTime}; MockPyth bypasses attestation verification.`);

  if (spot.price <= 0n) {
    throw new Error(
      `Coinbase returned a non-positive price (${spot.price}) for feed ${series.pythFeedId} — refusing to ` +
        `settle against it.`,
    );
  }
  const impliedConfidenceBps = (spot.conf * 10_000n) / spot.price;
  log(
    `  Confidence check: rawConf=${spot.conf}, rawPrice=${spot.price}, implied=${impliedConfidenceBps} bps ` +
      `(series maxConfidenceBps=${maxConfidenceBps} bps)`,
  );
  if (spot.conf * 10_000n > spot.price * maxConfidenceBps) {
    throw new Error(
      `Exchange conf/price ratio (~${impliedConfidenceBps} bps) exceeds this series' maxConfidenceBps ` +
        `(${maxConfidenceBps} bps) — publishSettlement would revert with OracleConfidenceTooWide. Raw ` +
        `conf=${spot.conf}, raw price=${spot.price}. This is a real anomaly in the exchange reading (or the ` +
        `series' bound is too tight), not a script bug — not retrying blindly.`,
    );
  }

  let updateFee = 0n;
  let updateData: Hex[] = [];
  let publishTxHash: Hex;
  if (params.priceOracle !== undefined) {
    // TendPriceOracle: only its admin can write a price, and the factory
    // ignores caller-supplied update bytes. So the keeper POSTS the Coinbase
    // expiry price as admin, then settles with empty update data. Posts are
    // write-once per (feed, publishTime); a re-run after a partial failure
    // reuses the existing post instead of reverting AlreadyPosted.
    const priceOracle = params.priceOracle;
    const existing = (await priceOracle.read.priceAt([series.pythFeedId, stampedPublishTime])) as { price: bigint };
    if (dryRun) {
      log(
        `  [dry-run] would ${existing.price === 0n ? "post the price to TendPriceOracle, then " : ""}send ` +
          `factory.publishSettlement(${seriesId}, []) — no transaction sent.`,
      );
      return {
        publishTxHash: null,
        settledPrice: null,
        settledPublishTime: null,
        stampedPublishTime,
        observationEnd,
        settlementDeadline,
        hermes: spot,
        impliedConfidenceBps,
        updateFee,
        dryRun: true,
      };
    }
    if (existing.price === 0n) {
      const postHash = await priceOracle.write.postPrice([
        series.pythFeedId,
        spot.price,
        spot.conf,
        spot.expo,
        stampedPublishTime,
      ]);
      await publicClient.waitForTransactionReceipt({ hash: postHash });
      log(`  TendPriceOracle.postPrice tx: ${postHash}`);
    } else if (BigInt(existing.price) !== BigInt(spot.price)) {
      log(
        `  TendPriceOracle already holds ${existing.price} for this minute (fresh read ${spot.price}); ` +
          `posts are write-once, so settlement uses the existing post.`,
      );
    }
    try {
      publishTxHash = await factory.write.publishSettlement([seriesId, []]);
      await publicClient.waitForTransactionReceipt({ hash: publishTxHash });
    } catch (error) {
      throw new Error(`publishSettlement reverted: ${explainRevert(error)}`);
    }
  } else {
    if (mockPyth === undefined) {
      throw new Error("publishSettlementForSeries needs either priceOracle or mockPyth.");
    }
    const updateDatum = (await mockPyth!.read.createPriceFeedUpdateData([
      series.pythFeedId,
      spot.price,
      spot.conf,
      spot.expo,
      spot.price, // emaPrice: real spot reused for this demo
      spot.conf, // emaConf: real conf reused for this demo
      stampedPublishTime,
      0n, // prevPublishTime
    ])) as Hex;
    updateData = [updateDatum];

    updateFee = (await mockPyth!.read.getUpdateFee([updateData])) as bigint;
    const publisherMon = await publicClient.getBalance({ address: publisher });
    log(`  MockPyth getUpdateFee = ${formatMON(updateFee)} MON, publisher has ${formatMON(publisherMon)} MON`);
    if (publisherMon < updateFee) {
      throw new Error(
        `Publisher ${publisher} needs at least ${formatMON(updateFee)} MON to pay the MockPyth update fee ` +
          `(has ${formatMON(publisherMon)}). Fund it from ${MONAD_TESTNET.faucet} and re-run.`,
      );
    }

    if (dryRun) {
      log(
        `  [dry-run] would send factory.publishSettlement(${seriesId}, <1 update>) with value=` +
          `${formatMON(updateFee)} MON — no transaction sent.`,
      );
      return {
        publishTxHash: null,
        settledPrice: null,
        settledPublishTime: null,
        stampedPublishTime,
        observationEnd,
        settlementDeadline,
        hermes: spot,
        impliedConfidenceBps,
        updateFee,
        dryRun: true,
      };
    }

    try {
      publishTxHash = await factory.write.publishSettlement([seriesId, updateData], { value: updateFee });
      await publicClient.waitForTransactionReceipt({ hash: publishTxHash });
    } catch (error) {
      const reason = explainRevert(error);
      const rawMessage = error instanceof Error ? error.message : String(error);
      // The revert may belong to the nested MockPyth call rather than
      // TendSeriesFactory, so viem can only print a raw selector for it — match
      // it against Pyth's own known errors to make the failure legible.
      const pythErrorName = matchPythErrorSelector(rawMessage);
      throw new Error(
        `publishSettlement reverted: ${reason}` +
          (pythErrorName !== undefined
            ? ` (identified as Pyth's own ${pythErrorName}() error from the nested MockPyth call)`
            : ""),
      );
    }
  }
  log(`  publishSettlement tx: ${publishTxHash}`);
  log(`  explorer:             ${explorerTx(publishTxHash)}`);

  const settlement = (await factory.read.getSettlement([seriesId])) as {
    finalized: boolean;
    price: bigint;
    publishTime: bigint;
  };
  log(
    `  Settlement read-back: finalized=${settlement.finalized}, price=` +
      `${(Number(settlement.price) / 1e8).toFixed(2)} (raw ${settlement.price}), ` +
      `publishTime=${settlement.publishTime}`,
  );
  if (!settlement.finalized) {
    throw new Error("getSettlement().finalized is still false after publishSettlement.");
  }

  return {
    publishTxHash,
    settledPrice: settlement.price,
    settledPublishTime: settlement.publishTime,
    stampedPublishTime,
    observationEnd,
    settlementDeadline,
    hermes: spot,
    impliedConfidenceBps,
    updateFee,
    dryRun: false,
  };
}

/// Picks the settlement oracle a deployment actually uses. TendPriceOracle
/// wins when the manifest records one; MockPyth is the legacy fallback.
export async function loadSettlementOracle(
  viem: { getContractAt: (name: never, address: Hex) => Promise<unknown> },
  contracts: { priceOracle?: string; mockPyth?: string },
): Promise<{ priceOracle?: SettlementPriceOracleContract; mockPyth?: SettlementMockPythContract }> {
  if (contracts.priceOracle) {
    return {
      priceOracle: (await viem.getContractAt("TendPriceOracle" as never, contracts.priceOracle as Hex)) as SettlementPriceOracleContract,
    };
  }
  if (contracts.mockPyth) {
    return {
      mockPyth: (await viem.getContractAt("DeployableMockPyth" as never, contracts.mockPyth as Hex)) as SettlementMockPythContract,
    };
  }
  throw new Error("Manifest records neither contracts.priceOracle nor contracts.mockPyth.");
}
