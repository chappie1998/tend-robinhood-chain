import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, LineStyle, createChart, type IChartApi, type ISeriesApi } from "lightweight-charts";
import type { Hex } from "viem";
import { usePythBars, type PythResolution, type PythSpot } from "../hooks/usePythPrice";
import { formatAgo, formatExactStrike, formatUsdPrice } from "../lib/format";
import type { SpotMode } from "../lib/spotMode";

const HOUR = 3_600;
const DAY = 86_400;

interface Timeframe {
  label: string;
  resolution: PythResolution;
  /** How far back to ask for, in seconds — each window stays under the API's 300-candle cap. */
  lookbackSeconds: number;
  description: string;
}

// Same intervals as the Solana terminal. Short candles lead because the
// shortest series here expire in 15 minutes: hourly bars say nothing useful
// about a position that lives for less than one of them.
const TIMEFRAMES: readonly Timeframe[] = [
  { label: "1m", resolution: "1", lookbackSeconds: 4 * HOUR, description: "4 hours of 1-minute candles" },
  { label: "5m", resolution: "5", lookbackSeconds: 24 * HOUR, description: "24 hours of 5-minute candles" },
  { label: "15m", resolution: "15", lookbackSeconds: 3 * DAY, description: "3 days of 15-minute candles" },
  { label: "1h", resolution: "60", lookbackSeconds: 7 * DAY, description: "7 days of hourly candles" },
  { label: "1D", resolution: "D", lookbackSeconds: 180 * DAY, description: "180 days of daily candles" },
];

const DEFAULT_TIMEFRAME = TIMEFRAMES[1];

interface ChartTheme {
  background: string;
  axisText: string;
  line: string;
  up: string;
  down: string;
  accent: string;
}

/** The chart's palette comes from the same tokens as the rest of the page, so it follows light/dark. */
function readChartTheme(element: HTMLElement): ChartTheme {
  const styles = getComputedStyle(element);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--surface", "#121213"),
    axisText: read("--ink-2", "#969a9e"),
    line: read("--border", "#232427"),
    up: read("--positive", "#62d67f"),
    down: read("--negative", "#ff6b6b"),
    accent: read("--accent", "#62d67f"),
  };
}

/**
 * TradingView Lightweight Charts over Coinbase Exchange OHLC — market context,
 * not an authenticated settlement price. A live quote's strike and breakeven
 * are drawn as price lines. Loading, error and empty windows are stated over
 * the canvas instead of leaving old candles on screen.
 */
