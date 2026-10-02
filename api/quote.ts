// Vercel serverless function: POST /api/quote.
//
// Same-origin sibling of the standalone quote service (quote-service/server.ts).
// Both call the ONE shared pipeline `deriveAndSignQuote` (quote-service/derive.ts),
// so a quote signed here is byte-identical to one the standalone service — or
// the e2e proof — would sign. This file only wires the pipeline to Vercel's
// (req, res) transport: method handling, env/key loading, the deployment
// manifest (bundled at build), a one-time quoteAuthority assertion, and the
// JSON response.
//
// The private key (QUOTE_AUTHORITY_KEY) is supplied at deploy time as a Vercel
// environment variable — never committed, never logged.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPublicClient, http, type PublicClient } from "viem";
import { ACTIVE_CHAIN, ACTIVE_MANIFEST } from "../config/activeChain.js";
import { activeChain } from "../scripts/lib/e2e/chain.js";
import { deriveAndSignQuote, isHttpError } from "../quote-service/derive.js";
import { getQuoteContext } from "../quote-service/serverContext.js";
import { clientIpFromHeaders, createRateLimiter } from "../quote-service/rateLimit.js";
// Bundled at build time (NOT read from the filesystem at runtime). resolveJsonModule
// makes this a typed import; @vercel/node inlines the JSON into the function bundle.
// The `with { type: "json" }` attribute is REQUIRED, not optional: this repo is
// an ESM package ("type": "module"), and Node refuses a JSON import without it
// (ERR_IMPORT_ATTRIBUTE_MISSING), which crashes the function at module load —
// before the handler's try/catch can turn it into a clean error response.

// Vercel augments IncomingMessage with a parsed `body` when the request has a
// JSON content-type; we fall back to reading the raw stream when it doesn't.
type ApiRequest = IncomingMessage & { body?: unknown };

// A single public client for on-chain reads, reused across warm invocations.
const publicClient: PublicClient = createPublicClient({
  chain: activeChain,
  transport: http(ACTIVE_CHAIN.rpcUrl),
});

function setCommonHeaders(res: ServerResponse): void {
  // Same-origin in production, so CORS is not required — but permissive
  // headers are harmless and make local cross-origin testing easier.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/// Reads the JSON body. Prefers Vercel's pre-parsed `req.body`; otherwise
/// drains the raw stream (capped at 64 KiB, matching the standalone service).
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

// --- Rate limiting -----------------------------------------------------
// Keyed on client IP rather than the request body's `buyer` field: `buyer`
// is unauthenticated client input the caller can set to any address on every
// request, so keying on it limits nothing (see quote-service/rateLimit.ts's
// header comment for the full honest-limitations discussion, including why
// this is only best-effort on Vercel's per-instance memory model).
//
// Limits sized around real usage, not just abuse: the trade ticket re-quotes
// on every direction/strike/premium change (debounced 600ms —
// web/src/components/TradeTicket.tsx) AND auto-refreshes whenever the
// current quote passes its 30s TTL (quote-service/derive.ts
// QUOTE_TTL_SECONDS), so one attentive trader adjusting the ticket a few
// times a minute can legitimately produce a double-digit number of requests
// per 60s window without being anywhere near abusive.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_IP = 30; // per IP per window — generous headroom over normal single-trader usage
const RATE_LIMIT_MAX_TOTAL = 300; // coarse cap across all IPs hitting this warm instance — each quote costs 9 eth_calls plus 2 outbound HTTPS fetches
const rateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxPerKey: RATE_LIMIT_MAX_PER_IP,
  maxTotal: RATE_LIMIT_MAX_TOTAL,
});

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
      error: `Rate limit exceeded (max ${RATE_LIMIT_MAX_PER_IP} quote requests per IP per ${RATE_LIMIT_WINDOW_MS / 1000}s).`,
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { account, factory, vault } = await getQuoteContext(publicClient, ACTIVE_MANIFEST.contracts);
    const { status, json } = await deriveAndSignQuote({ publicClient, account, factory, vault, body });
    sendJson(res, status, json);
  } catch (err) {
    if (isHttpError(err)) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    // Unexpected: return the message only, never a stack (which could leak
    // paths/secrets), and never the key.
    const message = err instanceof Error ? err.message : "Internal error.";
    console.error(`[api/quote] unhandled error: ${message}`);
    sendJson(res, 500, { error: message });
  }
}
