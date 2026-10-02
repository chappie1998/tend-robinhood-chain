import { pastBucketsFor, futureBucketsFor } from "../lib/seriesSearchWindow";
import { nearestFillableSeries } from "../lib/liveSeriesSelection";
import { useNowSeconds } from "./useNowSeconds";
import { zeroHash, type Address, type Hex } from "viem";
import { useChainReads } from "./useChainReads";
import { tendPoolVaultAbi, tendSeriesFactoryAbi } from "../abis";
import { monadTestnet } from "../chain";
import type { SeededMarket } from "../deployment";
import {
  createSeriesParamsFor,
  expiryForBucket,
  tenorQualifiedSymbol,
  TENORS,
  type CreateSeriesParams,
  type TenorId,
} from "../lib/seriesParams";
import { fillabilityOf } from "./useSeriesDetail";

export interface LiveSeriesCandidate {
  seriesId: Hex;
  expiry: bigint;
  lastTradeAt: bigint;
  fillable: boolean;
  /**
   * Present whenever `fillable` is false — distinguishes "nothing was ever
   * seeded in the searched window" from "something was seeded but it's since
   * expired / past its trading cutoff", per the honest-state UI rule. Also
   * set (non-terminal) while the on-chain search is still in flight.
   */
  reason?: string;
  /**
   * "chain" when this hook found a currently-fillable series itself.
   * "manifest" when nothing on-chain qualified and this is the deployment
   * manifest's last-known series instead — no worse than pre-fix behavior,
   * since the components that render it (MarketSelector, TicketColumn) each
   * independently re-derive its real on-chain fillability via
   * useSeriesDetail and explain plainly if it isn't tradable.
   */
  source: "chain" | "manifest";
}

export interface LiveSeriesMarket {
  symbol: string;
  pythFeedId: Hex;
  /** One entry per configured tenor (TENORS, ../lib/seriesParams.ts), keyed
   * by tenor id. A trader picks one of these — see TenorSelector.tsx — never
   * a single collapsed "best" series the way this hook used to return. */
  tenors: Record<TenorId, LiveSeriesCandidate>;
}

export interface UseLiveSeriesResult {
  markets: LiveSeriesMarket[];
  isLoading: boolean;
  isError: boolean;
}

interface Candidate {
  marketIndex: number;
  tenorId: TenorId;
  expiry: bigint;
  params: CreateSeriesParams;
}

/**
 * Derives which series is actually live for each seeded market, PER TENOR,
 * by asking the chain, instead of trusting `manifest.seededSeries[]` — which
 * is baked into the build and goes stale the moment the keeper reseeds (see
 * the seeder cross-reference in ../lib/seriesParams.ts). The manifest is
 * still the source for each market's symbol + Pyth feed id (and, at the App
 * level, for contract addresses) — those don't drift; only "which seriesId
 * is live right now, for each tenor" does.
 *
 * For every (market, tenor) pair this reconstructs the seeder's
 * CreateSeriesParams for a window of candidate expiries (see
 * pastBucketsFor/futureBucketsFor above — wide enough to cover that tenor's
 * whole ladder, not just a single rung), batches `deriveSeriesId` for ALL of
 * them (every market x every tenor x every bucket) in one multicall, then
 * batches `isTradable` + `seriesAuth` for the resulting ids in a second
 * multicall. Unlike the single-series predecessor of this hook, it does NOT
 * collapse the result to one "best" candidate across the whole market —
 * fillable candidates are grouped BY TENOR, keeping the nearest-expiry
 * fillable candidate as the default WITHIN each tenor (the soonest settlement for that tenor). A tenor with nothing fillable falls
 * back to the manifest's own seriesId for THAT tenor, unmodified, so
 * downstream components' existing fillability checks explain exactly why
 * (expired vs. never found) instead of this hook fabricating a number it
 * can't back up — and, critically, never substituting a DIFFERENT tenor's
 * series for the one the trader actually selected.
 *
 * That last guarantee depends on `tenorQualifiedSymbol` (../lib/seriesParams.ts):
 * every tenor's own search window overlaps every other tenor's (they all
 * share the same underlying 900-second grid — see that function's comment),
 * so without a per-tenor-qualified symbol baked into the hashed
 * CreateSeriesParams, this hook COULD derive an id that happens to match a
 * real series belonging to a different tenor and report it under the wrong
 * one. Qualifying the symbol makes that structurally impossible rather than
 * merely unlikely.
 */
