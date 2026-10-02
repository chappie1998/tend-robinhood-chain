import { QUOTE_TTL_SECONDS } from "../config/quotes.js";
import { fetchDemoSpotPrice } from "../market-data/coinbase.js";
// Shared, transport-agnostic quote derivation + signing.
//
// This is the ONE implementation of the PoolQuote pipeline: validate the
// request -> read series/pool state on-chain -> fetch the Coinbase spot and
// realized volatility -> derive width/maxPayout (as scripts/e2e-monad.ts)
// and price strike/premium with the Black-Scholes engine (pricing.ts) ->
// EIP-712 sign with the quoteAuthority key -> self-verify the signature.
//
// Both the standalone HTTP service (quote-service/server.ts) and the Vercel
// serverless function (api/quote.ts) call `deriveAndSignQuote` so the two
// transports can NEVER drift: a quote signed by either is byte-identical to
// one the e2e proof would sign. Everything transport-specific (HTTP routing,
// CORS, rate limiting, startup wiring) stays out of this file.
//
// Pricing: the quote preserves the established PoolQuote ABI but uses a width
// of one raw price tick. This makes the deployed vault's payout strict binary
// at expiry. The selected 1.5x/2x/3x payout tier sets the premium and escrow
// exactly; the strike ladder solves a risk-neutral win probability and rounds
// against the buyer before signing.
import { randomBytes } from "node:crypto";
import {
  type Hex,
  type PublicClient,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { ACTIVE_CHAIN } from "../config/activeChain.js";
import { normalizePythPrice } from "../scripts/lib/e2e/hermes.js";
import {
  DIRECTION_DOWN,
  DIRECTION_UP,
  type PoolQuote,
  poolQuoteSignTypedData,
  verifyPoolQuoteSignatureOffchain,
} from "../scripts/lib/e2e/quote.js";
import { FACTORY_ABI, VAULT_ABI } from "./abi.js";
import { formatPriceForDisplay } from "./formatPrice.js";
import { MAKER_EDGE_BPS, VolatilityUnavailableError, realizedVolatility } from "./pricing.js";
import { binaryTerms, DEFAULT_TILE, isTileIndex, strikeLadder, type TileIndex } from "./strikeLadder.js";

// --- Fixed terms (mirrors scripts/e2e-monad.ts) -----------------------------
const BPS_DENOMINATOR = 10_000n;
// Quote validity window. A signed quote is a free option on the pool for its
// own lifetime — the buyer can wait out the window watching spot move before
// deciding whether to fill, at no cost, while the pool is on the hook for the
// signed terms the whole time. Monte Carlo at 33% annualized vol measured
// that optionality against the maker edge (MAKER_EDGE_BPS in pricing.ts):
// at 120s it consumes ~26% of the maker edge on a 10x position and ~46% on
// a 50x one; at 30s that drops to ~4% and ~11%. 30s is the deliberately chosen
// value — do NOT raise it without re-running that analysis, since a longer
// window is a bigger giveaway at the pool's expense and the effect is worst
// worst at exactly the far-out strikes this product leads with.

const MUSDC_DECIMALS = 6;
const DEFAULT_PREMIUM_HUMAN = "10"; // mUSDC the trader pays, before pool clamps
const PRICE_SCALE = 100_000_000; // 1e8, the contract's PRICE_SCALE (TendSeriesFactory._normalizePrice)
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * THE MODEL: the trader selects one fixed binary winning payout tier and an
 * offered premium. A one-tick width retains quote ABI compatibility while
 * making the vault pay all-or-zero at expiry. The service chooses a
 * conservative strike whose model win probability cannot underprice that tier.
 */

const SERIES_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Normalizes a private key supplied through an environment variable, which in
 * practice is pasted by a human into a hosting dashboard. Tolerates the two
 * harmless paste artifacts — surrounding whitespace/newlines and matching
 * quotes — and supplies the `0x` prefix when it is missing, since a bare
 * 64-hex-character key is the other common form.
 *
 * Anything else is rejected. The error deliberately reports only the SHAPE of
 * the value (its length, whether it parsed as hex) and never the value itself
 * or any fragment of it, so a misconfigured key can be diagnosed from a log
 * without the log becoming a place the key leaks.
 */
export function normalizePrivateKey(raw: string | undefined, envName: string): Hex {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${envName} is not set. Configure it as an environment variable (the 0x-prefixed private key of ` +
        `the pool's quoteAuthority).`,
    );
  }

  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  // A pasted `NAME=0x...` line is a common slip; keep only what follows the `=`.
  const eq = value.indexOf("=");
  if (eq !== -1 && value.slice(0, eq).trim() === envName) value = value.slice(eq + 1).trim();

  const body = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error(
      `${envName} is not a valid private key: expected 64 hex characters (optionally 0x-prefixed), but got ` +
        `${body.length} character(s) that are ${/^[0-9a-fA-F]*$/.test(body) ? "valid hex" : "not all hex"}. ` +
        `The value itself is never logged — re-copy it exactly, with no surrounding quotes or newline.`,
    );
  }
  return `0x${body.toLowerCase()}` as Hex;
}

