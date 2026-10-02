import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";

/**
 * Indicative present value of open, pre-expiry positions.
 *
 * New width=1 positions use binary win probability; historical wider
 * positions use spread value. The position table separately shows the
 * hypothetical payoff at current spot only before expiry.
 *
 * Server-side because valuation uses validated exchange history and a shared
 * volatility cache. Coinbase's public data path needs no API key. See api/mark.ts.
 */
export type MarkInput = {
  positionId: string;
  feedId: Hex;
  direction: "up" | "down";
  strike: string;
  width: string;
  premium: string;
  maxPayout: string;
  expiry: number;
  spot: number;
};

export type Mark = {
  /** Present value in mUSDC, or null when no volatility estimate was available. */
  value: number | null;
  /** value - premium: the honest unrealised P&L. */
  pnl: number | null;
  volAnnual?: number;
  hoursToExpiry?: number;
};

/** Matches the chart/spot cadence — a mark that lags spot badly is worse than none. */
const MARK_REFRESH_MS = 30_000;

export function useMarkToMarket(inputs: MarkInput[]) {
  // Keyed by the position ids AND the spot values, so the mark refreshes when
  // the market moves rather than only on the interval.
  const key = inputs.map((i) => `${i.positionId}:${i.spot.toFixed(2)}`).join(",");

  const query = useQuery({
    queryKey: ["markToMarket", key],
    enabled: inputs.length > 0,
    refetchInterval: MARK_REFRESH_MS,
    queryFn: async () => {
      const response = await fetch("/api/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions: inputs.map(({ direction, strike, width, maxPayout, premium, expiry, feedId, spot }) => ({ direction, strike, width, maxPayout, premium, expiry, feedId, spot })) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Mark-to-market request failed (${response.status}).`);
      }
      const body = (await response.json()) as { marks: Mark[] };
      const byId = new Map<string, Mark>();
      inputs.forEach((input, index) => {
        const mark = body.marks?.[index];
        if (mark) byId.set(input.positionId, mark);
      });
      return byId;
    },
  });

  return {
    marks: query.data ?? new Map<string, Mark>(),
    isLoading: query.isLoading,
    // Deliberately surfaced rather than swallowed: if valuation is down the
    // table falls back to the payoff-now figure, and the caller should be
    // able to say so instead of silently showing the worse number.
    error: query.error instanceof Error ? query.error.message : undefined,
  };
}
