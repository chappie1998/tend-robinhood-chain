import { RefreshCw, Target } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useConnect } from "wagmi";

type PanelTab = "positions" | "history" | "series";

const TABS: readonly { id: PanelTab; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "history", label: "Fill history" },
  { id: "series", label: "Series" },
];

/**
 * The tabbed strip under the chart and ticket, as on the Solana terminal, so a
 * trader never leaves Trade to see a fill they just made. The tables themselves
 * are the existing panels, passed in by App; this owns only the tabs, the
 * refresh control and the wallet prompt.
 */
export function TradePositionsPanel({
  positions,
  history,
  series,
}: {
  positions: ReactNode;
  history: ReactNode;
  series: ReactNode;
}) {
  const { isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<PanelTab>("positions");

  const content = tab === "positions" ? positions : tab === "history" ? history : series;
  const needsWallet = !isConnected && tab !== "series";

  function handleConnect() {
    const connector = connectors.find((c) => c.id === "injected") ?? connectors[0];
    if (connector) connect({ connector });
  }

  return (
    <section className="positions-card trade-positions-panel">
      <div className="section-head">
        <div className="tab-strip" role="tablist" aria-label="Positions, fill history and series">
          {TABS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={tab === option.id}
              className={tab === option.id ? "tab-btn active" : "tab-btn"}
              onClick={() => setTab(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="trade-positions-meta">
          <button type="button" className="text-button" aria-label="Refresh on-chain data" title="Refresh on-chain data" onClick={() => void queryClient.invalidateQueries()}>
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div role="tabpanel">
        {needsWallet ? (
          <div className="empty-position">
            <Target size={20} aria-hidden="true" />
            <div>
              <strong>Connect a wallet</strong>
              <p>Positions and fill history belong to a wallet. Connect one to see them here.</p>
            </div>
            <button type="button" className="button secondary" onClick={handleConnect} disabled={isPending}>
              {isPending ? "Connecting…" : "Connect wallet"}
            </button>
          </div>
        ) : (
          content
        )}
      </div>
    </section>
  );
}