// ---------------------------------------------------------------------------
// Typed errors — thrown out of deriveAndSignQuote, mapped to HTTP status by
// whichever transport is calling.
// ---------------------------------------------------------------------------
export interface HttpError {
  status: number;
  message: string;
}
export function httpError(status: number, message: string): HttpError {
  return { status, message };
}
const badRequest = (m: string) => httpError(400, m);
const conflict = (m: string) => httpError(409, m);

/// Narrows an unknown thrown value to an HttpError (`{ status, message }`).
export function isHttpError(err: unknown): err is HttpError {
  const maybe = err as Partial<HttpError> | null;
  return (
    typeof maybe === "object" &&
    maybe !== null &&
    typeof maybe.status === "number" &&
    typeof maybe.message === "string"
  );
}

/// Series tuple shape returned by factory.getSeries (see abi.ts / ITendSeriesFactory.Series).
interface Series {
  creator: Hex;
  pythFeedId: Hex;
  settlementToken: Hex;
  expiry: bigint;
  observationWindow: number;
  settlementGrace: number;
  maxConfidenceBps: number;
  symbol: Hex;
  enabled: boolean;
}

export interface QuoteRequest {
  seriesId: Hex;
  direction: number;
  buyer: Hex;
  /** Maximum raw settlement premium the trader offers; capacity may reduce it. */
  premiumRaw: bigint;
  /** Fixed binary winning payout tier: 0=1.5x, 1=2x, 2=3x. */
  tile: TileIndex;
}

/// Validates and normalizes the request body. Throws { status, message } on bad
/// input. Exported so the standalone HTTP transport can derive its rate-limit
/// key (the validated buyer) with exactly the same validation the pipeline uses.
export function parseQuoteRequest(body: unknown): QuoteRequest {
  if (typeof body !== "object" || body === null) throw badRequest("Body must be a JSON object.");
  const b = body as Record<string, unknown>;

  const seriesId = b.seriesId;
  if (typeof seriesId !== "string" || !SERIES_ID_RE.test(seriesId)) {
    throw badRequest("`seriesId` must be a 32-byte 0x-prefixed hex string.");
  }
  const buyer = b.buyer;
  if (typeof buyer !== "string" || !isAddress(buyer)) {
    throw badRequest("`buyer` must be a valid 0x address.");
  }
  const dir = b.direction;
  if (dir !== "up" && dir !== "down") {
    throw badRequest('`direction` must be "up" or "down".');
  }

  // Fail loudly on the old request shape rather than quietly defaulting a
  // stale client into a trade it did not ask for.
  if (b.leverage !== undefined || b.maxPayout !== undefined) {
    throw badRequest(
      "`leverage`/`maxPayout` are no longer accepted: pick a payout tier with `tile` (0-2) and say what you pay " +
        "with `premium`. Each tile is a fixed binary payout tier.",
    );
  }

  let premiumRaw: bigint;
  const humanPremium = b.premium === undefined ? DEFAULT_PREMIUM_HUMAN : b.premium;
  if (typeof humanPremium !== "string" && typeof humanPremium !== "number") {
    throw badRequest("`premium` must be a human mUSDC amount string (e.g. \"10\").");
  }
  try {
    premiumRaw = parseUnits(String(humanPremium), MUSDC_DECIMALS);
  } catch {
    throw badRequest("`premium` is not a valid decimal amount.");
  }
  if (premiumRaw <= 0n) throw badRequest("`premium` must be greater than 0.");

  let tile: TileIndex = DEFAULT_TILE;
  if (b.tile !== undefined) {
    if (!isTileIndex(b.tile)) throw badRequest(`\`tile\` must be 0, 1 or 2 (got ${JSON.stringify(b.tile)}).`);
    tile = b.tile;
  }

  return {
    seriesId: seriesId as Hex,
    direction: dir === "up" ? DIRECTION_UP : DIRECTION_DOWN,
    buyer: getAddress(buyer),
    premiumRaw,
    tile,
  };
}

