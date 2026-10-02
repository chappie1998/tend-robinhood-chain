// Standalone quote-signing HTTP service for TendPoolVault.
//
// A browser cannot hold the pool's `quoteAuthority` private key, but
// `fillPoolQuote` requires an EIP-712 signature from exactly that key. This
// service is the ONE centralized component: it derives the same PoolQuote
// terms the e2e proof does (scripts/e2e-monad.ts), signs them with the
// quoteAuthority key, and hands the browser back a `{ quote, signature }` it
// can fill on-chain itself. Series creation, quote *filling*, settlement and
// refund all stay permissionless and on-chain — only quote signing is
// centralized here, and only because the key can't live in the browser.
//
// Pricing (see quote-service/README.md "Trust model" and quote-service/
// pricing.ts): the premium is a real Black-Scholes fair value — r=0,
// European exercise — on a realized-volatility estimate from Pyth
// Benchmarks hourly closes on the series' own feed, plus a fixed maker edge
// layered on top of fair value to compensate the pool for selling the risk.
// It is not a flat function of any requested multiple: the strike
// is solved (quote-service/pricing.ts solveStrikeForLeverage) to whichever
// offset actually prices that tier fairly at the current vol/time.
//
// Run (never as part of the app build — reviewer runs it manually):
//   npm run quote:service
//   (= node --env-file=.env --import tsx quote-service/server.ts)
//
// It reuses the e2e's own EIP-712 + Hermes helpers verbatim so a quote signed
// here is byte-identical to one the e2e would sign.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { type Hex, type PublicClient, createPublicClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET } from "../config/monad.js";
import { monadTestnetChain } from "../scripts/lib/e2e/chain.js";
import { VAULT_ABI } from "./abi.js";
import {
  type DeriveAndSignResult,
  deriveAndSignQuote,
  httpError,
  isHttpError,
  parseQuoteRequest,
} from "./derive.js";
import { createRateLimiter } from "./rateLimit.js";
import { assertRuntimeMode } from "./deploymentGuard.js";
import { getQuoteContext } from "./serverContext.js";
import { selectChain } from "../config/chain-selection.mjs";

// --- Rate limiting ----------------------------------------------------------
// This standalone service is a single long-lived process, so — unlike
// api/quote.ts's IP-keyed limiter (see quote-service/rateLimit.ts for the
// per-instance-memory caveat that applies to serverless, not here) — this
// limiter is a real, continuously-enforced limit against this process.
// Buyer-keyed rather than IP-keyed is a deliberate, narrower choice here:
// this service is the "reviewer runs it manually" local/dev path (see the
// file header above), not the deployed public surface, so a good-enough
// per-address throttle is appropriate.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_BUYER = 10;
const RATE_LIMIT_MAX_TOTAL = 200; // coarse global cap across all buyers
const rateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxPerKey: RATE_LIMIT_MAX_PER_BUYER,
  maxTotal: RATE_LIMIT_MAX_TOTAL,
});

// --- Env / config -----------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(HERE, "../deployments/monad-testnet.json");

interface Manifest {
  contracts: {
    tendSeriesFactory: string;
    tendPoolVault: string;
    mockUSDC: string;
  };
}

interface Config {
  port: number;
  allowedOrigin: string;
  factory: Hex;
  vault: Hex;
  mockUSDC: Hex;
  quoteAuthority: Hex;
}

// A single shared public client for all on-chain reads.
const publicClient: PublicClient = createPublicClient({
  chain: monadTestnetChain,
  transport: http(MONAD_TESTNET.rpcUrl),
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// JSON.stringify replacer that renders bigints as decimal strings.
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function corsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

function sendJson(
  res: ServerResponse,
  allowedOrigin: string,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload, bigintReplacer);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(allowedOrigin),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 64 * 1024) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Body is not valid JSON.");
  }
}