export function PriceChart({
  feedId,
  symbol,
  spot,
  mode,
  nowSec,
  strikePrice,
  breakevenPrice,
}: {
  feedId: Hex;
  symbol: string;
  spot: PythSpot | undefined;
  mode: SpotMode;
  nowSec: number;
  strikePrice?: number;
  breakevenPrice?: number;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>(DEFAULT_TIMEFRAME);
  const bars = usePythBars(feedId, timeframe.resolution, timeframe.lookbackSeconds);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  // Fit the window once per timeframe, so a background refetch never undoes
  // the trader's own pan and zoom.
  const fittedRef = useRef<string | null>(null);

  const [theme, setTheme] = useState<ChartTheme | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setTheme(readChartTheme(container));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onThemeChange = () => setTheme(readChartTheme(container));
    media.addEventListener("change", onThemeChange);
    return () => media.removeEventListener("change", onThemeChange);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !theme) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 300,
      layout: {
        background: { type: ColorType.Solid, color: theme.background },
        textColor: theme.axisText,
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        // Lightweight Charts is TradingView's, under Apache-2.0; their mark stays on it.
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: theme.line },
        horzLines: { color: theme.line },
      },
      rightPriceScale: { borderColor: theme.line },
      timeScale: { borderColor: theme.line, timeVisible: true, secondsVisible: false },
      localization: { priceFormatter: (price: number) => `$${formatUsdPrice(price)}` },
      // Dragging the chart vertically on a phone would fight the page scroll.
      handleScroll: { vertTouchDrag: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: theme.up,
      downColor: theme.down,
      borderVisible: false,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      // A zero dimension happens while the panel is off-screen; applying it
      // would collapse the chart with nothing to bring it back.
      if (rect && rect.width > 0 && rect.height > 0) chart.resize(Math.floor(rect.width), Math.floor(rect.height));
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      fittedRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(bars.data ?? []);
    chart.applyOptions({ timeScale: { timeVisible: timeframe.resolution !== "D" } });
    if (bars.data && bars.data.length > 0 && fittedRef.current !== timeframe.label) {
      chart.timeScale().fitContent();
      fittedRef.current = timeframe.label;
    }
  }, [bars.data, timeframe, theme]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !theme || strikePrice === undefined || !Number.isFinite(strikePrice)) return;
    const line = series.createPriceLine({
      price: strikePrice,
      color: theme.accent,
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      // The shared axis formatter rounds BTC prices; the exact raw strike is
      // shown in the adjacent Quoted strike label instead.
      axisLabelVisible: false,
      title: "Strike",
    });
    // On unmount the chart effect's cleanup disposes the series first.
    return () => {
      if (chartRef.current) series.removePriceLine(line);
    };
  }, [strikePrice, theme]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !theme || breakevenPrice === undefined || !Number.isFinite(breakevenPrice)) return;
    const line = series.createPriceLine({
      price: breakevenPrice,
      color: theme.accent,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "Breakeven",
    });
    return () => {
      if (chartRef.current) series.removePriceLine(line);
    };
  }, [breakevenPrice, theme]);

  const hasBars = Boolean(bars.data && bars.data.length > 0);
  const hasStrike = strikePrice !== undefined && Number.isFinite(strikePrice);
  const hasBreakeven = breakevenPrice !== undefined && Number.isFinite(breakevenPrice);

  let overlay = null;
  if (bars.unsupportedFeed) {
    overlay = (
      <div className="chart-state">
        <AlertTriangle size={20} aria-hidden="true" />
        <strong>No chart for this market</strong>
        <span>This demo charts BTC-USD, ETH-USD and MON-USD. The live reference price above is unaffected.</span>
      </div>
    );
  } else if (bars.isError) {
    overlay = (
      <div className="chart-state error" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <strong>Couldn’t load market bars</strong>
        <span>{bars.error ?? "Unknown error"} Retrying automatically.</span>
      </div>
    );
  } else if (bars.isLoading) {
    overlay = (
      <div className="chart-state" role="status">
        <LoaderCircle className="spin" size={20} aria-hidden="true" />
        <strong>Loading market bars</strong>
        <span>Fetching {timeframe.description} from Coinbase Exchange…</span>
      </div>
    );
  } else if (!hasBars) {
    overlay = (
      <div className="chart-state">
        <strong>No candles in this window</strong>
        <span>Coinbase Exchange returned no bars for {timeframe.description}.</span>
      </div>
    );
  }

  return (
    <section className="tv-chart" aria-label={`${symbol} market chart`}>
      <div className="chart-toolbar">
        <div>
          <strong>Market chart</strong>
          <span>Coinbase Exchange OHLC · {timeframe.description}, rendered locally with TradingView Lightweight Charts.</span>
        </div>
        <div className="resolution-picker" role="group" aria-label="Chart interval">
          {TIMEFRAMES.map((option) => (
            <button
              type="button"
              key={option.label}
              className={option.label === timeframe.label ? "active" : ""}
              aria-pressed={option.label === timeframe.label}
              onClick={() => setTimeframe(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {hasStrike && (
        <div className="chart-target">
          <span>Quoted strike</span>
          <strong>${formatExactStrike(strikePrice!)}</strong>
          {hasBreakeven && (
            <>
              <span>Breakeven</span>
              <strong>${formatUsdPrice(breakevenPrice!)}</strong>
            </>
          )}
        </div>
      )}

      <div className="chart-canvas-wrap">
        {overlay}
        <div
          ref={containerRef}
          className={hasBars ? "chart-canvas visible" : "chart-canvas"}
          role="img"
          aria-label={chartLabel(symbol, timeframe, bars.data, strikePrice, breakevenPrice)}
        />
      </div>

      <div className="chart-source">
        <span className={`data-mode ${mode}`}>{mode === "live" ? "Coinbase live" : mode === "stale" ? "Coinbase stale" : "Checking Coinbase"}</span>
        <span>{spot ? `Coinbase ${formatUsdPrice(spot.price)} · ${formatAgo(spot.publishTime, nowSec)}` : "Market reference pending"}</span>
        <span>
          {hasBars
            ? `Coinbase Exchange · ${bars.data!.length.toLocaleString()} real bars · no simulated candles`
            : "Chart history loads from Coinbase Exchange."}
        </span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
          Charts by TradingView
        </a>
      </div>
    </section>
  );
}

/** Text alternative for the canvas. Describes only what was actually drawn. */
function chartLabel(
  symbol: string,
  timeframe: Timeframe,
  bars: { low: number; high: number }[] | undefined,
  strikePrice: number | undefined,
  breakevenPrice: number | undefined,
): string {
  const strike = strikePrice !== undefined && Number.isFinite(strikePrice) ? ` Quoted strike marked at ${formatExactStrike(strikePrice)} USD.` : "";
  const breakeven =
    breakevenPrice !== undefined && Number.isFinite(breakevenPrice) ? ` Breakeven marked at ${formatUsdPrice(breakevenPrice)} USD.` : "";
  if (!bars || bars.length === 0) return `${symbol} / USD candlestick chart — ${timeframe.description}, no data.${strike}${breakeven}`;
  const low = Math.min(...bars.map((bar) => bar.low));
  const high = Math.max(...bars.map((bar) => bar.high));
  return (
    `${symbol} / USD candlestick chart — ${timeframe.description} from Coinbase Exchange, ` +
    `${bars.length} candles ranging ${formatUsdPrice(low)} to ${formatUsdPrice(high)} USD.${strike}${breakeven}`
  );
}