// ---------------------------------------------------------------------------
// On-chain reads (transport-agnostic — take the caller's public client + addrs)
// ---------------------------------------------------------------------------
function vaultRead<T>(
  publicClient: PublicClient,
  vault: Hex,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return publicClient.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: functionName as never,
    args: args as never,
  }) as Promise<T>;
}

function factoryRead<T>(
  publicClient: PublicClient,
  factory: Hex,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: functionName as never,
    args: args as never,
  }) as Promise<T>;
}

// ---------------------------------------------------------------------------
// deriveAndSignQuote — the one implementation both transports call.
// ---------------------------------------------------------------------------
export interface DeriveAndSignParams {
  /// viem public client bound to Monad testnet, for on-chain reads.
  publicClient: PublicClient;
  /// The pool's quoteAuthority signer (its address is the expected signer).
  account: PrivateKeyAccount;
  /// TendSeriesFactory address.
  factory: Hex;
  /// TendPoolVault address (also the EIP-712 verifyingContract).
  vault: Hex;
  /// Raw, untrusted request body (already JSON-parsed).
  body: unknown;
}

export interface DeriveAndSignResult {
  status: number;
  json: SignedQuotePayload;
}

/// The exact JSON shape returned by both `/quote` (standalone) and
/// `/api/quote` (serverless). All bigints are pre-stringified so the payload
/// serializes with a plain JSON.stringify.
export interface SignedQuotePayload {
  quote: {
    nonce: string;
    direction: string;
    strike: string;
    width: string;
    premium: string;
    maxPayout: string;
    quoteExpiry: string;
    seriesId: Hex;
    buyer: Hex;
  };
  signature: Hex;
  verifyingContract: Hex;
  chainId: number;
  /** Exact selected binary winning payout multiple: 1.5, 2, or 3. */
  multiple: number;
  /** Selected fixed binary payout tier (0=1.5x, 1=2x, 2=3x). */
  tile: number;
  /** Signed fraction of spot the strike sits at: +0.004 is 0.4% above spot. */
  strikeOffsetFraction: number;
  /** True when parity rounding or pool capacity reduced the charged premium. */
  clamped: boolean;
  feeBps: number;
  /** Annualized realized volatility used to price this quote (e.g. 0.323 for 32.3%) — see quote-service/pricing.ts realizedVolatility. */
  impliedVolatility: number;
  /** Risk-neutral binary fair value (maxPayout × win probability), in raw settlement units. */
  fairValue: string;
  /** Actual maker edge in bps after conservative strike rounding. */
  makerEdgeBps: number;
  /** P(finishing in the money) at expiry — N(d2) for Up, N(-d2) for Down. */
  probabilityItm: number;
  /** For strict binary payouts, P(profit) equals P(finishing in the money). */
  probabilityProfit: number;
  /** Time to the series' expiry, in hours, at the moment this quote was priced. */
  timeToExpiryHours: number;
  humanTerms: {
    strike: string;
    width: string;
    premium: string;
    fairValue: string;
    maxPayout: string;
    quoteExpiry: string;
    expiry: string;
  };
}

/** Formats a raw (possibly fractional) token amount as a fixed-6-decimal human string, e.g. "25.000000". Used for `fairValue`, which is a theoretical float rather than a signed bigint, so `formatUnits` (bigint-only) doesn't apply. */
function formatRawFloatAmount(raw: number, decimals: number): string {
  return (raw / 10 ** decimals).toFixed(6);
}

