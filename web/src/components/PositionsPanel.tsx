import type { Address, Hex } from "viem";
import { useAccount,  } from "wagmi";
import { useChainReads } from "../hooks/useChainReads";
import { tendPoolVaultAbi, tendSeriesFactoryAbi } from "../abis";
import { monadTestnet } from "../chain";
import { usePythSpotBatch } from "../hooks/usePythPrice";
import { usePositions } from "../hooks/usePositions";
import { useSeriesFeeds } from "../hooks/useSeriesFeeds";
import { useMarkToMarket, type MarkInput } from "../hooks/useMarkToMarket";
import { useNowSeconds } from "../hooks/useNowSeconds";
import { statusOf, type SettlementInfo } from "../hooks/useTradeHistory";
import { PRICE_SCALE } from "../lib/payoff";
import { formatExactStrike, formatSignedNumber, formatSignedTokenAmount, formatTokenAmount } from "../lib/format";
import { CopyableValue } from "./CopyableValue";
import { PositionActionCell } from "./PositionActionCell";
import { StatusBadge } from "./TradeHistoryPanel";

const DIRECTION_LABEL = ["Up", "Down"];

export function PositionsPanel({
  vaultAddress,
  factoryAddress,
  assetDecimals = 6,
}: {
  vaultAddress: Address;
  factoryAddress: Address;
  /** Settlement asset decimals, read once by the pool panel; mUSDC (6) if unknown. */
  assetDecimals?: number;
}) {
  const { isConnected } = useAccount();
  const nowSeconds = useNowSeconds(10_000);
  const { data, isLoading, isError, errors, scanTruncated } = usePositions(vaultAddress);

  // Three-way status (open / settled / refunded) for every row, via the
  // exact same disambiguator useTradeHistory.ts's Activity tab uses —
  // `statusOf`, reading the raw `settled` flag together with
  // `getSettlement(seriesId).finalized` and `isRefundable(seriesId)`. The
  // raw `settled` flag alone can't tell settled and refunded apart (see
  // `statusOf`'s doc comment), which is exactly why this table used to show
  // "settled" for a row Trade history correctly showed as "refunded". Reads
  // are scoped to every position's series, not just open ones, because a
  // settled/refunded row's own status still depends on this lookup.
  const statusSeriesIds = Array.from(new Set((data ?? []).map((p) => p.seriesId.toLowerCase()))) as Hex[];

  const settlementRead = useChainReads({
    contracts:
      factoryAddress && statusSeriesIds.length > 0
        ? statusSeriesIds.map(
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
    query: { enabled: Boolean(factoryAddress && statusSeriesIds.length > 0) },
  });

  const refundableRead = useChainReads({
    contracts:
      factoryAddress && statusSeriesIds.length > 0
        ? statusSeriesIds.map(
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
    query: { enabled: Boolean(factoryAddress && statusSeriesIds.length > 0) },
  });

  const settlementBySeriesId = new Map<string, SettlementInfo>();
  const refundableBySeriesId = new Map<string, boolean>();
  statusSeriesIds.forEach((id, index) => {
    const settlementEntry = settlementRead.data?.[index];
    if (settlementEntry?.status === "success") {
      settlementBySeriesId.set(id, settlementEntry.result as SettlementInfo);
    }
    const refundableEntry = refundableRead.data?.[index];
    if (refundableEntry?.status === "success") {
      refundableBySeriesId.set(id, refundableEntry.result);
    }
  });

  // Live P&L is only meaningful for still-open positions — a settled one
  // already has a final, on-chain payout (shown by PositionActionCell once
  // settled). Only open rows need a feed/spot lookup at all.
  const openPositions = data?.filter((p) => !p.settled) ?? [];
  const seriesFeeds = useSeriesFeeds(
    factoryAddress,
    openPositions.map((p) => p.seriesId),
  );
  const feedIds = Object.values(seriesFeeds.data).map((f) => f.pythFeedId);
  const spotBatch = usePythSpotBatch(feedIds);

  // Positions whose feed AND a live spot both resolved — everything else
  // simply has no estimate this render, rather than a stale or guessed one.
  const positionsWithSpot = openPositions.flatMap((position) => {
    const feed = seriesFeeds.data[position.seriesId.toLowerCase()];
    // A later live spot cannot be used as a hypothetical settlement once the
    // observation window has ended. Wait for the finalized expiry reference.
    if (!feed || feed.expiry <= nowSeconds) return [];
    const spot = spotBatch.data[feed.pythFeedId.toLowerCase()];
    if (!spot || !Number.isFinite(spot.price) || spot.price <= 0) return [];
    const settlementPriceRaw = BigInt(Math.round(spot.price * PRICE_SCALE));
    return [{ position, settlementPriceRaw }];
  });

  // The vault's own `calculatePayout` — a pure function — asked "what would
  // this position pay out if settlement happened right now, at live spot?".
  // Calling the actual contract function (rather than reimplementing its
  // math client-side) guarantees the estimate can never drift from what the
  // contract would really produce.
  const payoutRead = useChainReads({
    contracts: positionsWithSpot.map(
      ({ position, settlementPriceRaw }) =>
        ({
          address: vaultAddress,
          abi: tendPoolVaultAbi,
          chainId: monadTestnet.id,
          functionName: "calculatePayout",
          args: [position.direction, position.strike, position.width, settlementPriceRaw, position.maxPayout],
        }) as const,
    ),
    allowFailure: true,
    query: { enabled: positionsWithSpot.length > 0 },
  });

  const pnlByPositionId = new Map<string, bigint>();
  // Live spot per position, kept so the table can say HOW FAR a position is
  // from paying out. Without it the payoff-now number reads as a flat total
  // loss with no indication that the strike is 2% away and hours remain.
  const spotByPositionId = new Map<string, bigint>();
  positionsWithSpot.forEach(({ position, settlementPriceRaw }, index) => {
    spotByPositionId.set(position.positionId.toString(), settlementPriceRaw);
    const entry = payoutRead.data?.[index];
    if (entry?.status !== "success") return;
    pnlByPositionId.set(position.positionId.toString(), entry.result - position.premium);
  });

  // Mark-to-market inputs: the same positions that resolved a live spot, plus
  // the series expiry (time left is what the payoff-now number ignores).
  const markInputs: MarkInput[] = positionsWithSpot.flatMap(({ position, settlementPriceRaw }) => {
    const feed = seriesFeeds.data[position.seriesId.toLowerCase()];
    if (!feed?.expiry) return [];
    return [{
      positionId: position.positionId.toString(),
      feedId: feed.pythFeedId,
      direction: position.direction === 0 ? "up" : "down",
      strike: position.strike.toString(),
      width: position.width.toString(),
      premium: position.premium.toString(),
      maxPayout: position.maxPayout.toString(),
      expiry: feed.expiry,
      spot: Number(settlementPriceRaw) / PRICE_SCALE,
    }];
  });
  const { marks } = useMarkToMarket(markInputs);

  /**
   * How far spot must move, in percent, for `position` to start paying at
   * all — i.e. to reach its strike. Negative means it is already past the
   * strike and would win. New width=1 positions are strict binary tickets;
   * historical wider positions remain capped spreads.
   */
  function moveToStrikePct(position: { direction: number; strike: bigint; positionId: bigint }): number | undefined {
    const spot = spotByPositionId.get(position.positionId.toString());
    if (spot === undefined || spot <= 0n) return undefined;
    const spotNum = Number(spot);
    const strikeNum = Number(position.strike);
    // Direction 0 = Up (needs spot ABOVE strike), 1 = Down (needs spot BELOW).
    return position.direction === 0
      ? ((strikeNum - spotNum) / spotNum) * 100
      : ((spotNum - strikeNum) / spotNum) * 100;
  }

  return (
    <div className="dock-panel">
      {!isConnected && <p className="hint dock-empty">Connect a wallet to view your positions.</p>}

      {isConnected && isLoading && <p className="hint dock-empty">Loading positions (enumerating on-chain position IDs)…</p>}

      {isConnected && isError && (
        <p className="error-text dock-empty">RPC error reading positions: {errors[0] ?? "unknown error"}</p>
      )}

      {isConnected && !isLoading && !isError && data && data.length === 0 && (
        <p className="hint dock-empty">This wallet has no positions in this vault — no open ones, and none it has already settled.</p>
      )}

      {isConnected && scanTruncated && (
        <p className="hint">
          Note: this vault holds more positions than one batch reads at a time, so only the most recent ones are listed
          here.
        </p>
      )}

      {isConnected && data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="num">ID</th>
                <th>Series</th>
                <th>Direction</th>
                <th className="num">Strike</th>
                <th className="num">Premium</th>
                <th className="num">Max payout</th>
                <th
                  className="num"
                  title="Present value minus premium. New width=1 positions use binary win probability; historical wider positions use remaining spread value."
                >
                  Worth now
                </th>
                <th
                  className="num"
                  title="What this position would pay if expiry happened right now, minus the premium. NOT a valuation: it ignores the time left, so a position that is merely out of the money shows the full premium as a loss."
                >
                  If it expired now
                </th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.map((position) => {
                const pnl = pnlByPositionId.get(position.positionId.toString());
                const needsPct = position.settled ? undefined : moveToStrikePct(position);
                const mark = marks.get(position.positionId.toString());
                const markClass = mark?.pnl == null ? "" : mark.pnl > 0 ? "is-positive" : mark.pnl < 0 ? "is-negative" : "";
                const pnlClass = pnl === undefined ? "" : pnl > 0n ? "is-positive" : pnl < 0n ? "is-negative" : "";
                const key = position.seriesId.toLowerCase();
                const status = statusOf(position, settlementBySeriesId.get(key), refundableBySeriesId.get(key));
                return (
                  <tr key={position.positionId.toString()}>
                    <td className="num">{position.positionId.toString()}</td>
                    <td>
                      <CopyableValue value={position.seriesId} />
                    </td>
                    <td>{DIRECTION_LABEL[position.direction] ?? position.direction}</td>
                    <td className="num">{formatExactStrike(position.strike)}</td>
                    <td className="num">{formatTokenAmount(position.premium, assetDecimals)}</td>
                    <td className="num">{formatTokenAmount(position.maxPayout, assetDecimals)}</td>
                    <td className={`num ${markClass}`} title="Present value minus premium, including time to expiry.">
                      {position.settled ? "—" : mark?.pnl != null ? formatSignedNumber(mark.pnl) : "…"}
                    </td>
                    <td className={`num ${pnlClass}`} title="What this would pay if expiry happened right now, minus premium — not a valuation.">
                      {position.settled ? "—" : pnl !== undefined ? formatSignedTokenAmount(pnl, assetDecimals) : "…"}
                      {!position.settled && needsPct !== undefined && needsPct > 0 && (
                        <div className="hint hint--tight">needs {needsPct.toFixed(2)}%</div>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={status} />
                    </td>
                    <td>
                      {position.settled ? (
                        <span className="hint">—</span>
                      ) : (
                        <PositionActionCell
                          positionId={position.positionId}
                          seriesId={position.seriesId}
                          vaultAddress={vaultAddress}
                          factoryAddress={factoryAddress}
                          assetDecimals={assetDecimals}
                          expiry={seriesFeeds.data[position.seriesId.toLowerCase()]?.expiry}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {isConnected && openPositions.length > 0 && (
        <p className="hint">
          Estimated value uses the pricing model and Coinbase market data. It is indicative, not an executable
          sell quote. Early exits, where available, require a separate signed bid before expiry. Testnet settlement
          uses Tend's admin-posted oracle. Maximum loss is the premium paid.
        </p>
      )}
    </div>
  );
}
