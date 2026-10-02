import type { Address } from "viem";
import { useAccount } from "wagmi";
import { EXPLORER_URL } from "../chain";
import { useSeriesFeeds } from "../hooks/useSeriesFeeds";
import { useTradeHistory, type TradeHistoryRow, type TradeStatus } from "../hooks/useTradeHistory";
import { bytes32ToUtf8, formatSignedTokenAmount, formatTimestamp, formatTokenAmount, shortenAddress } from "../lib/format";
import { getFillTxHash } from "../lib/tradeHistoryStorage";

const DIRECTION_LABEL = ["Up", "Down"];

/** "…" while a row's settlement/refundability is still resolving; "—" when a row genuinely has no honest timestamp (open, or refunded — refundPoolPosition never finalizes a settlement). Never Date.now(): Position carries no fill time of its own. */
function timeCell(row: TradeHistoryRow): string {
  if (row.status === undefined) return "…";
  if (row.status === "settled" && row.settledAt !== undefined) return formatTimestamp(row.settledAt);
  return "—";
}

/** "—" for an open row (not yet a real outcome — the Positions tab already shows live mark-to-market for those); "…" while a settled, refunded or closed row's payout is still resolving; the formatted amount otherwise. */
function payoutCell(row: TradeHistoryRow, assetDecimals: number): string {
  if (row.status === "open") return "—";
  if (row.payout === undefined) return "…";
  return formatTokenAmount(row.payout, assetDecimals);
}

/** Same shape as payoutCell, plus the positive/negative colour class used everywhere else in this app (styles.css .is-positive/.is-negative) — never applied to a refunded row's exact-0 P&L, which is neutral, not a loss. */
function pnlCell(row: TradeHistoryRow, assetDecimals: number): { text: string; className: string } {
  if (row.status === "open") return { text: "—", className: "" };
  if (row.pnl === undefined) return { text: "…", className: "" };
  const className = row.pnl > 0n ? "is-positive" : row.pnl < 0n ? "is-negative" : "";
  return { text: formatSignedTokenAmount(row.pnl, assetDecimals), className };
}

/**
 * Exported so PositionsPanel.tsx's Positions table renders the exact same
 * three badges (and the exact same "…" while resolving, never a guessed
 * "settled") for the exact same `TradeStatus` — see useTradeHistory.ts's
 * `statusOf` doc comment for why these two tables sharing one status source
 * matters: they used to disagree on the same position.
 */
export function StatusBadge({ status }: { status: TradeStatus | undefined }) {
  if (status === undefined) return <span className="hint">…</span>;
  if (status === "open") return <span className="badge badge--ok">open</span>;
  if (status === "settled") return <span className="badge badge--off">settled</span>;
  if (status === "closed") return <span className="badge badge--off">closed</span>;
  return <span className="badge badge--off">refunded</span>;
}

/**
 * Links a row to its own fill transaction when this browser recorded one
 * (TradeTicket.tsx, at the moment the fill confirmed — see
 * lib/tradeHistoryStorage.ts). `Position` itself carries no tx hash, and a
 * log scan can't recover one after the fact on Monad testnet (bounded to
 * ~25 minutes of lookback — getLogsPaginated.ts), so a row filled before
 * this shipped, or from a different browser, genuinely has none. That case
 * links to the vault contract instead of fabricating a hash or leaving a
 * dead link, and says so plainly in the link text and title.
 */
function TxCell({ positionId, vaultAddress }: { positionId: bigint; vaultAddress: Address }) {
  const hash = getFillTxHash(positionId);
  if (hash) {
    return (
      <a
        className="link"
        href={`${EXPLORER_URL}/tx/${hash}`}
        target="_blank"
        rel="noreferrer"
        title={hash}
      >
        {shortenAddress(hash)}
      </a>
    );
  }
  return (
    <a
      className="link"
      href={`${EXPLORER_URL}/address/${vaultAddress}`}
      target="_blank"
      rel="noreferrer"
      title="No tx hash recorded for this fill in this browser (it predates this feature, or was filled elsewhere) — this links to the vault contract instead."
    >
      vault (hash unknown)
    </a>
  );
}

/**
 * The "Activity" dock tab: the connected wallet's real trade history in this
 * vault — every position it has ever taken, with realised P&L and a link to
 * the fill transaction where one is known. Replaces what used to render here
 * (the series catalogue, a market picker — moved to the "Markets" tab, see
 * App.tsx / BottomDock.tsx).
 *
 * Data comes from useTradeHistory, which enumerates `positions(id)` directly
 * rather than scanning event logs — see that hook's doc comment for why a
 * log-based history would silently show only the last ~25 minutes on Monad
 * testnet.
 */
export function TradeHistoryPanel({
  vaultAddress,
  factoryAddress,
  assetDecimals = 6,
}: {
  vaultAddress: Address;
  factoryAddress: Address;
  /** Settlement asset decimals; mUSDC (6) if unknown. */
  assetDecimals?: number;
}) {
  const { isConnected } = useAccount();
  const { data, isLoading, isError, errors, scanTruncated } = useTradeHistory(vaultAddress, factoryAddress);

  // Series symbol for every row — open, settled and refunded alike — via a
  // direct getSeries read per unique series id, not the Markets tab's
  // bounded SeriesCreated log scan, so a row's series always resolves no
  // matter how long ago it was created or traded.
  const seriesIds = data?.map((row) => row.seriesId) ?? [];
  const seriesFeeds = useSeriesFeeds(factoryAddress, seriesIds);

  return (
    <div className="dock-panel">
      {!isConnected && <p className="hint dock-empty">Connect a wallet to view your trade history.</p>}

      {isConnected && isLoading && <p className="hint dock-empty">Loading trade history (enumerating the vault&apos;s position ids)…</p>}

      {isConnected && isError && (
        <p className="error-text dock-empty">RPC error reading trade history: {errors[0] ?? "unknown error"}</p>
      )}

      {isConnected && !isLoading && !isError && data && data.length === 0 && (
        <p className="hint dock-empty">This wallet has no trade history in this vault yet.</p>
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
                <th>Time</th>
                <th>Series</th>
                <th>Direction</th>
                <th className="num">Premium</th>
                <th className="num">Payout</th>
                <th className="num">P&L</th>
                <th>Status</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const feed = seriesFeeds.data[row.seriesId.toLowerCase()];
                const pnl = pnlCell(row, assetDecimals);
                return (
                  <tr key={row.positionId.toString()}>
                    <td>{timeCell(row)}</td>
                    <td>{feed ? bytes32ToUtf8(feed.symbol) : "…"}</td>
                    <td>{DIRECTION_LABEL[row.direction] ?? row.direction}</td>
                    <td className="num">{formatTokenAmount(row.premium, assetDecimals)}</td>
                    <td className="num">{payoutCell(row, assetDecimals)}</td>
                    <td className={`num ${pnl.className}`}>{pnl.text}</td>
                    <td>
                      <StatusBadge status={row.status} />
                    </td>
                    <td>
                      <TxCell positionId={row.positionId} vaultAddress={vaultAddress} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