/// Validates + derives + signs + self-verifies a PoolQuote. Pure with respect
/// to transport: no HTTP, no rate limiting, no logging. Throws a typed
/// `HttpError` ({ status, message }) on any rejection so the caller can map it
/// to the right response code. Returns `{ status: 200, json }` on success.
export async function deriveAndSignQuote(params: DeriveAndSignParams): Promise<DeriveAndSignResult> {
  const { publicClient, account, factory, vault, body } = params;
  const req = parseQuoteRequest(body);

  // Tradability + authorization gates.
  const [exists, tradable] = await Promise.all([
    factoryRead<boolean>(publicClient, factory, "seriesExists", [req.seriesId]),
    factoryRead<boolean>(publicClient, factory, "isTradable", [req.seriesId]),
  ]);
  if (!exists) throw conflict(`Series ${req.seriesId} does not exist (factory.seriesExists == false).`);
  if (!tradable) throw conflict(`Series ${req.seriesId} is not tradable (factory.isTradable == false).`);

  const [authEnabled, lastTradeAt] = await vaultRead<[boolean, bigint]>(
    publicClient,
    vault,
    "seriesAuth",
    [req.seriesId],
  );
  if (!authEnabled) throw conflict(`Series ${req.seriesId} is not authorized on the pool (vault.seriesAuth disabled).`);

  // Series terms — pythFeedId identifies the supported exchange product, expiry bounds the quote.
  const series = await factoryRead<Series>(publicClient, factory, "getSeries", [req.seriesId]);

  // Pool caps.
  const [totalAssets, lockedCollateral, maxPositionBps, maxUtilizationBps, feeBps] = await Promise.all([
    vaultRead<bigint>(publicClient, vault, "totalAssets"),
    vaultRead<bigint>(publicClient, vault, "lockedCollateral"),
    vaultRead<number>(publicClient, vault, "maxPositionBps"),
    vaultRead<number>(publicClient, vault, "maxUtilizationBps"),
    vaultRead<number>(publicClient, vault, "feeBps"),
  ]);

  // Spot price from Coinbase -> normalized to the contract's 1e8 PRICE_SCALE.
  // Realized volatility comes from the SAME underlying (its Pyth feed id),
  // fetched in parallel — the two are independent reads.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const [spot, volAnnual] = await Promise.all([
    fetchDemoSpotPrice(series.pythFeedId),
    realizedVolatility(series.pythFeedId).catch((err: unknown) => {
      // Never fall back to a made-up constant — a wrong price is worse than
      // no price, so any failure of the vol estimator (no history, bad
      // data, an out-of-bounds estimate) fails the WHOLE quote with a 502.
      const message = err instanceof VolatilityUnavailableError ? err.message : String(err);
      throw httpError(502, `Could not price this series: ${message}`);
    }),
  ]);
  const normalizedSpot = normalizePythPrice(spot.price, spot.expo);
  if (normalizedSpot <= 0n) throw httpError(502, "Coinbase returned a non-positive spot price.");

  // Existing vaults calculate a linear ramp, but a width of one raw PRICE_SCALE
  // tick makes any strict favourable settlement reach maxPayout. Ties lose.
  const width = 1n;

  // Pool limits the payout must fit inside: the per-position cap and the
  // remaining utilization headroom.
  const positionLimit = (totalAssets * BigInt(maxPositionBps)) / BPS_DENOMINATOR;
  const utilizationLimit = (totalAssets * BigInt(maxUtilizationBps)) / BPS_DENOMINATOR;
  const headroom = utilizationLimit > lockedCollateral ? utilizationLimit - lockedCollateral : 0n;

  if (series.expiry <= now) throw conflict(`Series ${req.seriesId} has already expired.`);
  const timeYears = Number(series.expiry - now) / SECONDS_PER_YEAR;
  const timeToExpiryHours = Number(series.expiry - now) / 3600;

  // --- The binary pricing engine (pricing.ts + strikeLadder.ts) -----------
  const spotHuman = Number(normalizedSpot) / PRICE_SCALE;
  let ladder;
  try {
    ladder = strikeLadder({
      direction: req.direction === DIRECTION_UP ? "up" : "down",
      spot: spotHuman,
      volAnnual,
      timeYears,
      makerEdgeBps: MAKER_EDGE_BPS,
      priceScale: PRICE_SCALE,
    });
  } catch (err) {
    throw httpError(502, `Could not derive a conservative binary strike: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tile = ladder[req.tile];
  if (tile === undefined) throw httpError(500, `Strike ladder produced no tile ${req.tile}.`);

  const strike = tile.strikeRaw;
  if (strike <= 0n) throw httpError(500, "Computed strike is non-positive.");

  const payoutCapacity = positionLimit < headroom ? positionLimit : headroom;
  if (payoutCapacity <= 0n) {
    throw conflict(
      `Pool has insufficient liquidity/headroom (positionLimit=${positionLimit}, headroom=${headroom}, ` +
        `totalAssets=${totalAssets}, lockedCollateral=${lockedCollateral}).`,
    );
  }
  let terms;
  try {
    terms = binaryTerms(req.premiumRaw, payoutCapacity, req.tile);
  } catch (err) {
    throw conflict(`Pool cannot support this exact binary tier: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { premium, maxPayout, clamped } = terms;
  const fairValueRaw = Number(maxPayout) * tile.probabilityItm;
  const multiple = tile.multiple;

  const nonce = BigInt(`0x${randomBytes(16).toString("hex")}`);
  const quoteExpiry = now + QUOTE_TTL_SECONDS;

  // Same bounds e2e enforces: quote must expire no later than the pool's
  // lastTradeAt (when set) and strictly before the series expiry.
  if (lastTradeAt > 0n && quoteExpiry > lastTradeAt) {
    throw conflict(
      `Series too close to its trading cutoff: quoteExpiry=${quoteExpiry} > lastTradeAt=${lastTradeAt}. ` +
        `The ${QUOTE_TTL_SECONDS}s quote window no longer fits before trading closes.`,
    );
  }
  if (quoteExpiry >= series.expiry) {
    throw conflict(
      `Series too close to expiry: quoteExpiry=${quoteExpiry} >= series.expiry=${series.expiry}.`,
    );
  }

  const quote: PoolQuote = {
    nonce,
    direction: req.direction,
    strike,
    width,
    premium,
    maxPayout,
    quoteExpiry,
    seriesId: req.seriesId,
    buyer: req.buyer,
  };

  const signature = await account.signTypedData(
    poolQuoteSignTypedData(ACTIVE_CHAIN.chainId, vault, quote),
  );

  // Self-check: never return a signature that doesn't recover to the authority.
  const verify = await verifyPoolQuoteSignatureOffchain({
    chainId: ACTIVE_CHAIN.chainId,
    verifyingContract: vault,
    quote,
    signature,
    expectedSigner: account.address,
  });
  if (!verify.ok) {
    throw httpError(500, "Signature self-check failed — refusing to return an invalid quote.");
  }

  const json: SignedQuotePayload = {
    quote: {
      nonce: quote.nonce.toString(),
      direction: quote.direction.toString(),
      strike: quote.strike.toString(),
      width: quote.width.toString(),
      premium: quote.premium.toString(),
      maxPayout: quote.maxPayout.toString(),
      quoteExpiry: quote.quoteExpiry.toString(),
      seriesId: quote.seriesId,
      buyer: quote.buyer,
    },
    signature,
    verifyingContract: vault,
    chainId: ACTIVE_CHAIN.chainId,
    multiple,
    tile: req.tile,
    strikeOffsetFraction: tile.strikeOffsetFraction,
    clamped,
    feeBps,
    impliedVolatility: volAnnual,
    fairValue: fairValueRaw.toFixed(6),
    makerEdgeBps: tile.makerEdgeBps,
    probabilityItm: tile.probabilityItm,
    probabilityProfit: tile.probabilityProfit,
    timeToExpiryHours,
    humanTerms: {
      strike: formatUnits(strike, 8),
      width: formatPriceForDisplay(Number(width) / PRICE_SCALE),
      premium: `${formatUnits(premium, MUSDC_DECIMALS)} mUSDC`,
      fairValue: `${formatRawFloatAmount(fairValueRaw, MUSDC_DECIMALS)} mUSDC`,
      maxPayout: `${formatUnits(maxPayout, MUSDC_DECIMALS)} mUSDC`,
      quoteExpiry: new Date(Number(quoteExpiry) * 1000).toISOString(),
      expiry: new Date(Number(series.expiry) * 1000).toISOString(),
    },
  };

  return { status: 200, json };
}
