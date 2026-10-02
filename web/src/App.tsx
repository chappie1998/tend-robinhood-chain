import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { zeroHash, type Hex } from "viem";
import { CHAIN_LABEL, EXPLORER_URL } from "./chain";
import { EarnView } from "./components/EarnView";
import { GasBanner } from "./components/GasBanner";
import { Header, Logo, type AppView } from "./components/Header";
import { MarketCard, PricingNote } from "./components/MarketCard";
import { AssetStrip, MarketHeader, type MarketIdentity } from "./components/MarketHeader";
import { PortfolioView } from "./components/PortfolioView";
import { PositionsPanel } from "./components/PositionsPanel";
import { SeriesPanel } from "./components/SeriesPanel";
import { TicketColumn } from "./components/TicketColumn";
import { TradeHistoryPanel } from "./components/TradeHistoryPanel";
import { TradePositionsPanel } from "./components/TradePositionsPanel";
import type { ActiveStrike } from "./components/TradeTicket";
import { isMockSettlement, seededMarkets, type SeededMarket } from "./deployment";
import { useDeployment } from "./hooks/useDeployment";
import { useEarlyExitSupport } from "./hooks/useEarlyExitSupport";
import { useLiveSeries, type LiveSeriesCandidate, type LiveSeriesMarket } from "./hooks/useLiveSeries";
import { usePoolState } from "./hooks/usePoolState";
import type { SeriesSummary } from "./hooks/useSeriesList";
import { bytes32ToUtf8 } from "./lib/format";
import { TENORS, type TenorId } from "./lib/seriesParams";

/** The market currently driving the chart and the trade ticket. */
interface ActiveMarket {
  seriesId: Hex;
  feedId: Hex;
  symbolLabel: string;
  /** Which of the three canonical tenors this series is. Null when the
   * active series came from the Markets tab's series table (an arbitrary
   * series, not necessarily one of the seeder's own tenor/ladder rungs) —
   * the tenor selector then shows nothing as active rather than guessing. */
  tenorId: TenorId | null;
}

/** The first tenor (in TENORS' own shortest-to-longest order) that currently
 * has a fillable candidate for this market, or undefined if none do. */
function shortestFillableTenorId(tenors: Record<TenorId, LiveSeriesCandidate>): TenorId | undefined {
  return TENORS.find((tenor) => tenors[tenor.id]?.fillable)?.id;
}

