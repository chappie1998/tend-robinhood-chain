import type { Address, Hex } from "viem";
import { QUOTE_SERVICE_URL } from "./quoteService";

/**
 * The desk's signed bid for one open position — what the pool will pay to buy
 * it back before expiry. Priced by the same Black-Scholes engine that priced
 * the premium and the "Worth now" mark, less a fixed spread, so the three
 * numbers can never tell a trader three different stories.
 *
 * See quote-service/closeQuote.ts for the pipeline and
 * TendPoolVault.closePosition for what the chain does with this.
 */
export interface SignedCloseQuote {
  quote: {
    nonce: string;
    positionId: string;
    bid: string;
    quoteExpiry: string;
    seller: Address;
  };
  signature: Hex;
  verifyingContract: Address;
  chainId: number;
  /** Model value of the position right now, raw settlement-token units. */
  mark: string;
  /** What the desk pays, raw units: mark less `spreadBps`. */
  bid: string;
  spreadBps: number;
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

/** Positional tuple matching the Solidity CloseQuote struct's field order exactly. */
export function closeQuoteTuple(quote: SignedCloseQuote["quote"]) {
  return [
    BigInt(quote.nonce),
    BigInt(quote.positionId),
    BigInt(quote.bid),
    BigInt(quote.quoteExpiry),
    quote.seller,
  ] as const;
}

export async function requestCloseQuote(params: { positionId: bigint; seller: Address }): Promise<SignedCloseQuote> {
  let response: Response;
  try {
    response = await fetch(`${QUOTE_SERVICE_URL}/close-quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionId: params.positionId.toString(), seller: params.seller }),
    });
  } catch (error) {
    throw new Error(`Could not reach the quote service at ${QUOTE_SERVICE_URL}. (${String(error)})`);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Quote service returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body as SignedCloseQuote;
}