/// Loads the deployment manifest at startup (fail fast if missing/malformed).
function loadManifest(): Manifest {
  let raw: string;
  try {
    raw = readFileSync(MANIFEST_PATH, "utf8");
  } catch {
    throw new Error(
      `No manifest at ${MANIFEST_PATH}. Deploy first (npm run deploy:monad) before starting the quote service.`,
    );
  }
  const parsed = JSON.parse(raw) as Manifest;
  const c = parsed.contracts;
  if (!c?.tendSeriesFactory || !c?.tendPoolVault || !c?.mockUSDC) {
    throw new Error(`Manifest ${MANIFEST_PATH} is missing contracts.{tendSeriesFactory,tendPoolVault,mockUSDC}.`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// POST /quote
// ---------------------------------------------------------------------------
// Validation + derivation + signing + self-verify all live in the shared,
// transport-agnostic `deriveAndSignQuote` (quote-service/derive.ts) so this
// standalone service and the Vercel serverless function (api/quote.ts) can
// never drift. This wrapper adds only the transport-specific rate limit: it
// validates the body just enough to key the limiter on the buyer (using the
// pipeline's own parser, so an invalid body still returns the same 400 before
// any budget is spent), enforces the limit, then hands off to the shared fn.
async function handleQuote(
  cfg: Config,
  account: ReturnType<typeof privateKeyToAccount>,
  body: unknown,
): Promise<DeriveAndSignResult> {
  const req = parseQuoteRequest(body);

  // Rate-limit per buyer (and a coarse global cap).
  if (!rateLimiter.check(req.buyer.toLowerCase())) {
    throw httpError(429, `Rate limit exceeded (max ${RATE_LIMIT_MAX_PER_BUYER} quotes per address per 60s).`);
  }
  await getQuoteContext(publicClient, { tendSeriesFactory: cfg.factory, tendPoolVault: cfg.vault });

  // Forward the pipeline's own status rather than assuming 200 — api/quote.ts
  // does the same, so the two transports can't drift if a future success path
  // returns something other than 200.
  return deriveAndSignQuote({
    publicClient,
    account,
    factory: cfg.factory,
    vault: cfg.vault,
    body,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function makeHandler(cfg: Config, account: ReturnType<typeof privateKeyToAccount>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { allowedOrigin } = cfg;
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname;

      if (method === "OPTIONS") {
        res.writeHead(204, corsHeaders(allowedOrigin));
        res.end();
        return;
      }

      if (method === "GET" && route === "/health") {
        sendJson(res, allowedOrigin, 200, {
          ok: true,
          chainId: MONAD_TESTNET.chainId,
          factory: cfg.factory,
          vault: cfg.vault,
          quoteAuthority: cfg.quoteAuthority,
        });
        return;
      }

      if (method === "POST" && route === "/quote") {
        const body = await readBody(req);
        const { status, json } = await handleQuote(cfg, account, body);
        sendJson(res, allowedOrigin, status, json);
        return;
      }

      sendJson(res, allowedOrigin, 404, { error: `Not found: ${method} ${route}` });
    } catch (err) {
      if (isHttpError(err)) {
        sendJson(res, allowedOrigin, err.status, { error: err.message });
        return;
      }
      // Unexpected: return the message only, never a stack (which could leak paths/secrets).
      const message = err instanceof Error ? err.message : "Internal error.";
      console.error(`[quote-service] unhandled error: ${message}`);
      sendJson(res, allowedOrigin, 500, { error: message });
    }
  };
}

// ---------------------------------------------------------------------------
// Startup (fail fast before listening)
// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  assertRuntimeMode();
  if (selectChain(process.env.TEND_CHAIN) !== "monad") {
    throw new Error("Standalone quote service is Monad-only; use the chain-aware /api/quote endpoint for Robinhood.");
  }
  const key = process.env.QUOTE_AUTHORITY_KEY;
  if (!key) {
    throw new Error(
      "QUOTE_AUTHORITY_KEY is required (0x-prefixed private key of the pool's quoteAuthority; " +
        "for the demo this is the same key as MONAD_DEPLOYER_KEY). Set it in .env and rerun.",
    );
  }

  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(key as Hex);
  } catch {
    throw new Error("QUOTE_AUTHORITY_KEY is not a valid 0x-prefixed private key.");
  }

  const port = Number(process.env.QUOTE_SERVICE_PORT ?? "8787");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`QUOTE_SERVICE_PORT is invalid: ${process.env.QUOTE_SERVICE_PORT}`);
  }
  const allowedOrigin = process.env.QUOTE_SERVICE_ALLOWED_ORIGIN ?? "http://localhost:5173";

  const manifest = loadManifest();
  const factory = getAddress(manifest.contracts.tendSeriesFactory);
  const vault = getAddress(manifest.contracts.tendPoolVault);
  const mockUSDC = getAddress(manifest.contracts.mockUSDC);

  // Assert the signer really is the pool's quoteAuthority. A quote signed by
  // the wrong key would be rejected by fillPoolQuote, so refusing to start is
  // the correct, honest failure.
  const onchainAuthority = (await publicClient.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "quoteAuthority",
  })) as Hex;
  if (getAddress(onchainAuthority) !== account.address) {
    throw new Error(
      `Signer address does not match the pool's quoteAuthority.\n` +
        `  signer (from QUOTE_AUTHORITY_KEY): ${account.address}\n` +
        `  vault.quoteAuthority():            ${getAddress(onchainAuthority)}\n` +
        `Fix QUOTE_AUTHORITY_KEY so it is the pool's quote authority, then retry.`,
    );
  }

  const cfg: Config = {
    port,
    allowedOrigin,
    factory,
    vault,
    mockUSDC,
    quoteAuthority: account.address,
  };

  const server = createServer(makeHandler(cfg, account));
  server.listen(port, () => {
    // NEVER log the private key.
    console.log("[quote-service] listening");
    console.log(`  chainId:        ${MONAD_TESTNET.chainId}`);
    console.log(`  factory:        ${cfg.factory}`);
    console.log(`  vault:          ${cfg.vault}`);
    console.log(`  quoteAuthority: ${cfg.quoteAuthority}`);
    console.log(`  port:           ${port}`);
    console.log(`  allowedOrigin:  ${allowedOrigin}`);
  });
}

start().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[quote-service] startup failed: ${message}`);
  process.exit(1);
});
