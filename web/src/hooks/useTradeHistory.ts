import type { Address, Hex } from "viem";
import { isAddressEqual } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useChainReads } from "./useChainReads";
import { asPositionTuple, MAX_ENUMERATED_POSITIONS } from "./usePositions";
import { tendPoolVaultAbi, tendSeriesFactoryAbi } from "../abis";
import { monadTestnet } from "../chain";
import { toUserMessage } from "../lib/errors";

export type TradeStatus = "open" | "settled" | "refunded" | "closed";

export interface TradeHistoryRow {
  positionId: bigint;
  seriesId: Hex;
  direction: number;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  /**
   * Undefined only while this row's settlement/refundability reads are still
   * in flight (an open row is always immediately "open" — it has no such
   * dependency). Never guessed.
   */
  status: TradeStatus | undefined;
  /**
   * Realised payout: `calculatePayout()`'s result for a settled row, the
   * full premium for a refunded row (refundPoolPosition returns exactly
   * that), or the desk's bid for a row the holder sold back early (recorded
   * on-chain as `closeBid`). Undefined for an open row, or for a settled row
   * whose payout hasn't resolved yet — the component renders those differently ("—" vs
   * "…"), so this never stands in for either on its own.
   */
  payout: bigint | undefined;
  /** payout - premium. Exactly 0n for a refunded row — the premium came back in full, not a loss. Undefined wherever payout is undefined. */
  pnl: bigint | undefined;
  /** The settlement's own publishTime, unix seconds — the only honest timestamp available for a row. Undefined for open/refunded rows (neither has one). */
  settledAt: number | undefined;
}

export interface TradeHistoryQuery {
  data: TradeHistoryRow[] | undefined;
  isLoading: boolean;
  isError: boolean;
  errors: string[];
  /** Same meaning as usePositions.ts's flag: true only if the vault holds more than MAX_ENUMERATED_POSITIONS positions and older ones were left unread. */
  scanTruncated: boolean;
}

/**
 * Exported so PositionsPanel.tsx can type the same `getSettlement` read
 * result without redeclaring this shape — see `statusOf`'s doc comment for
 * why that hook and this one must share the one disambiguator rather than
 * drifting into two implementations.
 */
export interface SettlementInfo {
  finalized: boolean;
  price: bigint;
  publishTime: bigint;
}

interface OwnRow {
  positionId: bigint;
  seriesId: Hex;
  direction: number;
  strike: bigint;
  width: bigint;
  premium: bigint;
  maxPayout: bigint;
  settled: boolean;
  closed: boolean;
  closeBid: bigint;
}

/**
 * Resolves one row's status from the two factory reads below. `settled`
 * alone (the Position struct's own flag) does not distinguish a genuinely
 * settled position from a refunded one — `settlePoolPosition` and
 * `refundPoolPosition` both set it to `true` (contracts/TendPoolVault.sol).
 *
 * The disambiguator is `getSettlement(seriesId).finalized`:
 *   - settlePoolPosition requires `finalized === true`.
 *   - refundPoolPosition requires `isRefundable(seriesId)`, which itself
 *     requires `finalized === false`.
 *   - TendSeriesFactory.publishSettlement can never finalize a series once
 *     `isRefundable` has ever been true for it — both gate on the exact same
 *     `expiry + observationWindow + settlementGrace` deadline, on opposite
 *     sides (`block.timestamp <= deadline` to finalize, `> deadline` to
 *     refund). So once true, `finalized` stays true forever, and once a
 *     series has ever been refund-eligible, it can never be finalized.
 *
 * That makes `finalized` alone sufficient — but `isRefundable` is read and
 * required to agree anyway (redundant in the steady state, but a defensive
 * cross-check against a stale/contradictory read: a disagreement here
 * resolves to "still pending" rather than guessing a status).
 *
 * Exported — and taking only the one field it actually needs, rather than
 * the full `OwnRow` shape — so PositionsPanel.tsx's Positions table can call
 * this exact function instead of re-deriving status from the raw `settled`
 * flag. PositionsPanel used to do exactly that (badge showed "settled" for
 * every finalized row, refunded ones included), which is precisely the bug
 * this disambiguator exists to prevent: two independent implementations of
 * the same status logic drifting apart. Do not add a second copy.
 */