export function App() {
  // Top-level destinations (Header's product nav): Trade, Portfolio, and
  // Write & earn (the liquidity pool). Owned here because it decides what renders.
  const [view, setView] = useState<AppView>("trade");

  const deployment = useDeployment();
  const vaultAddress = deployment.status === "ready" ? deployment.manifest.contracts.tendPoolVault : undefined;
  const factoryAddress = deployment.status === "ready" ? deployment.manifest.contracts.tendSeriesFactory : undefined;
  const tokenAddress = deployment.status === "ready" ? deployment.manifest.contracts.mockUSDC : undefined;
  // Gates every mint/faucet affordance below (PoolPanel's FaucetPanel row,
  // TradeTicket's "use the faucet" hint) — minting only makes sense against
  // the demo's own mock settlement token, never a real one. See
  // isMockSettlement's doc comment for why this defaults to true.
  const showFaucet = deployment.status === "ready" && isMockSettlement(deployment.manifest);

  // The manifest supplies each market's symbol + Pyth feed id and the market
  // list itself — those don't drift. It does NOT reliably supply which
  // seriesId is live right now, for which tenor: that's baked into the build
  // at deploy time, and the keeper reseeds series on-chain every couple of
  // hours, so a manifest seriesId goes stale the moment it does (see
  // hooks/useLiveSeries.ts). useLiveSeries re-derives, per market AND per
  // tenor, the currently fillable seriesId straight from the chain, falling
  // back to the manifest's own entry only when nothing on-chain currently
  // qualifies for that tenor.
  const manifestMarkets: SeededMarket[] = deployment.status === "ready" ? seededMarkets(deployment.manifest) : [];
  const liveSeries = useLiveSeries(factoryAddress, vaultAddress, tokenAddress, manifestMarkets);

  // Market identity only (symbol + feed id) for the market strip — a
  // market itself no longer has a single seriesId now that it has up to
  // three tenors. Empty until the manifest is ready — the selector and the
  // trading layout below simply don't render until then.
  const marketIdentities: MarketIdentity[] = liveSeries.markets.map((m) => ({ symbol: m.symbol, feedId: m.pythFeedId }));

  function findMarketData(feedId: Hex): LiveSeriesMarket | undefined {
    return liveSeries.markets.find((m) => m.pythFeedId.toLowerCase() === feedId.toLowerCase());
  }

  // Fetched once here so both the pool panel and the positions panel (which
  // needs the settlement asset's decimals to format premium/payout) can use
  // the same read instead of duplicating the multicall.
  const poolQuery = usePoolState(vaultAddress);
  // Whether this deployment's vault can buy positions back before expiry.
  const { supported: earlyExit } = useEarlyExitSupport(vaultAddress);

  // The market + tenor driving the chart + trade ticket. Settable three ways:
  // the market strip (keeps the current tenor), the ticket's expiry choices
  // (keeps the current market), or a row in the Series tab's table (an
  // arbitrary series, tenorId null) — all three funnel into this one piece of state.
  const [selection, setActiveMarket] = useState<ActiveMarket | null>(null);
  // The trader's own explicit tenor choice, sticky across market switches —
  // set only by clicking a tenor button, never by the auto-default below.
  // Null means "no explicit choice yet", i.e. keep auto-defaulting.
  const [preferredTenorId, setPreferredTenorId] = useState<TenorId | null>(null);

  // Market identity is user state; the active series is always derived from live chain reads.
  const selectedMarket = selection ? findMarketData(selection.feedId) : liveSeries.markets[0];
  const selectedTenor = preferredTenorId ?? (selectedMarket ? shortestFillableTenorId(selectedMarket.tenors) : undefined) ?? TENORS[0].id;
  const activeMarket: ActiveMarket | null = selection?.tenorId === null ? selection : selectedMarket ? {
    seriesId: selectedMarket.tenors[selectedTenor].seriesId,
    feedId: selectedMarket.pythFeedId,
    symbolLabel: selectedMarket.symbol,
    tenorId: selectedTenor,
  } : null;

  // The strike/breakeven of whatever quote is open in the trade ticket, lifted
  // to the one place both the ticket (below) and the price chart (above) can
  // see. Small and single-purpose — a global store would be a much larger
  // tool than this one wire needs.
  const [activeStrike, setActiveStrike] = useState<ActiveStrike | null>(null);
  // The chart plots the active market's feed. A ticket on some other series
  // (reached only via a mismatched race, not normal use) settles against a
  // different underlying, so its strike/breakeven are withheld rather than
  // drawn on candles they have nothing to do with.
  const feedMatches =
    activeStrike && activeMarket && activeStrike.feedId.toLowerCase() === activeMarket.feedId.toLowerCase();
  const chartStrike = feedMatches ? activeStrike.price : undefined;
  const chartBreakeven = feedMatches ? activeStrike.breakeven : undefined;

  function selectSeededMarket(market: MarketIdentity) {
    const marketData = findMarketData(market.feedId);
    if (!marketData) return;
    const tenorId = preferredTenorId ?? shortestFillableTenorId(marketData.tenors) ?? TENORS[0].id;
    setActiveMarket({
      seriesId: marketData.tenors[tenorId].seriesId,
      feedId: marketData.pythFeedId,
      symbolLabel: marketData.symbol,
      tenorId,
    });
  }

  function selectTenor(tenorId: TenorId) {
    setPreferredTenorId(tenorId);
    if (!activeMarket) return;
    const marketData = findMarketData(activeMarket.feedId);
    if (!marketData) return;
    setActiveMarket({
      seriesId: marketData.tenors[tenorId].seriesId,
      feedId: marketData.pythFeedId,
      symbolLabel: marketData.symbol,
      tenorId,
    });
  }

  function selectTableSeries(series: SeriesSummary) {
    setActiveMarket({
      seriesId: series.seriesId,
      feedId: series.pythFeedId,
      symbolLabel: bytes32ToUtf8(series.symbol),
      tenorId: null,
    });
  }

  const ready = deployment.status === "ready" && vaultAddress && factoryAddress && tokenAddress;
  const activeMarketTenors = activeMarket ? findMarketData(activeMarket.feedId)?.tenors : undefined;

  // Every currently-known series id across every configured market and
  // tenor — pinned rows in the Series tab's table, same as before
  // (previously one id per market; now up to one per market per tenor).
  // Placeholder (never-created) fallback ids are excluded — pinning a
  // zero-hash id would just show a dead row.
  const pinnedSeriesIds = liveSeries.markets.flatMap((m) =>
    TENORS.map((tenor) => m.tenors[tenor.id]?.seriesId).filter(
      (id): id is Hex => id !== undefined && id !== zeroHash,
    ),
  );

  // Markets with at least one tenor the chain confirms is fillable right now.
  const tradableCount = liveSeries.markets.filter((market) => TENORS.some((tenor) => market.tenors[tenor.id]?.fillable)).length;

  return (
    <div className="app-shell">
      <Header view={view} onNavigate={setView} />
      <GasBanner />

      {deployment.status === "loading" && (
        <div className="app-notice" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden="true" /> Checking {CHAIN_LABEL} deployment…
        </div>
      )}
      {deployment.status === "error" && (
        <div className="banner banner--error" role="alert">
          <strong>RPC error.</strong>
          <p>{deployment.message}</p>
        </div>
      )}
      {deployment.status === "not-deployed" && (
        <div className="banner" role="status">
          <strong>Contracts not deployed to {CHAIN_LABEL} yet.</strong>
          <p>
            {deployment.reason} Run <code>npm run deploy:monad</code> at the repo root, then reload this page.
          </p>
        </div>
      )}

      <div id="main" className="app-main">
        {ready && view === "portfolio" && (
          <PortfolioView vaultAddress={vaultAddress} factoryAddress={factoryAddress} tokenAddress={tokenAddress} poolQuery={poolQuery} />
        )}

        {ready && view === "earn" && (
          <EarnView vaultAddress={vaultAddress} tokenAddress={tokenAddress} poolQuery={poolQuery} showFaucet={showFaucet} />
        )}

        {ready && view === "trade" && (
          <main className="trade-layout">
            <section className="market-column">
              {activeMarket ? (
                <>
                  <MarketHeader symbol={activeMarket.symbolLabel} />
                  <AssetStrip
                    markets={marketIdentities}
                    selectedFeedId={activeMarket.feedId}
                    tradableCount={tradableCount}
                    onSelect={selectSeededMarket}
                  />
                  <MarketCard
                    key={activeMarket.feedId}
                    feedId={activeMarket.feedId}
                    symbol={activeMarket.symbolLabel}
                    pool={poolQuery.data}
                    strikePrice={chartStrike}
                    breakevenPrice={chartBreakeven}
                  />
                  <PricingNote earlyExit={earlyExit} />
                </>
              ) : (
                <div className="market-card market-card--loading">
                  <div className="loading-title">
                    <LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading markets…
                  </div>
                </div>
              )}
            </section>

            <TicketColumn
              factoryAddress={factoryAddress}
              vaultAddress={vaultAddress}
              tokenAddress={tokenAddress}
              seriesId={activeMarket?.seriesId}
              symbolLabel={activeMarket?.symbolLabel}
              assetDecimals={poolQuery.data?.assetDecimals}
              onStrikeChange={setActiveStrike}
              showFaucet={showFaucet}
              tenors={activeMarketTenors}
              selectedTenorId={activeMarket?.tenorId ?? null}
              onSelectTenor={selectTenor}
            />

            <TradePositionsPanel
              positions={<PositionsPanel vaultAddress={vaultAddress} factoryAddress={factoryAddress} assetDecimals={poolQuery.data?.assetDecimals} />}
              history={<TradeHistoryPanel vaultAddress={vaultAddress} factoryAddress={factoryAddress} assetDecimals={poolQuery.data?.assetDecimals} />}
              series={
                <SeriesPanel
                  factoryAddress={factoryAddress}
                  vaultAddress={vaultAddress}
                  pinnedSeriesIds={pinnedSeriesIds}
                  selectedSeriesId={activeMarket?.seriesId}
                  onSelectSeries={selectTableSeries}
                />
              }
            />
          </main>
        )}
      </div>

      <footer>
        <div>
          <Logo />
          <span>Defined-risk options on {CHAIN_LABEL}.</span>
        </div>
        <div>
          <a href="#risk">Risk</a>
          <a href="/demo.html">Demo</a>
          <a href="/third-party-notices.html">Notices</a>
          {vaultAddress && (
            <a href={`${EXPLORER_URL}/address/${vaultAddress}`} target="_blank" rel="noreferrer">
              Vault contract
            </a>
          )}
          <span>© 2026 Tend Labs</span>
        </div>
      </footer>
    </div>
  );
}
