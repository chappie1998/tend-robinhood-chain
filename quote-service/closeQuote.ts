// The close-quote pipeline: price one OPEN position at what it is worth right
// now, take the desk's spread, and sign that bid so its holder can exit before
// expiry (TendPoolVault.closePosition).
//
// WHY THIS EXISTS
//
// Until now a position could only be held to expiry. That is the single
// biggest gap against split.markets, whose traders can sell back to the desk
// at any time. Nothing about the payoff changes: the pool already escrows
// `maxPayout` for every open position, so a bid bounded by that escrow is paid
// out of collateral the position itself locked. A mispriced bid is desk P&L,
// never a solvency event — and the contract enforces that bound independently
// (see `BidExceedsEscrow`), so this service is never trusted for solvency.
//
// The bid is the same present value the Positions table shows as "Worth now",
// less a fixed spread. New one-tick positions use binary win probability;
// historical wider positions retain Black-Scholes spread value.
import { randomBytes } from "node:crypto";
import { type Hex, getAddress, isAddress, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { ACTIVE_CHAIN } from "../config/activeChain.js";
import { QUOTE_TTL_SECONDS } from "../config/quotes.js";
import { fetchDemoSpotPrice } from "../market-data/coinbase.js";
import { normalizePythPrice } from "../scripts/lib/e2e/hermes.js";
import {
  closeQuoteSignTypedData,
  verifyCloseQuoteSignatureOffchain,
  type CloseQuote,
} from "../scripts/lib/e2e/quote.js";
import { FACTORY_ABI, VAULT_ABI } from "./abi.js";
import { httpError, type HttpError } from "./derive.js";
import {
  fairValue,
  probabilityItm,
  realizedVolatility,
  spreadUnitValue,
  VolatilityUnavailableError,
  type SpreadDirection,
} from "./pricing.js";

/// The desk's edge for taking risk back early, applied under the mark. It is
/// the trader's round-trip cost and the pool's compensation for warehousing
/// the position's remaining time value. Named (not folded into the mark) so
/// the response can report mark and bid separately and the markup stays
/// inspectable.
export const CLOSE_SPREAD_BPS = 500; // 5% under model value

const PRICE_SCALE = 1e8; // strike/width are Pyth-scaled (expo -8)
const YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * The desk's bid from the model value: take the spread, round DOWN so the pool
 * never pays out a unit it did not price, and clamp to the escrow. The clamp
 * is defensive — a capped spread's value can never exceed its own cap — but
 * the contract rejects a bid above the escrow (`BidExceedsEscrow`), and that
 * must never be the reason a close fails on-chain.
 */
export function bidFromMark(markRaw: bigint, maxPayout: bigint, spreadBps: number = CLOSE_SPREAD_BPS): bigint {
  if (markRaw <= 0n) return 0n;
  const bid = (markRaw * BigInt(10_000 - spreadBps)) / 10_000n;
  return bid > maxPayout ? maxPayout : bid;
}

/**
 * Values a stored position in settlement-token human units. New width=1
 * positions are expiry-only binary tickets; historical wider positions retain
 * their original spread valuation.
 */
export function positionMarkHuman(params: {
  direction: SpreadDirection;
  spot: number;
  strike: number;
  widthRaw: bigint;
  maxPayoutHuman: number;
  volAnnual: number;
  timeYears: number;
}): number {
  if (params.widthRaw === 1n) {
    return params.maxPayoutHuman * probabilityItm(
      params.direction,
      params.spot,
      params.strike,
      params.volAnnual,
      params.timeYears,
    );
  }
  const widthHuman = Number(params.widthRaw) / PRICE_SCALE;
  const unit = spreadUnitValue({
    direction: params.direction,
    spot: params.spot,
    strike: params.strike,
    width: widthHuman,
    volAnnual: params.volAnnual,
    timeYears: params.timeYears,
  });
  return fairValue(params.maxPayoutHuman, widthHuman, unit);
}

const badRequest = (m: string) => httpError(400, m);
const conflict = (m: string) => httpError(409, m);

const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

export interface DeriveCloseQuoteParams {
  publicClient: PublicClient;
  account: PrivateKeyAccount;
  factory: Hex;
  vault: Hex;
  /// Raw, untrusted request body (already JSON-parsed).
  body: unknown;
}

export interface SignedCloseQuotePayload {
  quote: {
    nonce: string;
    positionId: string;
    bid: string;
    quoteExpiry: string;
    seller: Hex;
  };
  signature: Hex;
  verifyingContract: Hex;
  chainId: number;
  /// Model value of the position right now, in raw settlement-token units.
  mark: string;
  /// What the desk pays: mark less CLOSE_SPREAD_BPS, rounded down.
  bid: string;
  spreadBps: number;
  /// Annualized realized volatility the mark was priced with.
  impliedVolatility: number;
  timeToExpiryHours: number;
  humanTerms: {
    mark: string;
    bid: string;
    premium: string;
    maxPayout: string;
    quoteExpiry: string;
    expiry: string;
  };
}

interface PositionTuple {
  buyer: Hex;
  seriesId: Hex;
  direction: number;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  feeBps: number;
  settled: boolean;
  closed: boolean;
}

const decimalsCache = new Map<string, number>();

async function settlementDecimals(publicClient: PublicClient, token: Hex): Promise<number> {
  const key = token.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const decimals = Number(
    (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" })) as number,
  );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw httpError(502, `Settlement token ${token} returned an implausible decimals value.`);
  }
  decimalsCache.set(key, decimals);
  return decimals;
}

function parsePositionId(raw: unknown): bigint {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return BigInt(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw.trim()) && raw.trim() !== "0") return BigInt(raw.trim());
  throw badRequest("`positionId` must be a positive integer.");
}

