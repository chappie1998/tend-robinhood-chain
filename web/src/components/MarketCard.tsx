import { ArrowUpRight, BookOpen } from "lucide-react";
import { useState } from "react";
import type { Hex } from "viem";
import { useNowSeconds } from "../hooks/useNowSeconds";
import type { PoolState } from "../hooks/usePoolState";
import { usePythHistory, usePythSpot } from "../hooks/usePythPrice";
import { compute24hChange, formatAgo, formatSignedPercent, formatTokenAmount, formatUsdPrice } from "../lib/format";
import { poolCapacity } from "../lib/poolCapacity";
import { spotMode } from "../lib/spotMode";
import { PriceChart } from "./PriceChart";

/**
 * The market panel: reference price row with the stats that matter to this
 * product, the chart, and a footer that states what the chart is and is not.
 * Every value is data the app already reads; a stat without a source shows a
 * dash rather than a zero.
 */
export function MarketCard({
  feedId,
  symbol,
  pool,
  strikePrice,
  breakevenPrice,
}: {
  feedId: Hex;
  symbol: string;
  pool: PoolState | undefined;
  strikePrice?: number;
  breakevenPrice?: number;
}) {
  const spot = usePythSpot(feedId);
  const history = usePythHistory(feedId);
  const nowSec = useNowSeconds(1000);
  const mode = spotMode(spot.data?.publishTime, nowSec);

  const change = compute24hChange(spot.data?.price, history.data?.firstClose);
  // Hourly closes, widened to include the live mark: a range that visibly
  // excludes the current price reads as broken.
  const closes = history.data?.points ?? [];
  const rangePoints = spot.data ? [...closes, spot.data.price] : closes;
  const range = closes.length > 0 ? { low: Math.min(...rangePoints), high: Math.max(...rangePoints) } : undefined;
  const capacity = pool ? poolCapacity(pool) : undefined;

  return (
    <div className="market-card">
      <div className="price-row">
        <div>
          <span className="eyebrow">Coinbase reference</span>
          <div className="spot-price">
            <strong>{spot.data ? `$${formatUsdPrice(spot.data.price)}` : "—"}</strong>
            <span className={`price-mode ${mode}`}>{mode === "live" ? "Live" : mode === "stale" ? "Stale" : "Loading"}</span>
          </div>
          {spot.isError && <small className="reference-gap-note">Reference unavailable: {spot.error ?? "unknown error"}</small>}
          {!spot.isError && mode === "stale" && spot.data && (
            <small className="reference-gap-note">Last print {formatAgo(spot.data.publishTime, nowSec)}</small>
          )}
        </div>
        <div className="market-stats">
          <div>
            <span>24h change</span>
            <strong className={change === undefined ? "pending" : change > 0 ? "positive" : change < 0 ? "negative" : undefined}>
              {change === undefined ? "—" : formatSignedPercent(change)}
            </strong>
          </div>
          <div>
            <span>24h range</span>
            <strong className={range ? undefined : "pending"}>
              {range ? `${formatUsdPrice(range.low)} – ${formatUsdPrice(range.high)}` : "—"}
            </strong>
          </div>
          <div>
            <span title="Liquidity the pool can still lock into new positions right now">Pool available</span>
            <strong className={pool && capacity ? undefined : "pending"}>
              {pool && capacity ? `${formatTokenAmount(capacity.availableRaw, pool.assetDecimals)} ${pool.assetSymbol}` : "—"}
            </strong>
          </div>
        </div>
      </div>

      <PriceChart
        feedId={feedId}
        symbol={symbol}
        spot={spot.data}
        mode={mode}
        nowSec={nowSec}
        strikePrice={strikePrice}
        breakevenPrice={breakevenPrice}
      />
    </div>
  );
}

/** "Price, explained." — the pricing disclosure, one click from the chart. */
export function PricingNote({ earlyExit }: { earlyExit?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="transparency-card">
        <div>
          <BookOpen size={19} aria-hidden="true" />
          <span>
            <strong>Price, explained.</strong>
            <small>Tend shows what a capped payout costs — not just the multiplier.</small>
          </span>
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          How Tend prices risk <ArrowUpRight size={15} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="pricing-explainer">
          <strong>Signed quote, filled on Monad.</strong>
          <p>
            The quote service prices each position from realized volatility and signs an EIP-712 quote bound to your
            wallet, the series, the direction, strike, premium and a 30-second expiry. You pay the premium once; the pool
            vault escrows the full max payout until the series settles, so there is no liquidation.{" "}
            {earlyExit
              ? "That escrow is also what lets you sell back early: the desk's bid is paid out of collateral your own position locked, so it can never exceed what the pool holds."
              : "There is no early exit — a position is held to expiry."}{" "}
            Testnet settlement uses Tend's own oracle: only Tend's admin key can post the expiry price, which is not independently attested.
          </p>
        </div>
      )}
    </>
  );
}
