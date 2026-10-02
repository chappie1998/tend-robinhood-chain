import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { useChainReads } from "./useChainReads";
import { tendSeriesFactoryAbi } from "../abis";
import { monadTestnet } from "../chain";

export interface SeriesFeed {
  pythFeedId: Hex;
  /** Unix seconds. Marks depend on time remaining and are unavailable after expiry. */
  expiry: number;
  /** bytes32 — decode with bytes32ToUtf8 at render time. */
  symbol: Hex;
}

export interface SeriesFeedsQuery {
  /** Keyed by lowercased series id. Missing entries mean "not resolved yet" — never fabricated. */
  data: Record<string, SeriesFeed>;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Resolves { pythFeedId, symbol } for an arbitrary, caller-supplied list of
 * series ids via direct getSeries() reads — no event-log scanning, no
 * isTradable check. Purpose-built for the positions panel's live P&L
 * estimate, which already knows exactly which series ids it cares about (the
 * connected wallet's open positions, which may include series useSeriesList's
 * bounded log scan would never see) and only needs each one's Pyth feed id.
 */
export function useSeriesFeeds(factoryAddress: Address | undefined, seriesIds: readonly Hex[]): SeriesFeedsQuery {
  const uniqueIds = Array.from(new Set(seriesIds.map((id) => id.toLowerCase()))) as Hex[];

  const read = useChainReads({
    contracts:
      factoryAddress && uniqueIds.length > 0
        ? uniqueIds.map(
            (id) =>
              ({
                address: factoryAddress,
                abi: tendSeriesFactoryAbi,
                chainId: monadTestnet.id,
                functionName: "getSeries",
                args: [id],
              }) as const,
          )
        : [],
    allowFailure: true,
    query: { enabled: Boolean(factoryAddress && uniqueIds.length > 0) },
  });

  const data: Record<string, SeriesFeed> = {};
  uniqueIds.forEach((id, index) => {
    const entry = read.data?.[index];
    if (entry?.status !== "success") return;
    const s = entry.result;
    if (isAddressEqual(s.creator, zeroAddress)) return; // nonexistent id — getSeries returns a zeroed struct
    data[id] = { pythFeedId: s.pythFeedId, symbol: s.symbol, expiry: Number(s.expiry) };
  });

  return {
    data,
    isLoading: uniqueIds.length > 0 && read.isLoading,
    isError: read.isError,
  };
}