function parseSeller(raw: unknown): Hex {
  if (typeof raw !== "string" || !isAddress(raw)) throw badRequest("`seller` must be a 0x-prefixed address.");
  return getAddress(raw);
}

/// Validates + prices + signs + self-verifies a CloseQuote. Pure with respect
/// to transport: no HTTP, no rate limiting, no logging. Throws a typed
/// `HttpError` on any rejection.
export async function deriveAndSignCloseQuote(
  params: DeriveCloseQuoteParams,
): Promise<{ status: number; json: SignedCloseQuotePayload }> {
  const { publicClient, account, factory, vault, body } = params;
  const req = (body ?? {}) as Record<string, unknown>;
  const positionId = parsePositionId(req.positionId);
  const seller = parseSeller(req.seller);

  // A vault predating the early-exit path returns a shorter Position tuple and
  // has no closePosition at all, so the decode fails here. That is a property
  // of the deployment, not of the request: say so, instead of returning viem's
  // decode dump as if the caller had done something wrong.
  let raw: readonly [Hex, Hex, number, bigint, bigint, bigint, bigint, number, boolean, boolean, bigint];
  try {
    raw = (await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "positions",
      args: [positionId],
    })) as readonly [Hex, Hex, number, bigint, bigint, bigint, bigint, number, boolean, boolean, bigint];
  } catch (err) {
    throw httpError(
      501,
      `The vault at ${vault} does not support selling a position back before expiry. ` +
        `(Reading positions(${positionId}) did not return the expected shape: ` +
        `${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
    );
  }

  const position: PositionTuple = {
    buyer: raw[0],
    seriesId: raw[1],
    direction: Number(raw[2]),
    strike: raw[3],
    width: raw[4],
    premium: raw[5],
    maxPayout: raw[6],
    feeBps: Number(raw[7]),
    settled: raw[8],
    closed: raw[9],
  };

  if (position.buyer === "0x0000000000000000000000000000000000000000") {
    throw httpError(404, `Position ${positionId} does not exist.`);
  }
  if (position.settled) {
    throw conflict(
      `Position ${positionId} is already ${position.closed ? "closed" : "settled or refunded"} — there is nothing left to sell.`,
    );
  }
  if (getAddress(position.buyer) !== seller) {
    throw httpError(403, `Position ${positionId} belongs to another wallet.`);
  }

  const series = (await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "getSeries",
    args: [position.seriesId],
  })) as { pythFeedId: Hex; settlementToken: Hex; expiry: bigint };

  const now = BigInt(Math.floor(Date.now() / 1000));
  const quoteExpiry = now + BigInt(QUOTE_TTL_SECONDS);
  if (now >= series.expiry) {
    throw conflict("This series has expired — settle (or, after the grace window, refund) instead of selling back.");
  }
  // The signed window must close before the series does, exactly as the fill
  // path requires: the contract refuses a close at or after expiry.
  if (quoteExpiry >= series.expiry) {
    throw conflict(
      `Too close to expiry to sign a ${QUOTE_TTL_SECONDS}s close quote — hold this position to settlement.`,
    );
  }

  const [spot, volAnnual, decimals] = await Promise.all([
    fetchDemoSpotPrice(series.pythFeedId),
    realizedVolatility(series.pythFeedId).catch((err) => {
      if (err instanceof VolatilityUnavailableError) {
        throw httpError(503, `Cannot price this position right now: ${err.message}`);
      }
      throw err;
    }),
    settlementDecimals(publicClient, series.settlementToken),
  ]);

  const normalizedSpot = normalizePythPrice(spot.price, spot.expo);
  if (normalizedSpot <= 0n) throw httpError(502, "Coinbase returned a non-positive spot price.");

  const tokenScale = 10 ** decimals;
  const spotHuman = Number(normalizedSpot) / PRICE_SCALE;
  const strikeHuman = Number(position.strike) / PRICE_SCALE;
  const maxPayoutHuman = Number(position.maxPayout) / tokenScale;
  const timeYears = Math.max(0, Number(series.expiry - now) / YEAR_SECONDS);
  const markHuman = positionMarkHuman({
    direction: (position.direction === 0 ? "up" : "down") as SpreadDirection,
    spot: spotHuman,
    strike: strikeHuman,
    widthRaw: position.width,
    maxPayoutHuman,
    volAnnual,
    timeYears,
  });
  if (!Number.isFinite(markHuman) || markHuman < 0) {
    throw httpError(500, "Priced a non-finite mark for this position — refusing to sign a bid.");
  }

  // Round the bid DOWN: the pool never pays out a unit it did not price.
  const markRaw = BigInt(Math.floor(markHuman * tokenScale));
  const bid = bidFromMark(markRaw, position.maxPayout);
  if (bid <= 0n) {
    throw conflict(
      "This position is worth less than one unit at the current price and time to expiry — there is nothing to sell back.",
    );
  }

  const quote: CloseQuote = {
    nonce: BigInt(`0x${randomBytes(16).toString("hex")}`),
    positionId,
    bid,
    quoteExpiry,
    seller,
  };

  const signature = await account.signTypedData(closeQuoteSignTypedData(ACTIVE_CHAIN.chainId, vault, quote));

  // Never return a signature that doesn't recover to the authority.
  const verify = await verifyCloseQuoteSignatureOffchain({
    chainId: ACTIVE_CHAIN.chainId,
    verifyingContract: vault,
    quote,
    signature,
    expectedSigner: account.address,
  });
  if (!verify.ok) {
    throw httpError(500, "Signature self-check failed — refusing to return an invalid close quote.");
  }

  const human = (value: bigint) => (Number(value) / tokenScale).toFixed(Math.min(decimals, 6));

  return {
    status: 200,
    json: {
      quote: {
        nonce: quote.nonce.toString(),
        positionId: quote.positionId.toString(),
        bid: quote.bid.toString(),
        quoteExpiry: quote.quoteExpiry.toString(),
        seller: quote.seller,
      },
      signature,
      verifyingContract: vault,
      chainId: ACTIVE_CHAIN.chainId,
      mark: markRaw.toString(),
      bid: bid.toString(),
      spreadBps: CLOSE_SPREAD_BPS,
      impliedVolatility: volAnnual,
      timeToExpiryHours: timeYears * YEAR_SECONDS / 3600,
      humanTerms: {
        mark: human(markRaw),
        bid: human(bid),
        premium: human(position.premium),
        maxPayout: human(position.maxPayout),
        quoteExpiry: new Date(Number(quoteExpiry) * 1000).toISOString(),
        expiry: new Date(Number(series.expiry) * 1000).toISOString(),
      },
    },
  };
}

export type { HttpError };
