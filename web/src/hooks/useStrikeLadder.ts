import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import { QUOTE_SERVICE_URL } from "../lib/quoteService";

/**
 * The three strike tiles for one series, priced but unsigned.
 *
 * The ticket shows the three fixed binary payout tiers before the trader
 * picks one. This unsigned preview shares the signed quote's strike engine
 * without consuming a nonce or quote window.
 */
export interface StrikeTile {
  index: number;
  /** Exact human price decimal from the signed 1e8-scaled raw strike. */
  strike: string;
  strikeOffsetFraction: number;
  /** Fixed winning payout tier: 1.5, 2, or 3. */
  multiple: number;
  probabilityItm: number;
  /** Binary tickets profit exactly when they finish in the money. */
  probabilityProfit: number;
}

export interface StrikeLadder {
  tiles: StrikeTile[];
  spot: number;
  impliedVolatility: number;
  timeToExpiryHours: number;
}

/** Matches the spot cadence: the ladder is priced off spot, so a stale ladder is a lying tile. */
const LADDER_REFRESH_MS = 15_000;

export function useStrikeLadder(seriesId: Hex | undefined, direction: "up" | "down") {
  const query = useQuery({
    queryKey: ["strikeLadder", seriesId, direction],
    enabled: Boolean(seriesId),
    refetchInterval: LADDER_REFRESH_MS,
    staleTime: LADDER_REFRESH_MS,
    retry: 1,
    queryFn: async (): Promise<StrikeLadder> => {
      const response = await fetch(`${QUOTE_SERVICE_URL}/strike-ladder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seriesId, direction }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Strike ladder returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      return body as StrikeLadder;
    },
  });

  return {
    // Never a partially-filled ladder: on error the tiles show their dormant
    // state rather than a mix of real and missing tiers.
    ladder: query.isError ? undefined : query.data,
    isLoading: Boolean(seriesId) && query.isPending,
    error: query.error ? (query.error as Error).message : undefined,
  };
}
