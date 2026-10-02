// Mark-to-market valuation for OPEN positions.
//
// WHY THIS EXISTS
//
// A payoff at current spot is a hypothetical settlement outcome, not the
// value of a still-open position with time remaining. It can also be wrong
// after expiry, when today's spot no longer belongs to the expiry window.
//
// The honest number is present value. New one-tick positions use their binary
// win probability times max payout; historical wider positions use the same
// Black-Scholes spread engine they were quoted with.
//
// Server-side because valuation needs realized volatility, which needs exchange
// history. The server centralizes validation and caching of public data.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  fairValue,
  probabilityItm,
  realizedVolatility,
  spreadUnitValue,
  type SpreadDirection,
} from "../quote-service/pricing.js";

/** Mirrors the on-chain price scale (Pyth expo -8) that strike/width are quoted in. */
const PRICE_SCALE = 1e8;
/** mUSDC decimals — premium/maxPayout are integers at this scale. */
const TOKEN_SCALE = 1e6;
const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Refuse absurd batches rather than letting one request fan out into unbounded vol lookups. */
const MAX_POSITIONS = 25;

type MarkRequest = {
  feedId: string;
  direction: "up" | "down";
  /** On-chain integer strings, at the scales documented above. */
  strike: string;
  width: string;
  premium: string;
  maxPayout: string;
  /** Unix seconds. */
  expiry: number;
  spot: number;
};

/**
 * Present value for a stored position. Width=1 is the new strict binary
 * convention; wider historical positions remain Black-Scholes call/put spreads.
 */
export function calculateMarkValue(params: {
  direction: "up" | "down";
  spot: number;
  strike: number;
  widthRaw: bigint;
  maxPayout: number;
  volAnnual: number;
  timeYears: number;
}): number {
  // Once expiry passes, today's spot is no longer a possible settlement
  // observation. The caller must wait for the expiry reference/on-chain result.
  if (!(params.timeYears > 0)) return Number.NaN;
  if (params.widthRaw === 1n) {
    return params.maxPayout * probabilityItm(
      params.direction as SpreadDirection,
      params.spot,
      params.strike,
      params.volAnnual,
      params.timeYears,
    );
  }
  const width = Number(params.widthRaw) / PRICE_SCALE;
  const unit = spreadUnitValue({
    direction: params.direction as SpreadDirection,
    spot: params.spot,
    strike: params.strike,
    width,
    volAnnual: params.volAnnual,
    timeYears: params.timeYears,
  });
  return fairValue(params.maxPayout, width, unit);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const anyReq = req as IncomingMessage & { body?: unknown };
  if (anyReq.body !== undefined && anyReq.body !== null) {
    if (typeof anyReq.body === "string") {
      try {
        return JSON.parse(anyReq.body);
      } catch {
        return null;
      }
    }
    return anyReq.body;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { error: "Only POST is supported." });
    return;
  }

  const body = (await readBody(req)) as { positions?: MarkRequest[] } | null;
  const positions = body?.positions;
  if (!Array.isArray(positions) || positions.length === 0) {
    send(res, 400, { error: "`positions` must be a non-empty array." });
    return;
  }
  if (positions.length > MAX_POSITIONS) {
    send(res, 400, { error: `At most ${MAX_POSITIONS} positions per request.` });
    return;
  }

  const now = Date.now() / 1000;
  // One vol lookup per DISTINCT feed, not per position: realizedVolatility is
  // cached but still a network call on a miss, and a table of positions on one
  // market would otherwise repeat it needlessly.
  const volByFeed = new Map<string, number | null>();
  for (const p of positions) {
    if (!Number.isFinite(p.expiry) || p.expiry <= now) continue;
    const key = p.feedId?.toLowerCase();
    if (!key || volByFeed.has(key)) continue;
    try {
      volByFeed.set(key, await realizedVolatility(key));
    } catch {
      // A feed with no vol estimate yields no mark for its positions — never
      // a guessed one. The caller falls back to the payoff-now figure.
      volByFeed.set(key, null);
    }
  }

  const marks = positions.map((p) => {
    if (!Number.isFinite(p.expiry) || p.expiry <= now) return { value: null, pnl: null };
    const vol = volByFeed.get(p.feedId?.toLowerCase() ?? "") ?? null;
    const timeYears = Math.max(0, (p.expiry - now) / YEAR_SECONDS);
    if (vol === null || !Number.isFinite(p.spot) || p.spot <= 0) return { value: null, pnl: null };

    const strike = Number(p.strike) / PRICE_SCALE;
    let widthRaw: bigint;
    try {
      widthRaw = BigInt(p.width);
    } catch {
      return { value: null, pnl: null };
    }
    const maxPayout = Number(p.maxPayout) / TOKEN_SCALE;
    const premium = Number(p.premium) / TOKEN_SCALE;
    if (widthRaw <= 0n || !(maxPayout > 0)) return { value: null, pnl: null };
    const value = calculateMarkValue({ direction: p.direction, spot: p.spot, strike, widthRaw, maxPayout, volAnnual: vol, timeYears });
    if (!Number.isFinite(value) || value < 0) return { value: null, pnl: null };
    return {
      // Present value of the position right now, and the honest unrealised
      // P&L against what was paid for it.
      value,
      pnl: value - premium,
      volAnnual: vol,
      hoursToExpiry: timeYears * YEAR_SECONDS / 3600,
    };
  });

  send(res, 200, { marks });
}
