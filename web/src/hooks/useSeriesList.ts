import { useQuery } from "@tanstack/react-query";
import { isAddressEqual, zeroAddress, type Address } from "viem";
import { usePublicClient } from "wagmi";
import { useChainReads } from "./useChainReads";
import { tendSeriesFactoryAbi } from "../abis";
import { monadTestnet } from "../chain";
import { toUserMessage } from "../lib/errors";
import { getLogsPaginated } from "../lib/getLogsPaginated";

export interface SeriesSummary {
  seriesId: `0x${string}`;
  creator: Address;
  pythFeedId: `0x${string}`;
  settlementToken: Address;
  expiry: bigint;
  observationWindow: number;
  settlementGrace: number;
  maxConfidenceBps: number;
  symbol: `0x${string}`;
  isTradable: boolean | undefined;
  /** True if this series is pinned by the deployment manifest (the canonical seeded demo series). */
  seeded: boolean;
}

/** A series' immutable params, before the live `isTradable` read is attached. */
type SeriesCore = Omit<SeriesSummary, "isTradable">;

export interface SeriesListQuery {
  data: SeriesSummary[] | undefined;
  isLoading: boolean;
  isError: boolean;
  errors: string[];
  /** True if the log scan hit its lookback window before reaching block 0 — older series may exist but weren't scanned. See getLogsPaginated.ts. */
  scanTruncated: boolean;
}

/**
 * Lists series the factory has created recently by reading past
 * `SeriesCreated` logs (the event already carries every series param, so no
 * extra `getSeries` round trip is needed per series), then batches a live
 * `isTradable` read per series — that one's dynamic (guardian disable /
 * factory pause), so it can't be derived from the creation log alone.
 *
 * Logs are scanned via getLogsPaginated because Monad testnet's public RPC
 * caps eth_getLogs to 100-block windows and the chain is tens of millions of
 * blocks deep — see getLogsPaginated.ts for why this is a bounded recent
 * scan, not a full-history one.
 *
 * That bounded scan means a seeded demo series older than the window would
 * vanish from the list. To keep the canonical seeded series always visible,
 * `pinnedSeriesIds` (from the manifest) are read directly via `getSeries` and
 * merged in — authoritative on-chain data, not the manifest's copy — so a
 * public visitor always has something to trade regardless of the scan window.
 */
