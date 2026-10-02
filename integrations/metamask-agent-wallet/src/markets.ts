import { stringToHex, type Hex, type PublicClient } from "viem";
import { factoryAbi, vaultAbi } from "./abi.js";
import { FACTORY, SETTLEMENT_TOKEN, TENORS, UNDERLYINGS, VAULT } from "./config.js";

const GRID = 900n;
const QUOTE_HEADROOM = 90n;
interface Candidate { symbol: string; tenor: string; expiry: bigint; params: { pythFeedId: Hex; settlementToken: typeof SETTLEMENT_TOKEN; expiry: bigint; observationWindow: number; settlementGrace: number; maxConfidenceBps: number; symbol: Hex } }
export interface LiveMarket { symbol: string; tenor: string; seriesId?: Hex; expiry?: string; lastTradeAt?: string; fillable: boolean; reason?: string }

export function candidateParams(now: bigint): Candidate[] {
  const bucket = ((now + GRID - 1n) / GRID) * GRID;
  return UNDERLYINGS.flatMap((market) => TENORS.flatMap((tenor) => {
    const past = tenor.leadSeconds / GRID + 2n;
    const future = BigInt(tenor.ladderSize) * (tenor.leadSeconds / GRID) + 2n;
    const rows: Candidate[] = [];
    for (let offset = -future; offset <= past; offset += 1n) {
      const expiry = bucket - offset * GRID + tenor.leadSeconds;
      rows.push({ symbol: market.symbol, tenor: tenor.id, expiry, params: { pythFeedId: market.feedId, settlementToken: SETTLEMENT_TOKEN, expiry, observationWindow: 60, settlementGrace: 3_600, maxConfidenceBps: 500, symbol: stringToHex(`${market.symbol}-${tenor.id.toUpperCase()}`, { size: 32 }) } });
    }
    return rows;
  }));
}

export async function discoverMarkets(client: PublicClient, now = BigInt(Math.floor(Date.now() / 1000))): Promise<LiveMarket[]> {
  const candidates = candidateParams(now);
  const ids = await client.multicall({ allowFailure: false, contracts: candidates.map((c) => ({ address: FACTORY, abi: factoryAbi, functionName: "deriveSeriesId" as const, args: [c.params] })) });
  const probes = await client.multicall({ allowFailure: true, contracts: ids.flatMap((id) => [
    { address: FACTORY, abi: factoryAbi, functionName: "isTradable" as const, args: [id] },
    { address: VAULT, abi: vaultAbi, functionName: "seriesAuth" as const, args: [id] },
  ]) });
  return UNDERLYINGS.flatMap((market) => TENORS.map((tenor) => {
    const eligible = candidates.flatMap((c, index) => {
      if (c.symbol !== market.symbol || c.tenor !== tenor.id) return [];
      const tradable = probes[index * 2]; const auth = probes[index * 2 + 1];
      if (tradable?.status !== "success" || auth?.status !== "success") return [];
      const [enabled, lastTradeAt] = auth.result as readonly [boolean, bigint];
      return tradable.result === true && enabled && c.expiry > now && lastTradeAt > now + QUOTE_HEADROOM ? [{ seriesId: ids[index], expiry: c.expiry, lastTradeAt }] : [];
    }).sort((a, b) => a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0);
    const best = eligible[0];
    return best ? { symbol: market.symbol, tenor: tenor.id, seriesId: best.seriesId, expiry: best.expiry.toString(), lastTradeAt: best.lastTradeAt.toString(), fillable: true } : { symbol: market.symbol, tenor: tenor.id, fillable: false, reason: "No live authorized series found in the bounded keeper ladder window." };
  }));
}
