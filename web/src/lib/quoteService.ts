import type { Address, Hex } from "viem";
import { parseSignedQuoteResponse, type SignedQuoteResponse } from "./quote";

// Base URL of the running quote-signing service. Configurable via a Vite env
// var (see web/.env.example); defaults to the service's local dev port so the
// demo works out of the box when both are run locally.
export const QUOTE_SERVICE_URL = import.meta.env.VITE_QUOTE_SERVICE_URL ?? "/api";

/**
 * Rungs of the strike ladder, nearest spot first — see
 * quote-service/strikeLadder.ts. The trader picks a STRIKE; the multiple is
 * whatever that strike is worth today. Asking for a multiple instead is what
 * used to make quotes fail outright near expiry.
 */
export const TILE_OPTIONS = [0, 1, 2] as const;
export type TileIndex = (typeof TILE_OPTIONS)[number];
export const DEFAULT_TILE: TileIndex = 1;

export interface QuoteRequestParams {
  seriesId: Hex;
  direction: "up" | "down";
  buyer: Address;
  /** What the trader pays, as a human mUSDC amount, e.g. "10". */
  premium: string;
  /** Which rung of the ladder; the service defaults to the middle one when omitted. */
  tile: TileIndex;
}

/**
 * POSTs a quote request to the signing service and returns the parsed,
 * signed quote. On a non-2xx response the service returns `{ error }` with a
 * clear 400/409/429/502 message — that message is surfaced verbatim so the
 * user sees exactly why the quote was refused. Network failures (service
 * down) are turned into an actionable message pointing at the URL.
 */
export async function requestQuote(params: QuoteRequestParams): Promise<SignedQuoteResponse> {
  let response: Response;
  try {
    response = await fetch(`${QUOTE_SERVICE_URL}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the quote service at ${QUOTE_SERVICE_URL}. Is it running? (${String(error)})`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Quote service returned HTTP ${response.status}.`;
    throw new Error(message);
  }

  return parseSignedQuoteResponse(body);
}
