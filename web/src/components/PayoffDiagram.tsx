import type { PoolQuote } from "../lib/quote";
import { computePayoffSummary, computePnlAtPrice } from "../lib/payoff";
import { formatExactStrike, formatTokenAmount, formatUsdPrice } from "../lib/format";

const VIEW_W = 320;
const VIEW_H = 210;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 16;
const PAD_B = 26;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

/**
 * Inline SVG payoff diagram: net P&L vs settlement price for the ticket's
 * live quote. Legacy spreads rise linearly across the strike→cap width;
 * width=1 binary quotes jump at the strict expiry threshold. Both mirror
 * `computePayoffSummary` exactly,
 * evaluated at five settlement prices via `computePnlAtPrice` (lib/payoff.ts)
 * rather than any new math. Marks strike, breakeven, max profit, max loss and
 * current spot; shades the profit/loss regions at low opacity; zero line
 * always drawn. No chart library — a handful of SVG primitives sized by
 * `viewBox` so the diagram scales with its container.
 */
export function PayoffDiagram({
  quote,
  assetDecimals,
  assetSymbol,
  spotPrice,
}: {
  quote: PoolQuote;
  assetDecimals: number;
  assetSymbol: string;
  spotPrice: number | undefined;
}) {
  const summary = computePayoffSummary(quote);
  const { strikePrice: strike, capPrice: cap, breakevenPrice: breakeven, maxLoss, maxProfit, isBinary } = summary;
  const isUp = quote.direction === 0;

  if (!Number.isFinite(strike) || !Number.isFinite(cap) || !Number.isFinite(breakeven)) {
    return null;
  }

  const maxLossRaw = Number(maxLoss);
  const maxProfitRaw = Number(maxProfit);

  // ---- X domain: the full strike<->cap slope, with margin, extended to
  // include live spot if it currently sits outside that range. ----
  const lo = Math.min(strike, cap);
  const hi = Math.max(strike, cap);
  const span = Math.max(hi - lo, strike * 0.001, 1e-6);
  const xMargin = span * 0.35;
  let xMin = lo - xMargin;
  let xMax = hi + xMargin;
  const hasSpot = spotPrice !== undefined && Number.isFinite(spotPrice) && spotPrice > 0;
  if (hasSpot) {
    xMin = Math.min(xMin, spotPrice! - span * 0.12);
    xMax = Math.max(xMax, spotPrice! + span * 0.12);
  }

  // ---- Y domain: from the flat loss floor to the flat profit ceiling
  // (always including 0), with a little breathing room top and bottom. ----
  const yLo = Math.min(-maxLossRaw, 0);
  const yHi = Math.max(maxProfitRaw, 0);
  const ySpan = Math.max(yHi - yLo, 1);
  const yMargin = ySpan * 0.2;
  const yMin = yLo - yMargin;
  const yMax = yHi + yMargin;

  const xScale = (x: number) => PAD_L + ((x - xMin) / (xMax - xMin)) * PLOT_W;
  const yScale = (y: number) => PAD_T + (1 - (y - yMin) / (yMax - yMin)) * PLOT_H;

  // Vertices of the payoff line in ascending x order. Binary tickets have a
  // one-raw-tick vertical step at strike; legacy quotes retain their slope.
  // the two domain edges, the two kinks (strike and cap, whichever order the
  // quote's direction puts them in), and breakeven — pinned to y=0 exactly
  // (its true value is already ~0 by construction; pinning avoids a hairline
  // visual gap between the shaded regions from floating-point rounding).
  const xs = Array.from(new Set([xMin, strike, cap, xMax, ...(isBinary ? [] : [breakeven])])).sort((a, b) => a - b);
  const vertices = isBinary
    ? isUp
      ? [{ x: xMin, y: -maxLossRaw }, { x: strike, y: -maxLossRaw }, { x: strike, y: maxProfitRaw }, { x: xMax, y: maxProfitRaw }]
      : [{ x: xMin, y: maxProfitRaw }, { x: strike, y: maxProfitRaw }, { x: strike, y: -maxLossRaw }, { x: xMax, y: -maxLossRaw }]
    : xs.map((x) => ({ x, y: x === breakeven ? 0 : computePnlAtPrice(quote, x) }));

  const linePath = vertices.map((v, i) => `${i === 0 ? "M" : "L"}${xScale(v.x).toFixed(2)},${yScale(v.y).toFixed(2)}`).join(" ");

  const lossVertices = vertices.filter((v) => v.x <= breakeven);
  const profitVertices = vertices.filter((v) => v.x >= breakeven);
  const binaryLoss = isUp
    ? [{ x: xMin, y: 0 }, { x: xMin, y: -maxLossRaw }, { x: strike, y: -maxLossRaw }, { x: strike, y: 0 }]
    : [{ x: strike, y: 0 }, { x: strike, y: -maxLossRaw }, { x: xMax, y: -maxLossRaw }, { x: xMax, y: 0 }];
  const binaryProfit = isUp
    ? [{ x: strike, y: 0 }, { x: strike, y: maxProfitRaw }, { x: xMax, y: maxProfitRaw }, { x: xMax, y: 0 }]
    : [{ x: xMin, y: 0 }, { x: xMin, y: maxProfitRaw }, { x: strike, y: maxProfitRaw }, { x: strike, y: 0 }];
  const lossPoints = (isBinary ? binaryLoss : [{ x: xMin, y: 0 }, ...lossVertices])
    .map((v) => `${xScale(v.x).toFixed(2)},${yScale(v.y).toFixed(2)}`)
    .join(" ");
  const profitPoints = (isBinary ? binaryProfit : [...profitVertices, { x: xMax, y: 0 }])
    .map((v) => `${xScale(v.x).toFixed(2)},${yScale(v.y).toFixed(2)}`)
    .join(" ");

  const zeroY = yScale(0);
  const strikeX = xScale(strike);
  const breakevenX = xScale(breakeven);
  const maxProfitY = yScale(maxProfitRaw);
  const maxLossY = yScale(-maxLossRaw);
  const spotX = hasSpot ? xScale(spotPrice!) : undefined;
  const spotY = hasSpot ? yScale(computePnlAtPrice(quote, spotPrice!)) : undefined;

  const maxLossLabel = `−${formatTokenAmount(maxLoss, assetDecimals)}`;
  const maxProfitLabel = `+${formatTokenAmount(maxProfit, assetDecimals)}`;

  const displayedStrike = isBinary ? formatExactStrike(quote.strike) : formatUsdPrice(strike);
  const lossCondition = isUp ? `at or below ${displayedStrike}` : `at or above ${displayedStrike}`;
  const profitCondition = isUp ? `above ${displayedStrike}` : `below ${displayedStrike}`;
  const legacyProfitCondition = isUp ? `at or above ${formatUsdPrice(cap)}` : `at or below ${formatUsdPrice(cap)}`;
  const ariaLabel =
    `Payoff diagram. Max loss ${maxLossLabel} ${assetSymbol} ${lossCondition} USD, ` +
    `max profit ${maxProfitLabel} ${assetSymbol} ${isBinary ? `only ${profitCondition}` : legacyProfitCondition}, ` +
    `${isBinary ? "strict win threshold" : "breakeven"} at ${isBinary ? displayedStrike : formatUsdPrice(breakeven)} USD` +
    (hasSpot ? `, current spot ${formatUsdPrice(spotPrice!)} USD.` : ".");

  return (
    <div className="payoff-diagram">
      <svg
        className="payoff-diagram__svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Shaded regions first, so every line/marker draws on top of them. */}
        <polygon points={lossPoints} className="payoff-diagram__area payoff-diagram__area--loss" />
        <polygon points={profitPoints} className="payoff-diagram__area payoff-diagram__area--profit" />

        {/* Zero line — the one line every payoff diagram must make unmistakable. */}
        <line x1={PAD_L} y1={zeroY} x2={VIEW_W - PAD_R} y2={zeroY} className="payoff-diagram__zero-line" />
        <text x={PAD_L} y={zeroY - 4} className="payoff-diagram__axis-label">
          0
        </text>

        {/* Max profit / max loss reference lines, at their true flat level. */}
        <line x1={PAD_L} y1={maxProfitY} x2={VIEW_W - PAD_R} y2={maxProfitY} className="payoff-diagram__ref-line payoff-diagram__ref-line--profit" />
        <text x={VIEW_W - PAD_R} y={maxProfitY - 4} textAnchor="end" className="payoff-diagram__axis-label payoff-diagram__axis-label--profit">
          {maxProfitLabel} {assetSymbol}
        </text>

        <line x1={PAD_L} y1={maxLossY} x2={VIEW_W - PAD_R} y2={maxLossY} className="payoff-diagram__ref-line payoff-diagram__ref-line--loss" />
        <text x={VIEW_W - PAD_R} y={maxLossY + 12} textAnchor="end" className="payoff-diagram__axis-label payoff-diagram__axis-label--loss">
          {maxLossLabel} {assetSymbol}
        </text>

        {/* The payoff line itself. */}
        <path d={linePath} className="payoff-diagram__line" />

        {/* Strike — the brand's one sparing use of accent, same as the price chart's strike line. */}
        <line x1={strikeX} y1={PAD_T} x2={strikeX} y2={VIEW_H - PAD_B} className="payoff-diagram__guide payoff-diagram__guide--strike" />
        <text x={strikeX} y={VIEW_H - 6} textAnchor="middle" className="payoff-diagram__axis-label payoff-diagram__axis-label--strike">
          Strike {displayedStrike}
        </text>

        {!isBinary && (
          <>
            <line x1={breakevenX} y1={PAD_T} x2={breakevenX} y2={VIEW_H - PAD_B} className="payoff-diagram__guide payoff-diagram__guide--breakeven" />
            <text x={breakevenX} y={PAD_T + 10} textAnchor="middle" className="payoff-diagram__axis-label payoff-diagram__axis-label--breakeven">
              Breakeven {formatUsdPrice(breakeven)}
            </text>
          </>
        )}

        {/* Current spot — where this position actually stands right now. */}
        {hasSpot && spotX !== undefined && spotY !== undefined && (
          <>
            <circle cx={spotX} cy={spotY} r={3.5} className="payoff-diagram__spot-dot" />
            <text
              x={spotX}
              y={spotY - 8 >= PAD_T + 8 ? spotY - 8 : spotY + 16}
              textAnchor="middle"
              className="payoff-diagram__axis-label payoff-diagram__axis-label--spot"
            >
              Spot {formatUsdPrice(spotPrice!)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