export function statusOf(
  row: { settled: boolean; closed: boolean },
  settlement: SettlementInfo | undefined,
  refundable: boolean | undefined,
): TradeStatus | undefined {
  if (!row.settled) return "open";
  // An early exit is terminal on its own: the position was bought back at a
  // signed bid and has no settlement or refund behind it, so it must never
  // wait on (or be described by) the series' settlement state.
  if (row.closed) return "closed";
  if (!settlement) return undefined;
  if (settlement.finalized) return "settled";
  if (refundable === undefined) return undefined;
  return refundable ? "refunded" : undefined;
}

/**
 * Trade history for the connected wallet: every position it has ever taken
 * in this vault, with realised P&L for settled/refunded rows.
 *
 * Reads positions exactly the way usePositions.ts does — by enumerating
 * `nextPositionId()` and batch-reading `positions(id)` — for the same
 * reason: Monad testnet's public RPC caps eth_getLogs to 100-block windows,
 * which bounds a log-based history to roughly the last 25 minutes (see
 * getLogsPaginated.ts). Enumeration has no such window, so this is complete
 * history, not a recent slice. Do not rewrite this to scan
 * PoolQuoteFilled/PositionSettled/PositionRefunded logs.
 *
 * Settlement and payout figures are never recomputed client-side:
 *   - factory.getSettlement(seriesId) supplies finalized / price / publishTime.
 *   - vault.calculatePayout(...) supplies the exact realised payout, by
 *     calling the contract's own `pure` function rather than reimplementing
 *     its math in TypeScript (which could drift from what the contract
 *     actually paid).
 */
