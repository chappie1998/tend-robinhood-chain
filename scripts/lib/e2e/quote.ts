// EIP-712 signing/verification for TendPoolVault.PoolQuote, matching the
// contract's POOL_QUOTE_TYPEHASH and domainSeparator exactly: domain name
// "Tend Pool Vault", version "1", no salt (see contracts/TendPoolVault.sol —
// `domainSeparator()`, `hashQuote()`, `POOL_QUOTE_TYPEHASH`).
import { type Hex, recoverTypedDataAddress } from "viem";

export const POOL_QUOTE_DOMAIN_NAME = "Tend Pool Vault";
export const POOL_QUOTE_DOMAIN_VERSION = "1";

// Field order mirrors POOL_QUOTE_TYPEHASH byte-for-byte:
// "PoolQuote(uint256 nonce,uint8 direction,uint128 strike,uint128 width,uint128 premium,uint128 maxPayout,uint64 quoteExpiry,bytes32 seriesId,address buyer)"
export const POOL_QUOTE_TYPES = {
  PoolQuote: [
    { name: "nonce", type: "uint256" },
    { name: "direction", type: "uint8" },
    { name: "strike", type: "uint128" },
    { name: "width", type: "uint128" },
    { name: "premium", type: "uint128" },
    { name: "maxPayout", type: "uint128" },
    { name: "quoteExpiry", type: "uint64" },
    { name: "seriesId", type: "bytes32" },
    { name: "buyer", type: "address" },
  ],
} as const;

export const DIRECTION_UP = 0;
export const DIRECTION_DOWN = 1;

export interface PoolQuote {
  nonce: bigint;
  direction: number;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  quoteExpiry: bigint;
  seriesId: Hex;
  buyer: Hex;
}

export function poolQuoteDomain(chainId: number, verifyingContract: Hex) {
  return {
    name: POOL_QUOTE_DOMAIN_NAME,
    version: POOL_QUOTE_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

function poolQuoteMessage(quote: PoolQuote) {
  return {
    nonce: quote.nonce,
    direction: quote.direction,
    strike: quote.strike,
    width: quote.width,
    premium: quote.premium,
    maxPayout: quote.maxPayout,
    quoteExpiry: quote.quoteExpiry,
    seriesId: quote.seriesId,
    buyer: quote.buyer,
  };
}

/// Positional tuple matching the Solidity struct's field order exactly, for
/// calls that take PoolQuote as an ABI tuple (`hashQuote`, `fillPoolQuote`).
export function poolQuoteTuple(quote: PoolQuote) {
  return [
    quote.nonce,
    quote.direction,
    quote.strike,
    quote.width,
    quote.premium,
    quote.maxPayout,
    quote.quoteExpiry,
    quote.seriesId,
    quote.buyer,
  ] as const;
}

// ---------------------------------------------------------------------------
// CloseQuote — the desk's signed bid for one open position, letting its holder
// exit before expiry. Same domain as PoolQuote (one verifying contract, one
// domain separator); mirrors CLOSE_QUOTE_TYPEHASH in contracts/TendPoolVault.sol:
// "CloseQuote(uint256 nonce,uint256 positionId,uint128 bid,uint64 quoteExpiry,address seller)"
// ---------------------------------------------------------------------------
export const CLOSE_QUOTE_TYPES = {
  CloseQuote: [
    { name: "nonce", type: "uint256" },
    { name: "positionId", type: "uint256" },
    { name: "bid", type: "uint128" },
    { name: "quoteExpiry", type: "uint64" },
    { name: "seller", type: "address" },
  ],
} as const;

export interface CloseQuote {
  nonce: bigint;
  positionId: bigint;
  bid: bigint;
  quoteExpiry: bigint;
  seller: Hex;
}

function closeQuoteMessage(quote: CloseQuote) {
  return {
    nonce: quote.nonce,
    positionId: quote.positionId,
    bid: quote.bid,
    quoteExpiry: quote.quoteExpiry,
    seller: quote.seller,
  };
}

/// Positional tuple matching the Solidity struct's field order exactly, for
/// calls that take CloseQuote as an ABI tuple (`hashCloseQuote`, `closePosition`).
export function closeQuoteTuple(quote: CloseQuote) {
  return [quote.nonce, quote.positionId, quote.bid, quote.quoteExpiry, quote.seller] as const;
}

export function closeQuoteSignTypedData(chainId: number, verifyingContract: Hex, quote: CloseQuote) {
  return {
    domain: poolQuoteDomain(chainId, verifyingContract),
    types: CLOSE_QUOTE_TYPES,
    primaryType: "CloseQuote" as const,
    message: closeQuoteMessage(quote),
  };
}

export async function verifyCloseQuoteSignatureOffchain(params: {
  chainId: number;
  verifyingContract: Hex;
  quote: CloseQuote;
  signature: Hex;
  expectedSigner: Hex;
}): Promise<{ ok: boolean; recovered: Hex }> {
  const recovered = await recoverTypedDataAddress({
    ...closeQuoteSignTypedData(params.chainId, params.verifyingContract, params.quote),
    signature: params.signature,
  });
  return { ok: recovered.toLowerCase() === params.expectedSigner.toLowerCase(), recovered };
}

export function poolQuoteSignTypedData(chainId: number, verifyingContract: Hex, quote: PoolQuote) {
  return {
    domain: poolQuoteDomain(chainId, verifyingContract),
    types: POOL_QUOTE_TYPES,
    primaryType: "PoolQuote" as const,
    message: poolQuoteMessage(quote),
  };
}

/// Verifies a signature recovers to `expectedSigner` purely off-chain via
/// viem's own EIP-712 hashing — independent of (and a cross-check against)
/// the contract's on-chain `hashQuote` + `ecrecover` path, which is checked
/// separately on-chain before any transaction is sent.
export async function verifyPoolQuoteSignatureOffchain(params: {
  chainId: number;
  verifyingContract: Hex;
  quote: PoolQuote;
  signature: Hex;
  expectedSigner: Hex;
}): Promise<{ ok: boolean; recovered: Hex }> {
  const recovered = await recoverTypedDataAddress({
    ...poolQuoteSignTypedData(params.chainId, params.verifyingContract, params.quote),
    signature: params.signature,
  });
  return { ok: recovered.toLowerCase() === params.expectedSigner.toLowerCase(), recovered };
}
