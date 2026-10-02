import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { candidateParams, discoverMarkets } from "./markets.js";

describe("live market discovery", () => {
  it("derives bounded candidates for every underlying and tenor", () => {
    const candidates = candidateParams(2_000_000_000n);
    expect(candidates.length).toBe(468);
    expect(new Set(candidates.map((c) => `${c.symbol}:${c.tenor}`)).size).toBe(9);
  });

  it("selects the nearest live authorized candidate", async () => {
    const now = 2_000_000_000n;
    const candidates = candidateParams(now);
    const ids = candidates.map((_, i) => `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`);
    let calls = 0;
    const client = { multicall: async () => {
      calls += 1;
      if (calls === 1) return ids;
      return ids.flatMap((_id, i) => [
        { status: "success", result: i === 0 },
        { status: "success", result: [i === 0, now + 1_000n] },
      ]);
    } } as unknown as PublicClient;
    const markets = await discoverMarkets(client, now);
    expect(markets).toHaveLength(9);
    expect(markets[0]).toMatchObject({ symbol: "BTC", tenor: "15m", seriesId: ids[0], fillable: true });
    expect(markets.slice(1).every((m) => !m.fillable)).toBe(true);
  });
});
