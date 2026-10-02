import { Target } from "lucide-react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import type { PoolStateQuery } from "../hooks/usePoolState";
import { usePositions } from "../hooks/usePositions";
import { useTradeHistory } from "../hooks/useTradeHistory";
import { useWalletBalances } from "../hooks/useWalletBalances";
import { formatSignedTokenAmount, formatTokenAmount } from "../lib/format";
import { PositionsPanel } from "./PositionsPanel";
import { TradeHistoryPanel } from "./TradeHistoryPanel";

const MON_DECIMALS = 18;

/**
 * The connected wallet's aggregated account picture — a top-level "Portfolio"
 * view alongside "Trade" (see Header.tsx's nav), not another dock tab.
 * Deliberately reuses the exact same hooks and panels the Trade view already
 * mounts (usePositions, useTradeHistory, usePoolState via the `poolQuery`
 * prop, PositionsPanel, TradeHistoryPanel) rather than re-fetching or
 * re-rendering its own copies of any of that — this view only adds the one
 * thing that doesn't exist yet: an aggregated summary row, plus the wallet's
 * two balances (useWalletBalances, mirroring FaucetPanel/useGasPreflight's
 * own reads).
 *
 * Honesty constraints (positions are held to expiry unless sold back to the
 * pool; testnet settlement is Tend's admin-posted oracle):
 * early exits require a supported vault and a fresh executable bid.
 * A refunded position's P&L is exactly 0 (the premium
 * came back in full), never shown as a loss. An open position's realised
 * P&L is unknown by definition — the summary only sums SETTLED rows, and if
 * any settled row's own payout is still resolving the whole aggregate shows
 * "…" rather than a partial, understated sum.
 */
export function PortfolioView({
  vaultAddress,
  factoryAddress,
  tokenAddress,
  poolQuery,
}: {
  vaultAddress: Address;
  factoryAddress: Address;
  tokenAddress: Address;
  poolQuery: PoolStateQuery;
}) {
  const { isConnected } = useAccount();
  const assetSymbol = poolQuery.data?.assetSymbol ?? "mUSDC";
  const assetDecimals = poolQuery.data?.assetDecimals ?? 6;

  const balances = useWalletBalances(tokenAddress);
  const positionsQuery = usePositions(vaultAddress);
  const tradeHistoryQuery = useTradeHistory(vaultAddress, factoryAddress);

  const openPositions = positionsQuery.data?.filter((position) => !position.settled) ?? [];
  const lockedCollateralRaw = openPositions.reduce((sum, position) => sum + position.maxPayout, 0n);

  // Realised means the outcome is final and known: settlement, or an early
  // exit at a signed bid. An open position's outcome is unknown by definition.
  const settledRows = tradeHistoryQuery.data?.filter((row) => row.status === "settled" || row.status === "closed") ?? [];
  const settledPnlResolved = settledRows.every((row) => row.pnl !== undefined);
  const realizedPnlRaw = settledRows.reduce((sum, row) => sum + (row.pnl ?? 0n), 0n);

  const positionsState: "loading" | "error" | "ready" = positionsQuery.isError
    ? "error"
    : positionsQuery.data
      ? "ready"
      : "loading";
  const tradeHistoryState: "loading" | "error" | "ready" = tradeHistoryQuery.isError
    ? "error"
    : tradeHistoryQuery.data
      ? "ready"
      : "loading";
  const realizedReady = tradeHistoryState === "ready" && settledPnlResolved;

  return (
    <main className="dashboard-view">
      <div className="view-heading">
        <div>
          <h1>Portfolio</h1>
          <p>
            Balances, open positions and completed trades for the connected wallet. Available exit actions appear
            alongside each position.
          </p>
        </div>
      </div>

      {!isConnected ? (
        <section className="positions-card">
          <div className="empty-position">
            <Target size={20} aria-hidden="true" />
            <div>
              <strong>Connect a wallet</strong>
              <p>Your balances, positions and trade history appear here once a wallet is connected.</p>
            </div>
          </div>
        </section>
      ) : (
        <>
          <div className="metric-grid">
            <Metric
              label={`${assetSymbol} balance`}
              value={balances.musdcRaw !== undefined ? formatTokenAmount(balances.musdcRaw, assetDecimals) : undefined}
            />
            <Metric
              label="MON balance"
              value={balances.monRaw !== undefined ? formatTokenAmount(balances.monRaw, MON_DECIMALS) : undefined}
              note="Pays gas on Monad testnet"
            />
            <Metric
              label="Open positions"
              value={positionsState === "ready" ? String(openPositions.length) : positionsState === "error" ? "—" : undefined}
            />
            {/* What the pool has escrowed to pay THIS wallet at most across its
                open positions — not the trader's own locked money (that is the
                premium, already paid). */}
            <Metric
              label="Max payout escrowed"
              value={positionsState === "ready" ? `${formatTokenAmount(lockedCollateralRaw, assetDecimals)} ${assetSymbol}` : positionsState === "error" ? "—" : undefined}
              note="Held by the pool for your open positions"
            />
            <Metric
              label="Realised P&L"
              value={realizedReady ? formatSignedTokenAmount(realizedPnlRaw, assetDecimals) : tradeHistoryState === "error" ? "—" : undefined}
              valueClassName={realizedReady ? (realizedPnlRaw > 0n ? "positive" : realizedPnlRaw < 0n ? "negative" : undefined) : undefined}
              note="Settled and closed positions"
            />
          </div>

          {(positionsState === "error" || tradeHistoryState === "error") && (
            <p className="execution-error">
              {positionsState === "error" && `RPC error reading positions: ${positionsQuery.errors[0] ?? "unknown error"}. `}
              {tradeHistoryState === "error" && `RPC error reading trade history: ${tradeHistoryQuery.errors[0] ?? "unknown error"}.`}
            </p>
          )}

          <section className="positions-card">
            <div className="section-head">
              <div>
                <h2>Positions</h2>
                <p>Open, closed, settled and refunded positions. Estimated value is indicative; an exit needs a signed bid.</p>
              </div>
            </div>
            <PositionsPanel vaultAddress={vaultAddress} factoryAddress={factoryAddress} assetDecimals={assetDecimals} />
          </section>

          <section className="positions-card">
            <div className="section-head">
              <div>
                <h2>Trade history</h2>
                <p>Every position this wallet has taken in the vault, with realised P&amp;L.</p>
              </div>
            </div>
            <TradeHistoryPanel vaultAddress={vaultAddress} factoryAddress={factoryAddress} assetDecimals={assetDecimals} />
          </section>

          <p className="risk-note">
            A refunded position&apos;s P&amp;L is exactly 0. Realised P&amp;L includes settled and closed positions;
            an open position&apos;s outcome is not yet final.
          </p>
        </>
      )}
    </main>
  );
}

function Metric({ label, value, note, valueClassName }: { label: string; value: string | undefined; note?: string; valueClassName?: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong className={value === undefined ? "pending" : valueClassName}>{value ?? "…"}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
