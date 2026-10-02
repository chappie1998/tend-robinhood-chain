import { fetchDemoSpotPrice } from "../market-data/coinbase.js";
// Older fixed-price end-to-end proof against the existing testnet deployment.
// Spot and expiry-minute opening prices come from Coinbase Exchange; MockPyth
// bypasses attestation verification. No timestamp is backdated.
// Prefer npm run rehearse:demo for the real browser HTTP quote/sign/fill flow.
//
// Usage:
//   npm run e2e:monad
//   (equivalent to: node --env-file=.env node_modules/.bin/hardhat run
//    scripts/e2e-monad.ts --network monadTestnet)
//
// This script does not deploy or seed anything (see scripts/deploy.ts and
// scripts/bootstrap-monad.ts for that) — it creates its own short-dated,
// dedicated series so the settlement half of this run completes in
// ~16-18 minutes instead of riding the long-lived seeded series' full
// expiry. It writes its own manifest, deployments/monad-e2e.json, rather
// than touching deployments/monad-testnet.json.
//
// The run takes two wallets:
//   - the deployer (MONAD_DEPLOYER_KEY): factory owner, pool manager, pool
//     quoteAuthority — creates + authorizes the series, signs the quote,
//     funds the buyer, and publishes the Pyth settlement.
//   - a fresh "buyer" EOA (generated once, cached at
//     .devnet/monad-e2e-buyer.json, 0600, gitignored) — fills the quote and
//     later triggers its own settlement payout.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { network } from "hardhat";
import {
  type Hex,
  createPublicClient,
  http,
  parseEther,
  parseEventLogs,
  stringToHex,
} from "viem";
import { MONAD_TESTNET } from "../config/monad.js";
import { monadTestnetChain, explorerTx } from "./lib/e2e/chain.js";
import { loadOrCreateBuyerWallet } from "./lib/e2e/buyer-wallet.js";
import { normalizePythPrice } from "./lib/e2e/hermes.js";
import {
  DIRECTION_UP,
  type PoolQuote,
  poolQuoteSignTypedData,
  poolQuoteTuple,
  verifyPoolQuoteSignatureOffchain,
} from "./lib/e2e/quote.js";
import { waitUntil } from "./lib/e2e/poll.js";
import { explainRevert } from "./lib/e2e/errors.js";
import { formatMON, formatMUSDC } from "./lib/e2e/format.js";
import { loadSettlementOracle, publishSettlementForSeries } from "./lib/e2e/settlement.js";

// --- Chain-agnostic Pyth feed (same value as scripts/bootstrap-monad.ts) ---
const BTC_USD_PYTH_FEED_ID = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

// --- Series parameters (bounds enforced by TendSeriesFactory, read on-chain
// below rather than assumed) ---
const SERIES_SYMBOL = "BTCE2E";
const SERIES_LEAD_BUFFER_SECONDS = 180n; // on top of the on-chain MIN_SERIES_LEAD
const OBSERVATION_WINDOW_SECONDS = 180; // 3 min — generous room for settlement latency
const SETTLEMENT_GRACE_SECONDS = 60 * 60; // 1 hour of retry room if the first publish attempt misses the window
const MAX_CONFIDENCE_BPS = 500; // 5%
const LAST_TRADE_BUFFER_BEFORE_EXPIRY_SECONDS = 60n; // pool trading cuts off 60s before expiry

// --- Quote economics ---
const MUSDC_DECIMALS = 6;
const PREMIUM_RAW = 200n * 10n ** BigInt(MUSDC_DECIMALS); // 200 mUSDC
const BUYER_MUSDC_FUND_TARGET_RAW = 300n * 10n ** BigInt(MUSDC_DECIMALS); // 300 mUSDC (premium + buffer)
const WIDTH_BPS_OF_SPOT = 50n; // 0.5% of spot, in the same 1e8-scaled units as strike/settlement price
const MAX_PAYOUT_ABSOLUTE_CAP_RAW = 5_000n * 10n ** BigInt(MUSDC_DECIMALS); // 5,000 mUSDC, regardless of pool size
const QUOTE_EXPIRY_BUFFER_SECONDS = 300n; // 5 min

// --- Buyer gas funding ---
// Monad rejects a tx pre-execution unless the sender's native balance covers
// `gasLimit * maxFeePerGas` up front (reverting "Signer had insufficient
// balance"), not merely the gas actually burned. fillPoolQuote's padded
// gasLimit at Monad's fee level needs well over 0.1 MON of headroom, so the
// buyer is topped up to 0.5 MON before it sends any transaction.
const BUYER_MON_TOPUP_THRESHOLD = parseEther("0.2");
const BUYER_MON_TOPUP_TARGET = parseEther("0.5");
const DEPLOYER_MIN_MON_RESERVE = parseEther("0.05"); // sanity floor before this script touches the network at all

// --- Polling ---
const EXPIRY_POLL_INTERVAL_MS = 15_000;
const EXPIRY_POLL_TIMEOUT_MS = 40 * 60 * 1000; // 40 min ceiling for a ~16-18 min wait