export function useTradeHistory(vaultAddress: Address | undefined, factoryAddress: Address | undefined): TradeHistoryQuery {
  const { address: account } = useAccount();

  const nextIdQuery = useReadContract({
    address: vaultAddress,
    abi: tendPoolVaultAbi,
    chainId: monadTestnet.id,
    functionName: "nextPositionId",
    query: { enabled: Boolean(vaultAddress && account), staleTime: 15_000 },
  });

  // Ids run 1 .. nextPositionId - 1, newest first — same enumeration as
  // usePositions.ts, including the same truncation cap.
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

  // The connected wallet's own rows, in the same newest-first order as
  // positionIds. Everything below derives from this fixed list.
  const ownRows: OwnRow[] =
    nextPositionId !== undefined && account
      ? positionIds.flatMap((positionId, index) => {
          const entry = positionsRead.data?.[index];
          if (entry?.status !== "success") return [];
          const tuple = asPositionTuple(entry.result);
          if (!tuple) return [];
          const [buyer, seriesId, direction, strike, width, premium, maxPayout, , settled, closed, closeBid] = tuple;
          if (!isAddressEqual(buyer, account)) return [];
          return [{ positionId, seriesId, direction, strike, width, premium, maxPayout, settled, closed, closeBid }];
        })
      : [];

  const uniqueSeriesIds = Array.from(new Set(ownRows.map((row) => row.seriesId.toLowerCase()))) as Hex[];

  const settlementRead = useChainReads({
    contracts:
      factoryAddress && uniqueSeriesIds.length > 0
        ? uniqueSeriesIds.map(
            (id) =>
              ({
                address: factoryAddress,
                abi: tendSeriesFactoryAbi,
                chainId: monadTestnet.id,
                functionName: "getSettlement",
                args: [id],
              }) as const,
          )
        : [],
    allowFailure: true,
    query: { enabled: Boolean(factoryAddress && uniqueSeriesIds.length > 0) },
  });

  const refundableRead = useChainReads({
    contracts:
      factoryAddress && uniqueSeriesIds.length > 0
        ? uniqueSeriesIds.map(
            (id) =>
              ({
                address: factoryAddress,
                abi: tendSeriesFactoryAbi,
                chainId: monadTestnet.id,
                functionName: "isRefundable",
                args: [id],
              }) as const,
          )
        : [],
    allowFailure: true,
    query: { enabled: Boolean(factoryAddress && uniqueSeriesIds.length > 0) },
  });

  const settlementBySeriesId = new Map<string, SettlementInfo>();
  const refundableBySeriesId = new Map<string, boolean>();
  uniqueSeriesIds.forEach((id, index) => {
    const settlementEntry = settlementRead.data?.[index];
    if (settlementEntry?.status === "success") {
      settlementBySeriesId.set(id, settlementEntry.result as SettlementInfo);
    }
    const refundableEntry = refundableRead.data?.[index];
    if (refundableEntry?.status === "success") {
      refundableBySeriesId.set(id, refundableEntry.result);
    }
  });

  // Rows that resolved to "settled" need one more read each: the actual
  // realised payout, via the vault's own calculatePayout — never
  // reimplemented client-side.
  const rowsNeedingPayout = ownRows.flatMap((row) => {
    const settlement = settlementBySeriesId.get(row.seriesId.toLowerCase());
    const refundable = refundableBySeriesId.get(row.seriesId.toLowerCase());
    if (statusOf(row, settlement, refundable) !== "settled") return [];
    return [{ row, settlement: settlement as SettlementInfo }];
  });

  const payoutRead = useChainReads({
    contracts: rowsNeedingPayout.map(
      ({ row, settlement }) =>
        ({
          address: vaultAddress as Address,
          abi: tendPoolVaultAbi,
          chainId: monadTestnet.id,
          functionName: "calculatePayout",
          args: [row.direction, row.strike, row.width, settlement.price, row.maxPayout],
        }) as const,
    ),
    allowFailure: true,
    query: { enabled: Boolean(vaultAddress) && rowsNeedingPayout.length > 0 },
  });

  const payoutByPositionId = new Map<string, bigint>();
  rowsNeedingPayout.forEach(({ row }, index) => {
    const entry = payoutRead.data?.[index];
    if (entry?.status !== "success") return;
    payoutByPositionId.set(row.positionId.toString(), entry.result);
  });

  const data: TradeHistoryRow[] | undefined =
    nextPositionId !== undefined && account
      ? ownRows.map((row) => {
          const key = row.seriesId.toLowerCase();
          const settlement = settlementBySeriesId.get(key);
          const refundable = refundableBySeriesId.get(key);
          const status = statusOf(row, settlement, refundable);

          let payout: bigint | undefined;
          let settledAt: number | undefined;
          if (status === "settled") {
            payout = payoutByPositionId.get(row.positionId.toString());
            settledAt = Number((settlement as SettlementInfo).publishTime);
          } else if (status === "refunded") {
            payout = row.premium; // refundPoolPosition returns the premium in full
          } else if (status === "closed") {
            payout = row.closeBid; // what the pool actually paid to buy it back
          }
          const pnl = payout !== undefined ? payout - row.premium : undefined;

          return {
            positionId: row.positionId,
            seriesId: row.seriesId,
            direction: row.direction,
            strike: row.strike,
            width: row.width,
            premium: row.premium,
            maxPayout: row.maxPayout,
            status,
            payout,
            pnl,
            settledAt,
          };
        })
      : undefined;

  // toUserMessage, not String() — see usePositions.ts's identical comment.
  const errors: string[] = [];
  if (nextIdQuery.error) errors.push(toUserMessage(nextIdQuery.error));
  if (positionsRead.error) errors.push(toUserMessage(positionsRead.error));
  if (settlementRead.error) errors.push(toUserMessage(settlementRead.error));
  if (refundableRead.error) errors.push(toUserMessage(refundableRead.error));
  if (payoutRead.error) errors.push(toUserMessage(payoutRead.error));

  return {
    data,
    isLoading:
      nextIdQuery.isLoading ||
      (positionIds.length > 0 && positionsRead.isLoading) ||
      (uniqueSeriesIds.length > 0 && (settlementRead.isLoading || refundableRead.isLoading)) ||
      (rowsNeedingPayout.length > 0 && payoutRead.isLoading),
    isError: nextIdQuery.isError || positionsRead.isError || settlementRead.isError || refundableRead.isError || payoutRead.isError,
    errors,
    scanTruncated: truncated,
  };
}
