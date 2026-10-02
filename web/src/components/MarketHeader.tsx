import { CHAIN_LABEL } from "../chain";
import type { Hex } from "viem";
import { useNowSeconds } from "../hooks/useNowSeconds";
import { usePythSpot } from "../hooks/usePythPrice";
import { formatUsdPrice } from "../lib/format";
import { spotMode } from "../lib/spotMode";

/** Market identity only — symbol + feed id. A market has up to three live series (one per tenor), so no seriesId here. */
export interface MarketIdentity {
  symbol: string;
  feedId: Hex;
}

const ASSET_BLURBS: Record<string, string> = {
  BTC: `Bitcoin, priced against the Coinbase BTC-USD reference and settled through Tend's oracle on ${CHAIN_LABEL}.`,
  ETH: `Ether, priced against the Coinbase ETH-USD reference and settled through Tend's oracle on ${CHAIN_LABEL}.`,
  MON: "Monad's native token — the chain this runs on — priced against the Coinbase MON-USD reference and settled through Tend's oracle.",
};

function assetBlurb(symbol: string): string {
  return ASSET_BLURBS[symbol] ?? `${symbol}, priced against a Coinbase reference and settled through Tend's oracle on ${CHAIN_LABEL}.`;
}

export function MiniLogo({ ticker }: { ticker: string }) {
  return (
    <span className="asset-logo" aria-hidden="true">
      {ticker.slice(0, 1)}
    </span>
  );
}

/** The instrument header: what is being traded and what settles it, before any number is read. */
export function MarketHeader({ symbol }: { symbol: string }) {
  return (
    <div className="market-header">
      <div className="asset-heading">
        <MiniLogo ticker={symbol} />
        <div>
          <div className="asset-name">
            <h2>{symbol}</h2>
            <span>Crypto</span>
          </div>
          <p>{assetBlurb(symbol)}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The market strip: one chip per configured market with its live Coinbase
 * price. The count says how many have at least one open series right now, so
 * an empty ticket is explained before anyone reaches it.
 */
export function AssetStrip({
  markets,
  selectedFeedId,
  tradableCount,
  onSelect,
}: {
  markets: MarketIdentity[];
  selectedFeedId: Hex;
  tradableCount: number;
  onSelect: (market: MarketIdentity) => void;
}) {
  if (markets.length === 0) return null;
  return (
    <div className="asset-strip" role="group" aria-label="Available markets">
      <section className="asset-group" aria-label="Crypto">
        <h3 className="asset-group-head">
          Crypto<span>{tradableCount > 0 ? `${tradableCount} tradable` : "No open series"}</span>
        </h3>
        <div className="asset-group-row">
          {markets.map((market) => (
            <AssetChip
              key={market.feedId}
              market={market}
              active={market.feedId.toLowerCase() === selectedFeedId.toLowerCase()}
              onSelect={onSelect}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function AssetChip({
  market,
  active,
  onSelect,
}: {
  market: MarketIdentity;
  active: boolean;
  onSelect: (market: MarketIdentity) => void;
}) {
  const spot = usePythSpot(market.feedId);
  const nowSec = useNowSeconds(1000);
  const mode = spotMode(spot.data?.publishTime, nowSec);

  return (
    <button type="button" className={active ? "asset-chip active" : "asset-chip"} aria-pressed={active} onClick={() => onSelect(market)}>
      <MiniLogo ticker={market.symbol} />
      <span>
        <strong>{market.symbol}</strong>
        <small>{spot.data ? `$${formatUsdPrice(spot.data.price)}` : spot.isError ? "Price unavailable" : "Coinbase pending"}</small>
      </span>
      {active && <em className={mode === "live" ? "positive" : mode === "stale" ? "negative" : ""}>{mode === "loading" ? "—" : mode}</em>}
    </button>
  );
}
