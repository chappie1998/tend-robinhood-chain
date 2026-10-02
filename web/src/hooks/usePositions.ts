import type { Address } from "viem";
import { isAddressEqual } from "viem";
import { useAccount, useReadContract,  } from "wagmi";
import { useChainReads } from "./useChainReads";
import { tendPoolVaultAbi } from "../abis";
import { monadTestnet } from "../chain";
import { toUserMessage } from "../lib/errors";

export interface PositionSummary {
  positionId: bigint;
  buyer: Address;
  seriesId: `0x${string}`;
  direction: number;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  feeBps: number;
  settled: boolean;
  /** True only for a position its holder sold back to the pool before expiry. */
  closed: boolean;
  /** What the pool paid for it on that early exit; 0 for every other position. */
  closeBid: bigint;
}

export interface PositionsQuery {
  data: PositionSummary[] | undefined;
  isLoading: boolean;
  isError: boolean;
  errors: string[];
  /**
   * True if the vault holds more than MAX_ENUMERATED_POSITIONS positions and
   * only the newest that many ids were read — positions older than that exist
   * on-chain but weren't enumerated. False in every normal case: enumeration
   * has no block-window limit, so age alone never hides a position.
   */
  scanTruncated: boolean;
}

/**
 * Upper bound on how many position ids one render will read. The vault's ids
 * are dense and monotonic, so enumeration is exact, but it must not become an
 * unbounded multicall as the vault grows. Above this we read only the newest
 * ids and flag the result as truncated.
 *
 * Exported so useTradeHistory.ts (same enumeration, over full history rather
 * than just open positions) shares this one cap instead of drifting.
 */
export const MAX_ENUMERATED_POSITIONS = 500;

/**
 * The `positions` mapping's auto-generated Solidity getter flattens the
 * Position struct into eleven separate return values, so viem decodes it as an
 * ARRAY tuple — NOT an object with named fields. `result.buyer` is silently
 * `undefined` here; this exact trap has already caused real bugs in this repo
 * twice. Read the fields positionally, in this fixed ABI order:
 *
 *   0 buyer, 1 seriesId, 2 direction, 3 strike, 4 width,
 *   5 premium, 6 maxPayout, 7 feeBps, 8 settled, 9 closed, 10 closeBid
 *
 * (Contrast `getSeries` on the factory, which returns a single named struct
 * and therefore *does* decode to an object — see useSeriesList.ts.)
 */
export type PositionTuple = readonly [
  buyer: Address,
  seriesId: `0x${string}`,
  direction: number,
  strike: bigint,
  width: bigint,
  premium: bigint,
  maxPayout: bigint,
  feeBps: number,
  settled: boolean,
  closed: boolean,
  closeBid: bigint,
];

/**
 * Narrows a multicall result to the flattened tuple above, or undefined if it
 * isn't one. Exported so every caller of `positions(id)` — this hook and
 * useTradeHistory.ts — decodes the exact same way; this positional-tuple trap
 * has already caused real bugs in this repo twice (see the doc comment
 * above), so it must not be reimplemented a third time.
 */
export function asPositionTuple(result: unknown): PositionTuple | undefined {
  return Array.isArray(result) && result.length === 11 ? (result as unknown as PositionTuple) : undefined;
}

/**
 * Lists the connected wallet's positions by enumerating the vault directly:
 * `nextPositionId()` is the exclusive upper bound of a dense, monotonic id
 * space starting at 1, so every position that has ever been filled is
 * addressable as `positions(id)` with no scan window at all.
 *
 * This deliberately does not derive ids from `PoolQuoteFilled` logs. Monad
 * testnet's public RPC caps eth_getLogs to 100-block windows, which bounded
 * the old log scan to a ~3,000-block (~20 minute) lookback — a wallet that
 * filled a position an hour ago was told it had none, and so couldn't settle
 * or refund it from the UI. Enumeration has no such window.
 *
 * The id reads are batched through Multicall3 (configured in chain.ts), and
 * `positions(id)` already carries live settlement state, so no second read
 * pass is needed. Filtering to the connected buyer happens client-side —
 * the vault exposes no per-buyer index.
 */
export function usePositions(vaultAddress: Address | undefined): PositionsQuery {
  const { address: account } = useAccount();

  const nextIdQuery = useReadContract({
    address: vaultAddress,
    abi: tendPoolVaultAbi,
    chainId: monadTestnet.id,
    functionName: "nextPositionId",
    query: { enabled: Boolean(vaultAddress && account), staleTime: 15_000 },
  });

  // Ids run 1 .. nextPositionId - 1, newest first so the rendered table is
  // newest first without a later sort. Capped to the newest
  // MAX_ENUMERATED_POSITIONS ids; anything older is reported as truncated.
  const nextPositionId = nextIdQuery.data;
  const highestId = nextPositionId !== undefined && nextPositionId > 1n ? nextPositionId - 1n : 0n;
  const enumerateCount = highestId > BigInt(MAX_ENUMERATED_POSITIONS) ? BigInt(MAX_ENUMERATED_POSITIONS) : highestId;
  const lowestId = highestId - enumerateCount + 1n;
  const truncated = highestId > BigInt(MAX_ENUMERATED_POSITIONS);

  const positionIds: bigint[] = [];
  for (let id = highestId; id >= lowestId && id >= 1n; id--) {
    positionIds.push(id);
  }

  const positionsRead = useChainReads({
    contracts:
      vaultAddress && positionIds.length > 0
        ? positionIds.map(
            (id) =>
              ({
                address: vaultAddress,
                abi: tendPoolVaultAbi,
                chainId: monadTestnet.id,
                functionName: "positions",
                args: [id],
              }) as const,
          )
        : [],
    allowFailure: true,
    query: { enabled: Boolean(vaultAddress && positionIds.length > 0) },
  });

  const data: PositionSummary[] | undefined =
    nextPositionId !== undefined && account
      ? positionIds.flatMap((positionId, index) => {
          const entry = positionsRead.data?.[index];
          if (entry?.status !== "success") return [];
          const tuple = asPositionTuple(entry.result);
          if (!tuple) return [];
          const [buyer, seriesId, direction, strike, width, premium, maxPayout, feeBps, settled, closed, closeBid] =
            tuple;
          if (!isAddressEqual(buyer, account)) return [];
          return [
            { positionId, buyer, seriesId, direction, strike, width, premium, maxPayout, feeBps, settled, closed, closeBid },
          ];
        })
      : undefined;

  // toUserMessage, not String() — see usePoolState.ts's identical comment:
  // a raw viem RPC error's full message/toString is a multi-paragraph dump
  // containing unbroken hex calldata that blows the page out horizontally
  // when rendered verbatim (reproduced at ~54,000px wide). shortMessage is
  // the concise, wrap-safe form.
  const errors: string[] = [];
  if (nextIdQuery.error) errors.push(toUserMessage(nextIdQuery.error));
  if (positionsRead.error) errors.push(toUserMessage(positionsRead.error));

  return {
    data,
    isLoading: nextIdQuery.isLoading || (positionIds.length > 0 && positionsRead.isLoading),
    isError: nextIdQuery.isError || positionsRead.isError,
    errors,
    scanTruncated: truncated,
  };
}
