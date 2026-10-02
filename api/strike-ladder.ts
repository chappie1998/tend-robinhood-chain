// Vercel serverless function: POST /api/strike-ladder.
//
// Prices the three strike tiles for one series so the ticket can show what
// each one actually pays before the trader picks one. No signature, no nonce,
// no commitment — see quote-service/ladderPreview.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { ACTIVE_CHAIN, ACTIVE_MANIFEST } from "../config/activeChain.js";
import { activeChain } from "../scripts/lib/e2e/chain.js";
import { isHttpError } from "../quote-service/derive.js";
import { deriveStrikeLadder } from "../quote-service/ladderPreview.js";
import { clientIpFromHeaders, createRateLimiter } from "../quote-service/rateLimit.js";

type ApiRequest = IncomingMessage & { body?: unknown };

const publicClient: PublicClient = createPublicClient({
  chain: activeChain,
  transport: http(ACTIVE_CHAIN.rpcUrl),
});

// The ticket re-prices the ladder on every direction change and on a timer, so
// this is the chattiest of the three endpoints — but it is also the cheapest
// (one series read, one spot, one cached vol).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_IP = 60;
const RATE_LIMIT_MAX_TOTAL = 600;
const rateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxPerKey: RATE_LIMIT_MAX_PER_IP,
  maxTotal: RATE_LIMIT_MAX_TOTAL,
});

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: ApiRequest): Promise<unknown> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      const trimmed = req.body.trim();
      if (trimmed.length === 0) return {};
      try {
        return JSON.parse(trimmed);
      } catch {
        throw { status: 400, message: "Body is not valid JSON." };
      }
    }
    return req.body;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 64 * 1024) throw { status: 400, message: "Request body too large." };
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw { status: 400, message: "Body is not valid JSON." };
  }
}

export default async function handler(req: ApiRequest, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  const method = req.method ?? "GET";
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (method !== "POST") {
    sendJson(res, 405, { error: `Method not allowed: ${method}. Use POST.` });
    return;
  }
  if (!rateLimiter.check(clientIpFromHeaders(req.headers))) {
    sendJson(res, 429, {
      error: `Rate limit exceeded (max ${RATE_LIMIT_MAX_PER_IP} ladder requests per IP per ${RATE_LIMIT_WINDOW_MS / 1000}s).`,
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const factory = getAddress(ACTIVE_MANIFEST.contracts.tendSeriesFactory);
    const { status, json } = await deriveStrikeLadder({ publicClient, factory, body });
    sendJson(res, status, json);
  } catch (err) {
    if (isHttpError(err)) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : "Internal error.";
    console.error(`[api/strike-ladder] unhandled error: ${message}`);
    sendJson(res, 500, { error: message });
  }
}
