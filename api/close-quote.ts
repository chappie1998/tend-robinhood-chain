// Vercel serverless function: POST /api/close-quote.
//
// The exit half of /api/quote: prices one OPEN position and signs the desk's
// bid for it, so its holder can sell back before expiry
// (TendPoolVault.closePosition). Transport only — the pricing, validation and
// signing all live in the one shared pipeline
// (quote-service/closeQuote.ts), and the signer/address context is the same
// memoized one /api/quote uses, so a bid signed here is honoured by the same
// vault that honours a fill.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPublicClient, http, type PublicClient } from "viem";
import { ACTIVE_CHAIN, ACTIVE_MANIFEST } from "../config/activeChain.js";
import { activeChain } from "../scripts/lib/e2e/chain.js";
import { deriveAndSignCloseQuote } from "../quote-service/closeQuote.js";
import { isHttpError } from "../quote-service/derive.js";
import { clientIpFromHeaders, createRateLimiter } from "../quote-service/rateLimit.js";
import { getQuoteContext } from "../quote-service/serverContext.js";
// Bundled at build time; the `with { type: "json" }` attribute is REQUIRED in
// this ESM package (see api/quote.ts for the full explanation).

type ApiRequest = IncomingMessage & { body?: unknown };

const publicClient: PublicClient = createPublicClient({
  chain: activeChain,
  transport: http(ACTIVE_CHAIN.rpcUrl),
});

// Closing is a deliberate, one-per-position action rather than a live-updating
// ticket, so this is tighter than /api/quote's allowance. Each request still
// costs on-chain reads plus a spot and volatility lookup.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_IP = 15;
const RATE_LIMIT_MAX_TOTAL = 150;
const rateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxPerKey: RATE_LIMIT_MAX_PER_IP,
  maxTotal: RATE_LIMIT_MAX_TOTAL,
});

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

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
  setCommonHeaders(res);

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

  const clientIp = clientIpFromHeaders(req.headers);
  if (!rateLimiter.check(clientIp)) {
    sendJson(res, 429, {
      error: `Rate limit exceeded (max ${RATE_LIMIT_MAX_PER_IP} close quotes per IP per ${RATE_LIMIT_WINDOW_MS / 1000}s).`,
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { account, factory, vault } = await getQuoteContext(publicClient, ACTIVE_MANIFEST.contracts);
    const { status, json } = await deriveAndSignCloseQuote({ publicClient, account, factory, vault, body });
    sendJson(res, status, json);
  } catch (err) {
    if (isHttpError(err)) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : "Internal error.";
    console.error(`[api/close-quote] unhandled error: ${message}`);
    sendJson(res, 500, { error: message });
  }
}