export function useLiveSeries(
  factoryAddress: Address | undefined,
  vaultAddress: Address | undefined,
  settlementToken: Address | undefined,
  manifestMarkets: readonly SeededMarket[],
): UseLiveSeriesResult {
  // Reconsider quote headroom every ten seconds; candidate IDs change only at grid boundaries.
  const nowSec = BigInt(useNowSeconds(10_000));

  const enabled = Boolean(factoryAddress && vaultAddress && settlementToken) && manifestMarkets.length > 0;

  const candidates: Candidate[] = enabled
    ? manifestMarkets.flatMap((market, marketIndex) =>
        TENORS.flatMap((tenor) => {
          const pastBuckets = pastBucketsFor(tenor);
          const futureBuckets = futureBucketsFor(tenor);
          const offsets: bigint[] = [];
          for (let k = -futureBuckets; k <= pastBuckets; k += 1n) offsets.push(k);
          return offsets.map((bucketOffset) => {
            const expiry = expiryForBucket(nowSec, bucketOffset, tenor.leadSeconds);
            return {
              marketIndex,
              tenorId: tenor.id,
              expiry,
              params: createSeriesParamsFor(
                { symbol: tenorQualifiedSymbol(market.symbol, tenor.id), pythFeedId: market.feedId },
                settlementToken!,
                expiry,
              ),
            };
          });
        }),
      )
    : [];

  // Stage 1: derive every candidate's seriesId. Pure function — no series
  // needs to exist on-chain for this to succeed, it's just the hash of the
  // params above.
  const deriveQuery = useChainReads({
    contracts:
      enabled && candidates.length > 0
        ? candidates.map(
            (c) =>
              ({
                address: factoryAddress!,
                abi: tendSeriesFactoryAbi,
                chainId: monadTestnet.id,
                functionName: "deriveSeriesId",
                args: [c.params],
              }) as const,
          )
        : [],
    allowFailure: true,
    query: { enabled: enabled && candidates.length > 0 },
  });

  // Resolved ids, aligned 1:1 with `candidates`. A candidate whose derive
  // call failed (shouldn't happen — it's a pure function) is dropped from
  // the probe stage below rather than treated as existing.
  const derivedIds: (Hex | undefined)[] = candidates.map((_, i) => {
    const entry = deriveQuery.data?.[i];
    return entry?.status === "success" ? (entry.result as Hex) : undefined;
  });

  // Which candidate indices resolved to an id, and where each one's pair of
  // reads (isTradable, seriesAuth) lands in probeQuery's flat result array —
  // built once so the lookup below is O(1) instead of a re-scan per market.
  const probeOrder: number[] = [];
  derivedIds.forEach((id, i) => {
    if (id !== undefined) probeOrder.push(i);
  });
  const probeSlotByIndex = new Map(probeOrder.map((i, slot) => [i, slot]));

  // Stage 2: for every resolved id, is it tradable (factory) and authorized
  // (pool)? seriesAuth is a plain public mapping — it never reverts, it
  // returns the zero struct (false, 0) for any id that was never authorized,
  // which is exactly the signal used below to tell "a real series existed
  // here" apart from "this id was never anything but a guess".
  const probeQuery = useChainReads({
    contracts:
      enabled && probeOrder.length > 0
        ? probeOrder.flatMap((i) => {
            const id = derivedIds[i]!;
            return [
              {
                address: factoryAddress!,
                abi: tendSeriesFactoryAbi,
                chainId: monadTestnet.id,
                functionName: "isTradable",
                args: [id],
              } as const,
              {
                address: vaultAddress!,
                abi: tendPoolVaultAbi,
                chainId: monadTestnet.id,
                functionName: "seriesAuth",
                args: [id],
              } as const,
            ];
          })
        : [],
    allowFailure: true,
    query: { enabled: enabled && probeOrder.length > 0 && deriveQuery.isSuccess, refetchInterval: 30_000 },
  });

  // The search is "done" once both stages have settled (or the second stage
  // was never needed because nothing derived). While still in flight, a
  // (market, tenor) pair without a fillable candidate YET is "still
  // searching", not "nothing found" — those need different reasons.
  const searchSettled = deriveQuery.isSuccess && (probeOrder.length === 0 || probeQuery.isSuccess);

  const markets: LiveSeriesMarket[] = manifestMarkets.map((market, marketIndex) => {
    const tenors = {} as Record<TenorId, LiveSeriesCandidate>;

    for (const tenor of TENORS) {
      const eligible: { seriesId: Hex; expiry: bigint; lastTradeAt: bigint; fillable: boolean }[] = [];
      // True once ANY candidate in this tenor's search window shows evidence
      // a real series was authorized here at some point (seriesAuth.lastTradeAt
      // > 0 is only ever set by an actual authorizeSeries call — a purely
      // guessed, never-created id always reads back (false, 0)).
      let sawEvidenceOfRealSeries = false;

      candidates.forEach((c, i) => {
        if (c.marketIndex !== marketIndex || c.tenorId !== tenor.id) return;
        const id = derivedIds[i];
        if (id === undefined) return;
        const slot = probeSlotByIndex.get(i);
        if (slot === undefined) return;

        const isTradableEntry = probeQuery.data?.[slot * 2];
        const authEntry = probeQuery.data?.[slot * 2 + 1];
        const isTradable = isTradableEntry?.status === "success" ? (isTradableEntry.result as boolean) : undefined;
        const auth = authEntry?.status === "success" ? (authEntry.result as readonly [boolean, bigint]) : undefined;

        if (auth && auth[1] > 0n) sawEvidenceOfRealSeries = true;

        const { fillable } = fillabilityOf({ isTradable, expiry: c.expiry }, auth, nowSec);
        // Prefer the nearest expiry among every fillable candidate WITHIN
        // this tenor — the earliest settlement for the tenor the trader
        // actually picked. Never compared across tenors: a 15m candidate
        // and a 12h candidate are never weighed against each other here.
        eligible.push({ seriesId: id, expiry: c.expiry, lastTradeAt: auth ? auth[1] : 0n, fillable });
      });

      const best = nearestFillableSeries(eligible, nowSec);
      if (best) {
        tenors[tenor.id] = {
          seriesId: best.seriesId,
          expiry: best.expiry,
          lastTradeAt: best.lastTradeAt,
          fillable: true,
          source: "chain",
        };
        continue;
      }

      const manifestSeriesId = market.seriesIdByTenor[tenor.id];
      const reason = !searchSettled
        ? `Checking for a live ${tenor.label} series on-chain…`
        : sawEvidenceOfRealSeries
          ? `The most recently seeded ${tenor.label} series for this market has expired or passed its trading ` +
            `cutoff — falling back to the deployment manifest until the keeper reseeds.`
          : `No live ${tenor.label} series found on-chain for this market — falling back to the deployment manifest.`;

      tenors[tenor.id] = {
        seriesId: manifestSeriesId ?? zeroHash,
        expiry: 0n,
        lastTradeAt: 0n,
        fillable: false,
        reason: manifestSeriesId ? reason : `${reason} No manifest fallback for ${tenor.label} either.`,
        source: "manifest",
      };
    }

    return { symbol: market.symbol, pythFeedId: market.feedId, tenors };
  });

  return {
    markets,
    isLoading: enabled && (deriveQuery.isLoading || (probeOrder.length > 0 && probeQuery.isLoading)),
    isError: deriveQuery.isError || probeQuery.isError,
  };
}
