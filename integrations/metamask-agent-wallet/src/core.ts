import { encodeFunctionData, getAddress, isHex, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { CHAIN_ID, FACTORY, MAX_MULTIPLE, MAX_PREMIUM_RAW, MAX_QUOTE_TTL_SECONDS, SETTLEMENT_TOKEN, VAULT, apiOrigin } from "./config.js";
import { erc20Abi, vaultAbi } from "./abi.js";

export interface PoolQuote { nonce: bigint; direction: number; strike: bigint; width: bigint; premium: bigint; maxPayout: bigint; quoteExpiry: bigint; seriesId: Hex; buyer: Address }
export interface CloseQuote { nonce: bigint; positionId: bigint; bid: bigint; quoteExpiry: bigint; seller: Address }
export interface SignedQuote { quote: PoolQuote; signature: Hex; verifyingContract: Address; chainId: number; multiple: number; tile: number; humanTerms?: unknown }
export interface SignedCloseQuote { quote: CloseQuote; signature: Hex; verifyingContract: Address; chainId: number; bid: string; humanTerms?: unknown }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function uint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${label} must be an unsigned integer string.`);
  return BigInt(value);
}
function hex(value: unknown, bytes: number | undefined, label: string): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || (bytes !== undefined && value.length !== 2 + bytes * 2)) throw new Error(`${label} must be ${bytes ? `${bytes}-byte ` : ""}hex.`);
  return value as Hex;
}
function enforceEnvelope(r: Record<string, unknown>, buyer: Address): void {
  if (r.chainId !== CHAIN_ID) throw new Error(`Quote chainId must be ${CHAIN_ID}.`);
  if (getAddress(String(r.verifyingContract)) !== VAULT) throw new Error("Quote verifying contract is not the configured Tend vault.");
  if (getAddress(String(buyer)) !== buyer) throw new Error("Quote wallet address mismatch.");
}
function enforceExpiry(expiry: bigint, now = BigInt(Math.floor(Date.now() / 1000))): void {
  if (expiry < now) throw new Error("Quote has expired.");
  if (expiry - now > MAX_QUOTE_TTL_SECONDS) throw new Error("Quote expiry exceeds the local 90 second risk bound.");
}

export interface QuoteIntent { seriesId: Hex; direction: "up" | "down"; premium: string; tile: number; buyer: Address }
export function parseSignedQuote(value: unknown, expected: QuoteIntent): SignedQuote {
  const r = record(value, "Quote response");
  const q = record(r.quote, "quote");
  const quote: PoolQuote = { nonce: uint(q.nonce, "quote.nonce"), direction: Number(q.direction), strike: uint(q.strike, "quote.strike"), width: uint(q.width, "quote.width"), premium: uint(q.premium, "quote.premium"), maxPayout: uint(q.maxPayout, "quote.maxPayout"), quoteExpiry: uint(q.quoteExpiry, "quote.quoteExpiry"), seriesId: hex(q.seriesId, 32, "quote.seriesId"), buyer: getAddress(String(q.buyer)) };
  enforceEnvelope(r, quote.buyer);
  if (quote.buyer !== expected.buyer) throw new Error("Signed quote buyer does not match selected wallet.");
  if (quote.seriesId.toLowerCase() !== expected.seriesId.toLowerCase()) throw new Error("Signed quote series does not match the requested market.");
  if (quote.direction !== (expected.direction === "up" ? 0 : 1)) throw new Error("Signed quote direction does not match the request.");
  if (Number(r.tile) !== expected.tile) throw new Error("Signed quote tile does not match the request.");
  let requestedPremium: bigint;
  try { requestedPremium = parseUnits(expected.premium, 6); } catch { throw new Error("Requested premium is not a valid mUSDC decimal."); }
  if (requestedPremium <= 0n || requestedPremium > MAX_PREMIUM_RAW) throw new Error("Requested premium must be greater than zero and at most 100 mUSDC.");
  if (quote.premium > requestedPremium) throw new Error("Signed quote premium exceeds the user-requested maximum.");
  if (![0, 1].includes(quote.direction) || quote.strike <= 0n || quote.width <= 0n || quote.premium <= 0n || quote.maxPayout <= 0n) throw new Error("Signed quote contains invalid trade terms.");
  if (quote.premium > MAX_PREMIUM_RAW) throw new Error("Signed quote exceeds the 100 mUSDC plugin premium bound.");
  const multiple = Number(r.multiple);
  if (!Number.isFinite(multiple) || multiple <= 0 || multiple > MAX_MULTIPLE || quote.maxPayout * 1_000n > quote.premium * BigInt(MAX_MULTIPLE * 1_000)) throw new Error("Signed quote exceeds the 4x payout bound.");
  enforceExpiry(quote.quoteExpiry);
  return { quote, signature: hex(r.signature, 65, "signature"), verifyingContract: VAULT, chainId: CHAIN_ID, multiple, tile: Number(r.tile), humanTerms: r.humanTerms };
}

export function parseSignedCloseQuote(value: unknown, seller: Address, positionId: bigint, maxPayout: bigint): SignedCloseQuote {
  const r = record(value, "Close quote response"); const q = record(r.quote, "quote");
  const quote: CloseQuote = { nonce: uint(q.nonce, "quote.nonce"), positionId: uint(q.positionId, "quote.positionId"), bid: uint(q.bid, "quote.bid"), quoteExpiry: uint(q.quoteExpiry, "quote.quoteExpiry"), seller: getAddress(String(q.seller)) };
  enforceEnvelope(r, quote.seller);
  if (quote.seller !== seller || quote.positionId !== positionId) throw new Error("Signed close quote does not match selected wallet and position.");
  if (quote.bid <= 0n || quote.bid > maxPayout) throw new Error("Close bid is outside position escrow bounds.");
  enforceExpiry(quote.quoteExpiry);
  return { quote, signature: hex(r.signature, 65, "signature"), verifyingContract: VAULT, chainId: CHAIN_ID, bid: String(r.bid), humanTerms: r.humanTerms };
}

async function post(path: string, body: unknown, origin?: string): Promise<unknown> {
  const response = await fetch(`${apiOrigin(origin)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data: unknown = await response.json().catch(() => { throw new Error(`Tend API returned non-JSON (${response.status}).`); });
  if (!response.ok) throw new Error(`Tend API ${response.status}: ${String(record(data, "error response").error ?? "request failed")}`);
  return data;
}
export async function requestQuote(input: { seriesId: Hex; direction: "up" | "down"; premium: string; tile: number; buyer: Address; origin?: string }): Promise<SignedQuote> {
  return parseSignedQuote(await post("/api/quote", input, input.origin), input);
}
export async function requestCloseQuote(input: { positionId: bigint; seller: Address; maxPayout: bigint; origin?: string }): Promise<SignedCloseQuote> {
  return parseSignedCloseQuote(await post("/api/close-quote", { positionId: input.positionId.toString(), seller: input.seller }, input.origin), input.seller, input.positionId, input.maxPayout);
}

export async function assertDeployment(client: PublicClient): Promise<void> {
  const code = await Promise.all([client.getCode({ address: VAULT }), client.getCode({ address: FACTORY }), client.getCode({ address: SETTLEMENT_TOKEN })]);
  if (code.some((x) => !x || x === "0x")) throw new Error("Configured Tend deployment is missing contract code on Monad testnet.");
}
export function buyData(s: SignedQuote): Hex { return encodeFunctionData({ abi: vaultAbi, functionName: "fillPoolQuote", args: [s.quote, s.signature] }); }
export function closeData(s: SignedCloseQuote): Hex { return encodeFunctionData({ abi: vaultAbi, functionName: "closePosition", args: [s.quote, s.signature] }); }
export function approveData(amount: bigint): Hex { return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULT, amount] }); }