export function useSeriesList(
  factoryAddress: Address | undefined,
  pinnedSeriesIds?: readonly `0x${string}`[],
): SeriesListQuery {
  const publicClient = usePublicClient({ chainId: monadTestnet.id });

  const logsQuery = useQuery({
    queryKey: ["series-created-logs", factoryAddress],
    queryFn: async () => {
      if (!publicClient || !factoryAddress) return { series: [], truncated: false };
      const latestBlock = await publicClient.getBlockNumber();
      const { logs, truncated } = await getLogsPaginated(
        (fromBlock, toBlock) =>
          publicClient.getContractEvents({
            address: factoryAddress,
            abi: tendSeriesFactoryAbi,
            eventName: "SeriesCreated",
            fromBlock,
            toBlock,
          }),
        latestBlock,
      );
      const series = logs.flatMap((log) => {
        const args = log.args;
        if (
          args.seriesId === undefined ||
          args.creator === undefined ||
          args.pythFeedId === undefined ||
          args.settlementToken === undefined ||
          args.expiry === undefined ||
          args.observationWindow === undefined ||
          args.settlementGrace === undefined ||
          args.maxConfidenceBps === undefined ||
          args.symbol === undefined
        ) {
          return [];
        }
        return [
          {
            seriesId: args.seriesId,
            creator: args.creator,
            pythFeedId: args.pythFeedId,
            settlementToken: args.settlementToken,
            expiry: args.expiry,
            observationWindow: args.observationWindow,
            settlementGrace: args.settlementGrace,
            maxConfidenceBps: args.maxConfidenceBps,
            symbol: args.symbol,
          },
        ];
      });
      return { series, truncated };
    },
    enabled: Boolean(publicClient && factoryAddress),
    staleTime: 15_000,
  });

  // Pinned ids, deduped and normalized. A pinned id that already turned up in
  // the log scan doesn't need a getSeries read — it's marked seeded below.
  const pinnedIds = pinnedSeriesIds ?? [];
  const pinnedIdSet = new Set(pinnedIds.map((id) => id.toLowerCase()));
  const scannedIdSet = new Set((logsQuery.data?.series ?? []).map((s) => s.seriesId.toLowerCase()));
  const missingPinnedIds = Array.from(
    new Set(pinnedIds.map((id) => id.toLowerCase())),
  ).filter((id) => !scannedIdSet.has(id)) as `0x${string}`[];

  // Canonical on-chain read for pinned series that fell outside the scan
  // window. allowFailure so a nonexistent / reverting id doesn't sink the rest.
  const pinnedQuery = useChainReads({
    contracts:
      factoryAddress && missingPinnedIds.length > 0
        ? missingPinnedIds.map(
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
    query: { enabled: Boolean(factoryAddress && missingPinnedIds.length > 0) },
  });

  const pinnedOnlySeries: SeriesCore[] = missingPinnedIds.flatMap((id, index) => {
    const entry = pinnedQuery.data?.[index];
    if (!entry || entry.status !== "success") return [];
    const s = entry.result;
    // Skip ids that don't exist (getSeries returns a zeroed struct).
    if (isAddressEqual(s.creator, zeroAddress)) return [];
    return [
      {
        seriesId: id,
        creator: s.creator,
        pythFeedId: s.pythFeedId,
        settlementToken: s.settlementToken,
        expiry: s.expiry,
        observationWindow: s.observationWindow,
        settlementGrace: s.settlementGrace,
        maxConfidenceBps: s.maxConfidenceBps,
        symbol: s.symbol,
        seeded: true,
      },
    ];
  });

  // Merge: pinned-only series first (so they're always visible up top), then
  // the log-scanned series. No dupes — pinnedOnlySeries are, by construction,
  // ids absent from the scan. Scanned series that are also pinned are flagged
  // seeded so the UI can badge them.
  const scannedSeries: SeriesCore[] = (logsQuery.data?.series ?? []).map((s) => ({
    ...s,
    seeded: pinnedIdSet.has(s.seriesId.toLowerCase()),
  }));
  const mergedSeries: SeriesCore[] = [...pinnedOnlySeries, ...scannedSeries];

  // One live isTradable batch over every merged series (pinned + scanned),
  // resolved identically for all rows.
  const tradableQuery = useChainReads({
    contracts:
      factoryAddress && mergedSeries.length > 0
        ? mergedSeries.map(
            (s) =>
              ({
                address: factoryAddress,
                abi: tendSeriesFactoryAbi,
                chainId: monadTestnet.id,
                functionName: "isTradable",
                args: [s.seriesId],
              }) as const,
          )
        : [],
    allowFailure: true,
    query: { enabled: Boolean(factoryAddress && mergedSeries.length > 0) },
  });

  const data: SeriesSummary[] | undefined = logsQuery.data
    ? mergedSeries.map((series, index) => {
        const tradableEntry = tradableQuery.data?.[index];
        return {
          ...series,
          isTradable: tradableEntry?.status === "success" ? tradableEntry.result : undefined,
        };
      })
    : undefined;

  // toUserMessage, not String() — see usePoolState.ts's identical comment:
  // a raw viem RPC error's full message/toString is a multi-paragraph dump
  // containing unbroken hex calldata that blows the page out horizontally
  // when rendered verbatim (reproduced at ~54,000px wide). shortMessage is
  // the concise, wrap-safe form.
  const errors: string[] = [];
  if (logsQuery.error) errors.push(toUserMessage(logsQuery.error));
  if (pinnedQuery.error) errors.push(toUserMessage(pinnedQuery.error));
  if (tradableQuery.error) errors.push(toUserMessage(tradableQuery.error));

  return {
    data,
    isLoading:
      logsQuery.isLoading ||
      (missingPinnedIds.length > 0 && pinnedQuery.isLoading) ||
      (mergedSeries.length > 0 && tradableQuery.isLoading),
    isError: logsQuery.isError,
    errors,
    scanTruncated: logsQuery.data?.truncated ?? false,
  };
}
