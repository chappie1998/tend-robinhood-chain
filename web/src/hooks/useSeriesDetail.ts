import { useNowSeconds } from "./useNowSeconds";
import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { useChainReads } from "./useChainReads";
import { tendPoolVaultAbi, tendSeriesFactoryAbi } from "../abis";
import { monadTestnet } from "../chain";

export interface Fillability {
  fillable: boolean;
  /** Present when not fillable — the reason, surfaced to the trader instead of a silently disabled ticket. */
  reason?: string;
}

/**
 * Decides whether a series can be filled right now. Fillable requires: the
 * factory reports it tradable, it hasn't expired, the pool has authorized it
 * (seriesAuth.enabled), and we're before its trading cutoff (lastTradeAt).
 * These mirror the guards the quote service and the vault enforce, so a
 * disabled ticket explains up-front why a quote/fill would be refused.
 *
 * Shared by SeriesPanel's "browse all series" table and the single-series
 * trade-ticket column — both need the identical rule, applied to a series
 * shaped slightly differently (the table's SeriesSummary vs. this file's
 * single-series read), hence the narrow structural type instead of importing
 * SeriesSummary and creating a circular dependency between the two hooks.
 */
export function fillabilityOf(
  series: { isTradable: boolean | undefined; expiry: bigint },
  auth: readonly [boolean, bigint] | undefined,
  nowSec: bigint,
): Fillability {
  if (series.isTradable === undefined) return { fillable: false, reason: "Checking tradability…" };
  if (!series.isTradable) return { fillable: false, reason: "Series is not tradable (factory disabled or paused)." };
  if (nowSec >= series.expiry) return { fillable: false, reason: "Series has expired." };
  if (auth === undefined) return { fillable: false, reason: "Checking pool authorization…" };
  const [enabled, lastTradeAt] = auth;
  if (!enabled) return { fillable: false, reason: "Series is not authorized on the pool." };
  if (lastTradeAt > 0n && nowSec >= lastTradeAt) {
    return { fillable: false, reason: "Past the series trading cutoff (lastTradeAt)." };
  }
  return { fillable: true };
}

export interface SeriesDetail {
  seriesId: Hex;
  pythFeedId: Hex;
  settlementToken: Address;
  expiry: bigint;
  /** bytes32 — decode with bytes32ToUtf8 at render time, same as SeriesSummary elsewhere. */
  symbol: Hex;
}

export interface SeriesDetailQuery {
  detail: SeriesDetail | undefined;
  fillable: boolean;
  reason: string | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Authoritative on-chain read for exactly ONE series: its immutable
 * getSeries() params, the factory's live isTradable flag, and the vault's
 * per-series authorization — batched via multicall. Used by the trade-ticket
 * column, which targets a single active market (the one the selector or the
 * series table pointed at), unlike useSeriesList's broader "discover every
 * series the factory has ever created" job via log scanning. A direct
 * getSeries read has no scan window and no truncation risk.
 */
export function useSeriesDetail(
  factoryAddress: Address | undefined,
  vaultAddress: Address | undefined,
  seriesId: Hex | undefined,
): SeriesDetailQuery {
  const enabled = Boolean(factoryAddress && vaultAddress && seriesId);

  const read = useChainReads({
    contracts: enabled
      ? [
          {
            address: factoryAddress!,
            abi: tendSeriesFactoryAbi,
            chainId: monadTestnet.id,
            functionName: "getSeries",
            args: [seriesId!],
          },
          {
            address: factoryAddress!,
            abi: tendSeriesFactoryAbi,
            chainId: monadTestnet.id,
            functionName: "isTradable",
            args: [seriesId!],
          },
          {
            address: vaultAddress!,
            abi: tendPoolVaultAbi,
            chainId: monadTestnet.id,
            functionName: "seriesAuth",
            args: [seriesId!],
          },
        ]
      : [],
    allowFailure: true,
    query: { enabled, refetchInterval: 15_000 },
  });

  const [seriesRes, tradableRes, authRes] = read.data ?? [];

  const seriesStruct = seriesRes?.status === "success" ? seriesRes.result : undefined;
  const exists = seriesStruct !== undefined && !isAddressEqual(seriesStruct.creator, zeroAddress);

  const detail: SeriesDetail | undefined =
    exists && seriesStruct && seriesId
      ? {
          seriesId,
          pythFeedId: seriesStruct.pythFeedId,
          settlementToken: seriesStruct.settlementToken,
          expiry: seriesStruct.expiry,
          symbol: seriesStruct.symbol,
        }
      : undefined;

  const isTradable = tradableRes?.status === "success" ? tradableRes.result : undefined;
  const auth = authRes?.status === "success" ? (authRes.result as readonly [boolean, bigint]) : undefined;

  const nowSec = BigInt(useNowSeconds(10_000));
  const { fillable, reason } =
    detail === undefined
      ? { fillable: false, reason: read.isLoading ? "Loading series…" : "Series not found on-chain." }
      : fillabilityOf({ isTradable, expiry: detail.expiry }, auth, nowSec);

  return {
    detail,
    fillable,
    reason,
    isLoading: enabled && read.isLoading,
    isError: read.isError,
  };
}