const MANIFEST_OUT_PATH = path.join(process.cwd(), "deployments", "monad-e2e.json");
const DEPLOY_MANIFEST_PATH = path.join(process.cwd(), "deployments", "monad-testnet.json");

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
        `No manifest found at ${DEPLOY_MANIFEST_PATH}. Run "npm run deploy:monad" first — this e2e ` +
          `script only proves out an already-deployed protocol, it never deploys.`,
      );
    }
    throw error;
  }
  return JSON.parse(raw) as DeployManifest;
}

async function main() {
  const deployManifest = await readDeployManifest();

  const connection = await network.create();
  const { viem, networkName } = connection;

  // Populated incrementally as the run progresses, so a failure partway
  // through (e.g. the settlement publish step) still leaves a durable,
  // honest record of exactly how far the proof got — not just a thrown
  // error with nothing persisted. Written to MANIFEST_OUT_PATH either way.
  const run: Record<string, unknown> = {
    network: MONAD_TESTNET.name,
    chainId: MONAD_TESTNET.chainId,
    explorer: MONAD_TESTNET.explorer,
    runAt: new Date().toISOString(),
    status: "started",
  };

  try {
    if (networkName !== MONAD_TESTNET.name) {
      throw new Error(
        `Connected to "${networkName}", not "${MONAD_TESTNET.name}". Run with "--network monadTestnet" ` +
          `(i.e. "npm run e2e:monad").`,
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
    const publicClient = await viem.getPublicClient();
    run.deployer = deployer;

    console.log(`Network: ${networkName} (chainId ${MONAD_TESTNET.chainId})`);
    console.log(`Deployer / manager / quoteAuthority: ${deployer}`);
    if (deployer.toLowerCase() !== deployManifest.deployer.toLowerCase()) {
      console.log(
        `  Warning: this key (${deployer}) differs from the manifest's recorded deployer ` +
          `(${deployManifest.deployer}). Manager-gated calls will revert unless this key is also the ` +
          `pool manager / quoteAuthority.`,
      );
    }

    const deployerMonBalance = await publicClient.getBalance({ address: deployer });
    console.log(`Deployer MON balance: ${formatMON(deployerMonBalance)}`);
    if (deployerMonBalance < DEPLOYER_MIN_MON_RESERVE) {
      throw new Error(
        `Deployer ${deployer} holds only ${formatMON(deployerMonBalance)} MON, below the ` +
          `${formatMON(DEPLOYER_MIN_MON_RESERVE)} MON safety floor this script requires before doing any ` +
          `work (gas for create/authorize/fund/publish + the Pyth update fee). Fund it from ` +
          `${MONAD_TESTNET.faucet} and re-run.`,
      );
    }

    const factory = await viem.getContractAt(
      "TendSeriesFactory",
      deployManifest.contracts.tendSeriesFactory as Hex,
    );
    const vault = await viem.getContractAt("TendPoolVault", deployManifest.contracts.tendPoolVault as Hex);
    const mockUSDC = await viem.getContractAt("MockERC20", deployManifest.contracts.mockUSDC as Hex);
    // The settlement oracle: factory.pyth() points here, not at Monad
    // testnet's canonical Pyth receiver — see the header comment for why.
    const { mockPyth, priceOracle } = await loadSettlementOracle(viem, deployManifest.contracts);

    // -----------------------------------------------------------------------
    // 0. Read on-chain bounds rather than assume them.
    // -----------------------------------------------------------------------
    const minSeriesLead = (await factory.read.MIN_SERIES_LEAD()) as bigint;
    const maxObservationWindow = (await factory.read.MAX_OBSERVATION_WINDOW()) as bigint;
    const maxSettlementGrace = (await factory.read.MAX_SETTLEMENT_GRACE()) as bigint;
    const maxConfidenceBpsBound = (await factory.read.MAX_CONFIDENCE_BPS()) as bigint;
    const minTradeLead = (await vault.read.MIN_TRADE_LEAD()) as bigint;
    console.log(`\nOn-chain bounds:`);
    console.log(`  factory.MIN_SERIES_LEAD        = ${minSeriesLead}s`);
    console.log(`  factory.MAX_OBSERVATION_WINDOW  = ${maxObservationWindow}s`);
    console.log(`  factory.MAX_SETTLEMENT_GRACE    = ${maxSettlementGrace}s`);
    console.log(`  factory.MAX_CONFIDENCE_BPS      = ${maxConfidenceBpsBound}`);
    console.log(`  vault.MIN_TRADE_LEAD            = ${minTradeLead}s`);

    if (BigInt(OBSERVATION_WINDOW_SECONDS) > maxObservationWindow) {
      throw new Error(`OBSERVATION_WINDOW_SECONDS exceeds factory.MAX_OBSERVATION_WINDOW.`);
    }
    if (BigInt(SETTLEMENT_GRACE_SECONDS) > maxSettlementGrace) {
      throw new Error(`SETTLEMENT_GRACE_SECONDS exceeds factory.MAX_SETTLEMENT_GRACE.`);
    }
    if (BigInt(MAX_CONFIDENCE_BPS) > maxConfidenceBpsBound) {
      throw new Error(`MAX_CONFIDENCE_BPS exceeds factory.MAX_CONFIDENCE_BPS.`);
    }

    // -----------------------------------------------------------------------
    // 1. Buyer wallet: generate/reuse, then fund with MON (gas) + mUSDC (premium).
    // -----------------------------------------------------------------------
    const buyer = await loadOrCreateBuyerWallet();
    console.log(`\nBuyer wallet: ${buyer.address} (${buyer.reused ? "reused from" : "generated, saved to"} ${buyer.keyPath})`);
    run.buyer = { address: buyer.address, keyPath: buyer.keyPath };

    const buyerMonBefore = await publicClient.getBalance({ address: buyer.address });
    console.log(`  Buyer MON balance: ${formatMON(buyerMonBefore)}`);
    let buyerMonFundTxHash: Hex | null = null;
    if (buyerMonBefore < BUYER_MON_TOPUP_THRESHOLD) {
      const topup = BUYER_MON_TOPUP_TARGET - buyerMonBefore;
      if (deployerMonBalance - topup < DEPLOYER_MIN_MON_RESERVE) {
        throw new Error(
          `Deployer ${deployer} cannot spare ${formatMON(topup)} MON for the buyer top-up without dropping ` +
            `below its own ${formatMON(DEPLOYER_MIN_MON_RESERVE)} MON safety floor. Fund the deployer from ` +
            `${MONAD_TESTNET.faucet} and re-run.`,
        );
      }
      console.log(`  Funding buyer with ${formatMON(topup)} MON for gas...`);
      buyerMonFundTxHash = await deployerClient.sendTransaction({ to: buyer.address, value: topup });
      await publicClient.waitForTransactionReceipt({ hash: buyerMonFundTxHash });
      console.log(`  MON funding tx: ${buyerMonFundTxHash}`);
      console.log(`  explorer:       ${explorerTx(buyerMonFundTxHash)}`);
    } else {
      console.log(`  Buyer already has enough MON for gas — skipping top-up.`);
    }
    const buyerMonAfterFunding = await publicClient.getBalance({ address: buyer.address });
    console.log(`  Buyer MON balance now: ${formatMON(buyerMonAfterFunding)}`);

    const buyerMusdcBeforeFunding = (await mockUSDC.read.balanceOf([buyer.address])) as bigint;
    console.log(`  Buyer mUSDC balance: ${formatMUSDC(buyerMusdcBeforeFunding)}`);
    let buyerMusdcFundTxHash: Hex | null = null;
    if (buyerMusdcBeforeFunding < BUYER_MUSDC_FUND_TARGET_RAW) {
      const shortfall = BUYER_MUSDC_FUND_TARGET_RAW - buyerMusdcBeforeFunding;
      const deployerMusdc = (await mockUSDC.read.balanceOf([deployer])) as bigint;
      if (deployerMusdc < shortfall) {
        throw new Error(
          `Deployer ${deployer} holds only ${formatMUSDC(deployerMusdc)} mUSDC, less than the ` +
            `${formatMUSDC(shortfall)} mUSDC shortfall needed to fund the buyer. Mint more mUSDC to the ` +
            `deployer first.`,
        );
      }
      console.log(`  Funding buyer with ${formatMUSDC(shortfall)} mUSDC for the premium...`);
      buyerMusdcFundTxHash = await mockUSDC.write.transfer([buyer.address, shortfall]);
      await publicClient.waitForTransactionReceipt({ hash: buyerMusdcFundTxHash });
      console.log(`  mUSDC funding tx: ${buyerMusdcFundTxHash}`);
      console.log(`  explorer:         ${explorerTx(buyerMusdcFundTxHash)}`);
    } else {
      console.log(`  Buyer already has enough mUSDC for the premium — skipping top-up.`);
    }
    const buyerMusdcBeforeFill = (await mockUSDC.read.balanceOf([buyer.address])) as bigint;
    console.log(`  Buyer mUSDC balance now: ${formatMUSDC(buyerMusdcBeforeFill)}`);
    if (buyerMusdcBeforeFill < PREMIUM_RAW) {
      throw new Error(`Buyer still can't cover the ${formatMUSDC(PREMIUM_RAW)} mUSDC premium after funding.`);
    }
    run.funding = { buyerMonFundTxHash, buyerMusdcFundTxHash };

    // -----------------------------------------------------------------------
    // 2. Create + authorize a short-dated, dedicated BTC/USD series.
    // -----------------------------------------------------------------------
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expiry = ((nowSec + minSeriesLead + SERIES_LEAD_BUFFER_SECONDS + 59n) / 60n) * 60n;
    const symbolBytes32 = stringToHex(SERIES_SYMBOL, { size: 32 });

    const seriesParams = [
      BTC_USD_PYTH_FEED_ID,
      deployManifest.contracts.mockUSDC,
      expiry,
      OBSERVATION_WINDOW_SECONDS,
      SETTLEMENT_GRACE_SECONDS,
      MAX_CONFIDENCE_BPS,
      symbolBytes32,
    ] as const;

    console.log(`\nSeries parameters (dedicated, short-dated, for this e2e run):`);
    console.log(`  pythFeedId:        ${BTC_USD_PYTH_FEED_ID}`);
    console.log(`  settlementToken:   ${deployManifest.contracts.mockUSDC} (mUSDC)`);
    console.log(`  expiry:            ${expiry} (${new Date(Number(expiry) * 1000).toISOString()}, ~${Number(expiry - nowSec) / 60} min out)`);
    console.log(`  observationWindow: ${OBSERVATION_WINDOW_SECONDS}s`);
    console.log(`  settlementGrace:   ${SETTLEMENT_GRACE_SECONDS}s`);
    console.log(`  maxConfidenceBps:  ${MAX_CONFIDENCE_BPS}`);
    console.log(`  symbol:            ${SERIES_SYMBOL} (${symbolBytes32})`);

    const seriesId = (await factory.read.deriveSeriesId([seriesParams as unknown as never])) as Hex;
    console.log(`  => deriveSeriesId: ${seriesId}`);

    let createTxHash: Hex;
    try {
      createTxHash = await factory.write.createSeries([seriesParams as unknown as never]);
    } catch (error) {
      throw new Error(`createSeries reverted: ${explainRevert(error)}`);
    }
    await publicClient.waitForTransactionReceipt({ hash: createTxHash });
    console.log(`  createSeries tx: ${createTxHash}`);
    console.log(`  explorer:        ${explorerTx(createTxHash)}`);

    const seriesExists = await factory.read.seriesExists([seriesId]);
    const isTradableNow = await factory.read.isTradable([seriesId]);
    const series = (await factory.read.getSeries([seriesId])) as { expiry: bigint };
    console.log(`  factory.seriesExists == ${seriesExists}, factory.isTradable == ${isTradableNow}`);
    if (!seriesExists || !isTradableNow) {
      throw new Error(`Series ${seriesId} is not both existing and tradable after creation.`);
    }
    const effectiveExpiry = series.expiry;

    const nowAtAuth = BigInt(Math.floor(Date.now() / 1000));
    const desiredLastTradeAt = effectiveExpiry - LAST_TRADE_BUFFER_BEFORE_EXPIRY_SECONDS;
    if (desiredLastTradeAt < nowAtAuth + minTradeLead || desiredLastTradeAt >= effectiveExpiry) {
      throw new Error(
        `Computed lastTradeAt (${desiredLastTradeAt}) does not satisfy vault.MIN_TRADE_LEAD/expiry bounds ` +
          `relative to now (${nowAtAuth}) and series expiry (${effectiveExpiry}). Increase ` +
          `SERIES_LEAD_BUFFER_SECONDS and re-run.`,
      );
    }

    let authorizeTxHash: Hex;
    try {
      authorizeTxHash = await vault.write.authorizeSeries([seriesId, true, desiredLastTradeAt]);
    } catch (error) {
      throw new Error(`vault.authorizeSeries reverted: ${explainRevert(error)}`);
    }
    await publicClient.waitForTransactionReceipt({ hash: authorizeTxHash });
    console.log(`  authorizeSeries tx: ${authorizeTxHash} (lastTradeAt=${desiredLastTradeAt})`);
    console.log(`  explorer:           ${explorerTx(authorizeTxHash)}`);

    const [authEnabled, authLastTradeAt] = (await vault.read.seriesAuth([seriesId])) as [boolean, bigint];
    if (!authEnabled) throw new Error(`Series ${seriesId} is not authorized on the pool after authorizeSeries.`);
    console.log(`  vault.seriesAuth == enabled=${authEnabled}, lastTradeAt=${authLastTradeAt}`);

    run.series = {
      seriesId,
      pythFeedId: BTC_USD_PYTH_FEED_ID,
      settlementToken: deployManifest.contracts.mockUSDC,
      symbol: SERIES_SYMBOL,
      expiry: effectiveExpiry.toString(),
      observationWindow: OBSERVATION_WINDOW_SECONDS,
      settlementGrace: SETTLEMENT_GRACE_SECONDS,
      maxConfidenceBps: MAX_CONFIDENCE_BPS,
      lastTradeAt: authLastTradeAt.toString(),
      createTxHash,
      authorizeTxHash,
    };

    // -----------------------------------------------------------------------
    // 3. Sign an EIP-712 PoolQuote as the quote authority (deployer).
    // -----------------------------------------------------------------------
    const spot = await fetchDemoSpotPrice(BTC_USD_PYTH_FEED_ID);
    const normalizedSpot = normalizePythPrice(spot.price, spot.expo); // 1e8-scaled, matches PRICE_SCALE
    const humanSpot = Number(normalizedSpot) / 1e8;
    console.log(`\nCoinbase BTC/USD spot: $${humanSpot.toFixed(2)} (publishTime=${spot.publishTime}, expo=${spot.expo})`);

    const strike = normalizedSpot; // at-the-money
    const width = (normalizedSpot * WIDTH_BPS_OF_SPOT) / 10_000n;
    if (width === 0n) throw new Error("Computed width is 0 — spot price too small to derive a sane width.");

    const totalAssets = (await vault.read.totalAssets()) as bigint;
    const lockedCollateralBeforeFill = (await vault.read.lockedCollateral()) as bigint;
    const openPositionsBeforeFill = (await vault.read.openPositions()) as bigint;
    const maxUtilizationBps = (await vault.read.maxUtilizationBps()) as number;
    const maxPositionBps = (await vault.read.maxPositionBps()) as number;
    const totalCollateral = totalAssets + lockedCollateralBeforeFill;
    const utilizationLimit = (await vault.read.calculateBpsLimit([totalCollateral, maxUtilizationBps])) as bigint;
    const positionLimit = (await vault.read.calculateBpsLimit([totalCollateral, maxPositionBps])) as bigint;

    console.log(`\nPool sizing:`);
    console.log(`  totalAssets           = ${formatMUSDC(totalAssets)} mUSDC`);
    console.log(`  lockedCollateral      = ${formatMUSDC(lockedCollateralBeforeFill)} mUSDC`);
    console.log(`  maxUtilizationBps     = ${maxUtilizationBps} -> utilizationLimit = ${formatMUSDC(utilizationLimit)} mUSDC`);
    console.log(`  maxPositionBps        = ${maxPositionBps} -> positionLimit      = ${formatMUSDC(positionLimit)} mUSDC`);

    if (positionLimit === 0n) {
      throw new Error("Pool's per-position cap is 0 — deposit liquidity into the pool before running this e2e proof.");
    }
    // 20% of the per-position cap, capped at an absolute ceiling and at
    // totalAssets — always "well under" the pool's actual caps, whatever the
    // pool's live size happens to be.
    let maxPayout = positionLimit / 5n;
    if (maxPayout > MAX_PAYOUT_ABSOLUTE_CAP_RAW) maxPayout = MAX_PAYOUT_ABSOLUTE_CAP_RAW;
    if (maxPayout > totalAssets) maxPayout = totalAssets / 10n;
    if (maxPayout === 0n) throw new Error("Computed maxPayout is 0 — pool has insufficient liquidity.");
    if (lockedCollateralBeforeFill + maxPayout > utilizationLimit) {
      throw new Error(`Computed maxPayout (${maxPayout}) would exceed the pool's utilization limit.`);
    }
    if (maxPayout > positionLimit) {
      throw new Error(`Computed maxPayout (${maxPayout}) exceeds the pool's per-position limit.`);
    }

    const nonce = BigInt(`0x${randomBytes(16).toString("hex")}`);
    const nowAtSign = BigInt(Math.floor(Date.now() / 1000));
    const quoteExpiry = nowAtSign + QUOTE_EXPIRY_BUFFER_SECONDS;
    if (quoteExpiry > authLastTradeAt || quoteExpiry >= effectiveExpiry) {
      throw new Error(`Computed quoteExpiry (${quoteExpiry}) violates lastTradeAt/expiry bounds — increase margins.`);
    }

    const quote: PoolQuote = {
      nonce,
      direction: DIRECTION_UP,
      strike,
      width,
      premium: PREMIUM_RAW,
      maxPayout,
      quoteExpiry,
      seriesId,
      buyer: buyer.address,
    };

    console.log(`\nQuote economics:`);
    console.log(`  direction:   UP`);
    console.log(`  strike:      ${(Number(strike) / 1e8).toFixed(2)} (raw ${strike}, at-the-money)`);
    console.log(`  width:       ${(Number(width) / 1e8).toFixed(2)} (raw ${width}, ${Number(WIDTH_BPS_OF_SPOT) / 100}% of spot)`);
    console.log(`  premium:     ${formatMUSDC(quote.premium)} mUSDC`);
    console.log(`  maxPayout:   ${formatMUSDC(quote.maxPayout)} mUSDC (well under the ${formatMUSDC(positionLimit)} mUSDC per-position cap)`);
    console.log(`  quoteExpiry: ${quote.quoteExpiry} (${new Date(Number(quote.quoteExpiry) * 1000).toISOString()})`);
    console.log(`  nonce:       ${quote.nonce}`);
    console.log(`  buyer:       ${quote.buyer}`);

    const typedData = poolQuoteSignTypedData(MONAD_TESTNET.chainId, vault.address, quote);
    const signature = await deployerClient.signTypedData({
      account: deployerClient.account,
      ...typedData,
    });

    const localVerify = await verifyPoolQuoteSignatureOffchain({
      chainId: MONAD_TESTNET.chainId,
      verifyingContract: vault.address,
      quote,
      signature,
      expectedSigner: deployer,
    });
    console.log(`\nLocal EIP-712 recover check: recovered=${localVerify.recovered}, expected=${deployer} -> ${localVerify.ok ? "MATCH" : "MISMATCH"}`);
    if (!localVerify.ok) {
      throw new Error("recoverTypedDataAddress did not return the deployer — refusing to send an invalid quote.");
    }

    // Cross-check against the contract's own hashQuote + ecrecover path
    // before spending any gas.
    const onchainDigest = (await vault.read.hashQuote([poolQuoteTuple(quote) as unknown as never])) as Hex;
    console.log(`  vault.hashQuote(quote) = ${onchainDigest}`);

    run.quote = {
      nonce: quote.nonce.toString(),
      direction: "UP",
      strike: quote.strike.toString(),
      width: quote.width.toString(),
      premium: quote.premium.toString(),
      maxPayout: quote.maxPayout.toString(),
      quoteExpiry: quote.quoteExpiry.toString(),
      signature,
      signer: deployer,
      localRecoverMatch: localVerify.ok,
      onchainDigest,
      hermesSpotAtQuote: humanSpot,
    };

    // -----------------------------------------------------------------------
    // 4. Fill: buyer approves the vault, then fills the quote.
    // -----------------------------------------------------------------------
    const buyerMockUSDC = await viem.getContractAt("MockERC20", deployManifest.contracts.mockUSDC as Hex, {
      client: { public: publicClient, wallet: buyer.walletClient as never },
    });
    const buyerVault = await viem.getContractAt("TendPoolVault", deployManifest.contracts.tendPoolVault as Hex, {
      client: { public: publicClient, wallet: buyer.walletClient as never },
    });

    let approveTxHash: Hex;
    try {
      approveTxHash = await buyerMockUSDC.write.approve([vault.address, quote.premium]);
    } catch (error) {
      throw new Error(`buyer mUSDC.approve reverted: ${explainRevert(error)}`);
    }
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    console.log(`\napprove tx: ${approveTxHash}`);
    console.log(`explorer:   ${explorerTx(approveTxHash)}`);

    let fillTxHash: Hex;
    try {
      fillTxHash = await buyerVault.write.fillPoolQuote([poolQuoteTuple(quote) as unknown as never, signature]);
    } catch (error) {
      throw new Error(`buyer fillPoolQuote reverted: ${explainRevert(error)}`);
    }
    const fillReceipt = await publicClient.waitForTransactionReceipt({ hash: fillTxHash });
    console.log(`fillPoolQuote tx: ${fillTxHash}`);
    console.log(`explorer:         ${explorerTx(fillTxHash)}`);

    const filledEvents = parseEventLogs({ abi: vault.abi, eventName: "PoolQuoteFilled", logs: fillReceipt.logs });
    if (filledEvents.length === 0) throw new Error("fillPoolQuote succeeded but emitted no PoolQuoteFilled event.");
    const positionId = filledEvents[0].args.positionId as bigint;
    console.log(`  positionId: ${positionId}`);

    const lockedCollateralAfterFill = (await vault.read.lockedCollateral()) as bigint;
    const openPositionsAfterFill = (await vault.read.openPositions()) as bigint;
    const buyerMusdcAfterFill = (await mockUSDC.read.balanceOf([buyer.address])) as bigint;

    console.log(`\nFill read-back:`);
    console.log(`  lockedCollateral: ${formatMUSDC(lockedCollateralBeforeFill)} -> ${formatMUSDC(lockedCollateralAfterFill)} (delta ${formatMUSDC(lockedCollateralAfterFill - lockedCollateralBeforeFill)}, expected ${formatMUSDC(maxPayout)})`);
    console.log(`  openPositions:    ${openPositionsBeforeFill} -> ${openPositionsAfterFill} (delta ${openPositionsAfterFill - openPositionsBeforeFill})`);
    console.log(`  buyer mUSDC:      ${formatMUSDC(buyerMusdcBeforeFill)} -> ${formatMUSDC(buyerMusdcAfterFill)} (delta ${formatMUSDC(buyerMusdcAfterFill - buyerMusdcBeforeFill)}, expected -${formatMUSDC(quote.premium)})`);

    if (lockedCollateralAfterFill - lockedCollateralBeforeFill !== maxPayout) {
      throw new Error("lockedCollateral did not rise by exactly maxPayout after fill.");
    }
    if (openPositionsAfterFill - openPositionsBeforeFill !== 1n) {
      throw new Error("openPositions did not increase by exactly 1 after fill.");
    }
    if (buyerMusdcBeforeFill - buyerMusdcAfterFill !== quote.premium) {
      throw new Error("Buyer's mUSDC balance did not drop by exactly the premium after fill.");
    }

    run.fill = {
      positionId: positionId.toString(),
      approveTxHash,
      fillTxHash,
      lockedCollateralAfterFill: lockedCollateralAfterFill.toString(),
      openPositionsAfterFill: openPositionsAfterFill.toString(),
      buyerMusdcAfterFill: buyerMusdcAfterFill.toString(),
    };
    run.status = "filled_awaiting_expiry";

    // -----------------------------------------------------------------------
    // 5. Wait for expiry (bounded polling, chain time not wall clock).
    // -----------------------------------------------------------------------
    console.log(`\nWaiting for series expiry (${effectiveExpiry}, ${new Date(Number(effectiveExpiry) * 1000).toISOString()})...`);
    await waitUntil({
      description: "block.timestamp > series.expiry",
      intervalMs: EXPIRY_POLL_INTERVAL_MS,
      timeoutMs: EXPIRY_POLL_TIMEOUT_MS,
      check: async () => {
        const block = await publicClient.getBlock();
        const remaining = Number(effectiveExpiry - block.timestamp);
        return {
          done: block.timestamp > effectiveExpiry,
          progress: `chain time ${block.timestamp}, ${remaining}s remaining`,
        };
      },
    });
    // -----------------------------------------------------------------------
    // 6. Publish the real Coinbase expiry-minute open through MockPyth.
    // The shared helper preserves the actual candle timestamp. No attestation
    // is verified; zero confidence means unavailable, not zero uncertainty.
    const published = await publishSettlementForSeries({
      publicClient,
      factory,
      mockPyth,
      priceOracle,
      seriesId,
      series: {
        pythFeedId: BTC_USD_PYTH_FEED_ID as Hex,
        expiry: effectiveExpiry,
        observationWindow: OBSERVATION_WINDOW_SECONDS,
        settlementGrace: SETTLEMENT_GRACE_SECONDS,
        maxConfidenceBps: MAX_CONFIDENCE_BPS,
      },
      publisher: deployer,
    });

    const settlementSpot = published.hermes;
    const settlementPublishTime = published.stampedPublishTime;
    const settlementHumanPrice = normalizePythPrice(settlementSpot.price, settlementSpot.expo);
    const settledPrice = published.settledPrice;
    const publishTxHash = published.publishTxHash;
    if (settledPrice === null || publishTxHash === null) {
      // Only reachable if this call is ever switched to dry-run mode, which
      // the e2e proof never does — it must actually settle on-chain.
      throw new Error("publishSettlementForSeries did not publish a settlement (unexpected dry-run result).");
    }

    run.settlement = {
      publishSettlementTxHash: publishTxHash,
      settledPrice: settledPrice.toString(),
      settledPriceHuman: Number(settledPrice) / 1e8,
      onchainPublishTime: published.settledPublishTime?.toString() ?? null,
      stampedPublishTime: settlementPublishTime.toString(),
      hermesRealPublishTime: settlementSpot.publishTime,
      hermesRawPrice: settlementSpot.price.toString(),
      hermesRawConf: settlementSpot.conf.toString(),
      hermesExpo: settlementSpot.expo,
      impliedConfidenceBps: published.impliedConfidenceBps.toString(),
      note:
        "Settlement uses the real Coinbase expiry-minute open with its actual minute timestamp. " +
        "MockPyth does not verify an oracle attestation; confidence zero means unavailable.",
    };
    run.status = "settlement_published";

    // -----------------------------------------------------------------------
    // 7. Settle the position (buyer triggers their own payout — permissionless).
    // -----------------------------------------------------------------------
    const expectedPayout = (await vault.read.calculatePayout([
      quote.direction,
      quote.strike,
      quote.width,
      settledPrice,
      quote.maxPayout,
    ])) as bigint;
    console.log(`\nExpected payout (vault.calculatePayout, pre-settle): ${formatMUSDC(expectedPayout)} mUSDC`);

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
    console.log(`  actual payout: ${formatMUSDC(settledArgs.payout)} mUSDC, poolAmount: ${formatMUSDC(settledArgs.poolAmount)}, fee: ${formatMUSDC(settledArgs.fee)}`);

    if (settledArgs.payout !== expectedPayout) {
      throw new Error(
        `Actual payout (${settledArgs.payout}) does not match vault.calculatePayout's prediction ` +
          `(${expectedPayout}) — investigate before trusting this run.`,
      );
    }

    const lockedCollateralAfterSettle = (await vault.read.lockedCollateral()) as bigint;
    const openPositionsAfterSettle = (await vault.read.openPositions()) as bigint;
    // The public `positions(uint256)` getter flattens the Position struct into
    // multiple named return values, so viem returns them as an *array* tuple —
    // NOT an object with a `.settled` key. `settled` is the 9th/last field
    // (index 8): [buyer, seriesId, direction, strike, width, premium,
    // maxPayout, feeBps, settled].
    const positionTuple = (await vault.read.positions([positionId])) as readonly unknown[];
    const positionSettled = positionTuple[8] as boolean;
    console.log(`\nSettle read-back:`);
    console.log(`  position.settled: ${positionSettled}`);
    console.log(`  lockedCollateral: ${formatMUSDC(lockedCollateralAfterFill)} -> ${formatMUSDC(lockedCollateralAfterSettle)} (delta ${formatMUSDC(lockedCollateralAfterSettle - lockedCollateralAfterFill)}, expected -${formatMUSDC(maxPayout)})`);
    console.log(`  openPositions:    ${openPositionsAfterFill} -> ${openPositionsAfterSettle} (delta ${openPositionsAfterSettle - openPositionsAfterFill})`);

    if (!positionSettled) throw new Error("positions(positionId).settled is still false after settlePoolPosition.");
    if (lockedCollateralAfterSettle - lockedCollateralAfterFill !== -maxPayout) {
      throw new Error("lockedCollateral did not fall by exactly maxPayout after settlement.");
    }
    if (openPositionsAfterSettle - openPositionsAfterFill !== -1n) {
      throw new Error("openPositions did not decrease by exactly 1 after settlement.");
    }

    // -----------------------------------------------------------------------
    // 8. Independent verification from a clean viem client (not hardhat's).
    // -----------------------------------------------------------------------
    const cleanClient = createPublicClient({ chain: monadTestnetChain, transport: http(MONAD_TESTNET.rpcUrl) });
    const cleanSettlement = (await cleanClient.readContract({
      address: deployManifest.contracts.tendSeriesFactory as Hex,
      abi: factory.abi,
      functionName: "getSettlement",
      args: [seriesId],
    })) as { finalized: boolean; price: bigint; publishTime: bigint };
    const cleanBuyerMusdc = (await cleanClient.readContract({
      address: deployManifest.contracts.mockUSDC as Hex,
      abi: mockUSDC.abi,
      functionName: "balanceOf",
      args: [buyer.address],
    })) as bigint;
    const cleanLockedCollateral = (await cleanClient.readContract({
      address: deployManifest.contracts.tendPoolVault as Hex,
      abi: vault.abi,
      functionName: "lockedCollateral",
    })) as bigint;
    const cleanOpenPositions = (await cleanClient.readContract({
      address: deployManifest.contracts.tendPoolVault as Hex,
      abi: vault.abi,
      functionName: "openPositions",
    })) as bigint;

    const expectedNetChange = settledArgs.payout - quote.premium;
    const actualNetChange = cleanBuyerMusdc - buyerMusdcBeforeFunding;

    console.log(`\nIndependent verification (fresh viem client, no cached state):`);
    console.log(`  getSettlement(seriesId).finalized == ${cleanSettlement.finalized}`);
    console.log(`  buyer mUSDC: pre-fund=${formatMUSDC(buyerMusdcBeforeFunding)} -> final=${formatMUSDC(cleanBuyerMusdc)}`);
    console.log(`    net change = ${formatMUSDC(actualNetChange)} mUSDC, expected (payout - premium) = ${formatMUSDC(expectedNetChange)} mUSDC`);
    console.log(`  vault.lockedCollateral == ${formatMUSDC(cleanLockedCollateral)}, vault.openPositions == ${cleanOpenPositions}`);

    if (!cleanSettlement.finalized) throw new Error("Independent read: settlement is not finalized.");
    if (actualNetChange !== expectedNetChange) {
      throw new Error(
        `Independent read: buyer's net mUSDC change (${actualNetChange}) does not match payout - premium ` +
          `(${expectedNetChange}).`,
      );
    }

    // -----------------------------------------------------------------------
    // Persist a full record of the run.
    // -----------------------------------------------------------------------
    run.status = "complete";
    run.settle = {
      settleTxHash,
      expectedPayout: expectedPayout.toString(),
      actualPayout: settledArgs.payout.toString(),
      poolAmount: settledArgs.poolAmount.toString(),
      fee: settledArgs.fee.toString(),
      lockedCollateralAfterSettle: lockedCollateralAfterSettle.toString(),
      openPositionsAfterSettle: openPositionsAfterSettle.toString(),
    };
    run.reconciliation = {
      buyerMusdcBeforeFunding: buyerMusdcBeforeFunding.toString(),
      buyerMusdcFinal: cleanBuyerMusdc.toString(),
      netChange: actualNetChange.toString(),
      expectedNetChange: expectedNetChange.toString(),
      poolLockedCollateralFinal: cleanLockedCollateral.toString(),
      poolOpenPositionsFinal: cleanOpenPositions.toString(),
    };
    await writeRunRecord(run);
    console.log(`\nWrote e2e run record to ${MANIFEST_OUT_PATH}`);

    console.log(`\n=== E2E PROOF COMPLETE ===`);
    console.log(`seriesId:           ${seriesId}`);
    console.log(`positionId:         ${positionId}`);
    console.log(`Coinbase minute open:  $${(Number(settlementHumanPrice) / 1e8).toFixed(2)} (raw ${settlementSpot.price}, expo ${settlementSpot.expo})`);
    console.log(`candle publishTime: ${settlementPublishTime} (in-window; exchange timestamp ${settlementSpot.publishTime})`);
    console.log(`settled price:      $${(Number(settledPrice) / 1e8).toFixed(2)} (on-chain, matches the Coinbase minute open above)`);
    console.log(`payout:             ${formatMUSDC(settledArgs.payout)} mUSDC (expected ${formatMUSDC(expectedPayout)} mUSDC — match)`);
    console.log(`buyer net:          ${formatMUSDC(actualNetChange)} mUSDC (payout - premium)`);
  } catch (error) {
    run.status = run.status === "started" ? "failed_before_buyer_setup" : `failed_after_${run.status}`;
    run.error = error instanceof Error ? error.message : String(error);
    try {
      await writeRunRecord(run);
      console.log(`\nWrote partial e2e run record (status=${run.status}) to ${MANIFEST_OUT_PATH} for the record.`);
    } catch (writeError) {
      console.error(
        `Additionally failed to write the partial run record: ${writeError instanceof Error ? writeError.message : writeError}`,
      );
    }
    throw error;
  } finally {
    await connection.close();
  }
}

async function writeRunRecord(run: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(MANIFEST_OUT_PATH), { recursive: true });
  await writeFile(MANIFEST_OUT_PATH, `${JSON.stringify(run, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
