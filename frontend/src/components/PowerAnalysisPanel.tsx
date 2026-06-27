import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Zap } from "lucide-react";
import {
  createChart,
  ColorType,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { api } from "../lib/api";
import {
  fetchPowerAnalysis,
  type PowerAccuracy,
  type PowerMode,
  type PowerSignal,
} from "../lib/powerAnalysisApi";
import {
  fetchPatternOhlcv,
  type PatternChartTimeframe,
} from "../lib/patternApi";
import { useMarketSocket, type WsEvent } from "../lib/socket";
import { useAuth } from "../store/auth";

/**
 * Power Analysis panel.
 *
 * Runs the super-composer on the selected symbol/timeframe and plots
 * BUY/SELL arrows on its own candlestick chart. The button is the
 * primary affordance — clicking it fetches OHLCV + runs the engine.
 *
 * Default mode is "strict" — fewer but stronger signals. Switch to
 * "loose" if you want to see more signals at the cost of slightly
 * lower per-signal confidence.
 */

interface Props {
  symbol: string;
  onSymbolChange?: (s: string) => void;
}

const TIMEFRAMES: Array<{ id: PatternChartTimeframe; label: string }> = [
  { id: "M5", label: "5m" },
  { id: "M15", label: "15m" },
  { id: "H1", label: "1h" },
  { id: "D1", label: "1d" },
];

const SYMBOL_UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
  "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL",
];

export default function PowerAnalysisPanel({ symbol, onSymbolChange }: Props) {
  const [timeframe, setTimeframe] = useState<PatternChartTimeframe>("D1");
  const [mode, setMode] = useState<PowerMode>("strict");
  // Target multiple of risk. 2R = highest win rate, 4R = ~4% returns.
  // IGNORED when useFixedRisk is true (then stopPct/targetPct take over).
  const [targetR, setTargetR] = useState<number>(2);
  // Fixed-% stop & target. The user's "2% loss, 5% profit" rule.
  // When useFixedRisk is true these override the ATR-derived envelope
  // on every signal — every trade has the same risk shape regardless
  // of volatility.
  const [useFixedRisk, setUseFixedRisk] = useState<boolean>(true);
  const [stopPct, setStopPct] = useState<number>(2);
  const [targetPct, setTargetPct] = useState<number>(5);
  // ML head — when on, the ai-service will auto-train a per-symbol
  // GBM+RF+MLP ensemble from the loaded candles (first run, ~3 s) and
  // include its vote in the composite. Subsequent runs reuse the cached
  // model from MODEL_DIR.
  const [useMl, setUseMl] = useState<boolean>(true);
  // Live mode — subscribe to WS candle events. When a NEW bar closes,
  // automatically re-fetch + re-analyse. OFF by default to keep cost
  // under control and let the user explicitly opt-in.
  const [liveMode, setLiveMode] = useState<boolean>(false);
  const [liveStatus, setLiveStatus] = useState<string>("");
  const lastBarRef = useRef<number>(0);          // last bar timestamp seen
  const liveRerunPendingRef = useRef<number | null>(null);
  const token = useAuth((s) => s.token);
  // Candlestick patterns overlay — Hammer / Doji / Engulfing / Morning
  // Star / etc. Each detected pattern bar gets a marker labelled with
  // the pattern name and coloured by bias (BULL/BEAR/NEUTRAL).
  const [showCandlePatterns, setShowCandlePatterns] = useState<boolean>(true);
  const [candlePatterns, setCandlePatterns] = useState<Array<{
    name: string;
    bias: "BULL" | "BEAR" | "NEUTRAL";
    index: number;
    t: number;
    reliability: number;
    notes?: string;
  }>>([]);
  // Classical chart patterns (Double Top, H&S, Wedge, Diamond, Bump-and-Run …)
  // — full geometry so we can draw neckline / support / resistance lines.
  const [showChartPatterns, setShowChartPatterns] = useState<boolean>(true);
  const [chartPatterns, setChartPatterns] = useState<Array<{
    id: number;
    name: string;
    tier: number;
    direction: number;
    confidence: number;
    candle_indices: number[];
    entry_price?: number | null;
    target_price?: number | null;
    stop_price?: number | null;
    trendline_points: Array<{ t: number; price: number }>;
  }>>([]);
  // Line-series + price-line handles for the chart-pattern overlays —
  // tracked so we can detach them when the symbol changes.
  const chartPatternSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const chartPatternLinesRef = useRef<IPriceLine[]>([]);

  const [loadingOhlcv, setLoadingOhlcv] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signals, setSignals] = useState<PowerSignal[]>([]);
  const [summary, setSummary] = useState<{
    total_signals: number;
    buy_count: number;
    sell_count: number;
    avg_confidence: number;
  } | null>(null);
  const [accuracy, setAccuracy] = useState<PowerAccuracy | null>(null);

  // Chart refs.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  // Indicator overlays — same chart pane as the candles.
  const sma40Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const sma18Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbMidRef   = useRef<ISeriesApi<"Line"> | null>(null);
  // Entry / Stop / Target horizontal lines drawn for the latest signal.
  // Tracked so we can detach them on the next run.
  const setupLinesRef = useRef<IPriceLine[]>([]);
  const [showIndicators, setShowIndicators] = useState(true);
  // Keep the raw candle array so the Run button doesn't need to refetch.
  const candlesRef = useRef<
    Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>
  >([]);

  /** Create chart once. */
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0d12" },
        textColor: "#94a3b8",
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#1f2a3d" },
        horzLines: { color: "#1f2a3d" },
      },
      rightPriceScale: {
        borderColor: "#1f2a3d",
        scaleMargins: { top: 0.12, bottom: 0.16 },
      },
      timeScale: { borderColor: "#1f2a3d", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#16c784",
      downColor: "#ea3943",
      wickUpColor: "#16c784",
      wickDownColor: "#ea3943",
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    // Indicator overlays — same price axis as the candles. SMAs are
    // what PPS uses for its trend filter; Bollinger comes from the
    // Strategy layer. Initial setData([]) is empty; populated when
    // OHLCV loads.
    sma40Ref.current = chart.addLineSeries({
      color: "#fbbf24", lineWidth: 2,                // amber — slow trend
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    sma18Ref.current = chart.addLineSeries({
      color: "#60a5fa", lineWidth: 1,                // blue — fast trend
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    bbUpperRef.current = chart.addLineSeries({
      color: "#a78bfa", lineWidth: 1, lineStyle: 2,  // dashed violet
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    bbLowerRef.current = chart.addLineSeries({
      color: "#a78bfa", lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    bbMidRef.current = chart.addLineSeries({
      color: "#a78bfa55", lineWidth: 1, lineStyle: 1,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      sma40Ref.current = sma18Ref.current = null;
      bbUpperRef.current = bbLowerRef.current = bbMidRef.current = null;
    };
  }, []);

  /** Load OHLCV whenever symbol/timeframe changes. Clears any prior signals. */
  useEffect(() => {
    let aborted = false;
    (async () => {
      setLoadingOhlcv(true);
      setError(null);
      setSignals([]);
      setSummary(null);
      setAccuracy(null);
      try {
        const ohlcv = await fetchPatternOhlcv(symbol, timeframe, 400);
        if (aborted) return;
        if (!ohlcv || !ohlcv.candles?.length) {
          setError("No candle data available for this symbol/timeframe.");
          return;
        }
        candlesRef.current = ohlcv.candles;
        const cdata: CandlestickData[] = ohlcv.candles.map((c) => ({
          time: Math.floor(c.t / 1000) as UTCTimestamp,
          open: c.o, high: c.h, low: c.l, close: c.c,
        }));
        seriesRef.current?.setData(cdata);
        try { seriesRef.current?.setMarkers([]); } catch { /* */ }
        chartRef.current?.timeScale().fitContent();
        plotIndicators(ohlcv.candles);

        // Fetch candlestick patterns (Hammer / Doji / Engulfing / …)
        // alongside the OHLCV so they're ready as soon as the chart
        // mounts — no need to wait for the Run Power Analysis click.
        try {
          const { data } = await api.post<{
            patterns?: Array<{
              name: string;
              bias: "BULL" | "BEAR" | "NEUTRAL";
              index: number;
              t: number;
              reliability: number;
              notes?: string;
            }>;
          }>("/api/analysis/candlestick", {
            symbol,
            candles: ohlcv.candles,
            lookback: 80,
          });
          if (!aborted) setCandlePatterns(data?.patterns ?? []);
        } catch {
          if (!aborted) setCandlePatterns([]);
        }

        // Classical chart patterns (Double Top, H&S, Wedge, Diamond, …)
        // with full trendline geometry so we can draw the neckline /
        // support / resistance lines on the candle chart.
        try {
          const { data } = await api.post<{
            patterns?: Array<{
              id: number; name: string; tier: number; direction: number;
              confidence: number; candle_indices: number[];
              entry_price?: number | null; target_price?: number | null;
              stop_price?: number | null;
              trendline_points: Array<{ t: number; price: number }>;
            }>;
          }>("/api/gainz-alpha/chart-patterns", {
            candles: ohlcv.candles,
            min_confidence: 0.45,
          });
          if (!aborted) setChartPatterns(data?.patterns ?? []);
        } catch {
          if (!aborted) setChartPatterns([]);
        }
      } finally {
        if (!aborted) setLoadingOhlcv(false);
      }
    })();
    return () => { aborted = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [symbol, timeframe]);

  // ── Indicator overlays ────────────────────────────────────────────────
  // Computes SMA-40 / SMA-18 / Bollinger(20, 2) from the loaded candles
  // and pushes them into the line series. Re-runs when the user toggles
  // visibility or when candles reload.
  function plotIndicators(candles: typeof candlesRef.current) {
    if (!candles?.length) return;
    const lines = computeIndicatorLines(candles);
    const empty: Array<{ time: UTCTimestamp; value: number }> = [];
    const show = showIndicators;
    sma40Ref.current?.setData(show ? lines.sma40 : empty);
    sma18Ref.current?.setData(show ? lines.sma18 : empty);
    bbUpperRef.current?.setData(show ? lines.bbUpper : empty);
    bbLowerRef.current?.setData(show ? lines.bbLower : empty);
    bbMidRef.current?.setData(show ? lines.bbMid : empty);
  }

  // Toggle re-runs the plot using the cached candles.
  useEffect(() => {
    if (candlesRef.current?.length) plotIndicators(candlesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIndicators]);

  // ── Chart-pattern overlays ────────────────────────────────────────────
  // For each detected classical pattern we draw:
  //   1. A line series connecting its trendline_points (neckline, wedge
  //      boundary, support / resistance — exactly what the reference
  //      cheat-sheet shows).
  //   2. A faint horizontal price line at the breakout entry, labelled
  //      with the pattern name + direction.
  // Bullish patterns are tinted green; bearish patterns red; tier 0
  // (Brandt's high-reliability set) gets a thicker stroke.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    // Tear down prior drawings before redrawing.
    for (const s of chartPatternSeriesRef.current) {
      try { chart.removeSeries(s); } catch { /* */ }
    }
    chartPatternSeriesRef.current = [];
    for (const ln of chartPatternLinesRef.current) {
      try { series.removePriceLine(ln); } catch { /* */ }
    }
    chartPatternLinesRef.current = [];

    if (!showChartPatterns || chartPatterns.length === 0) return;

    // Cap to top 6 by confidence so the chart doesn't become unreadable.
    const top = [...chartPatterns]
      .sort((a, b) => (a.tier - b.tier) || (b.confidence - a.confidence))
      .slice(0, 6);

    for (const p of top) {
      const bullish = p.direction > 0;
      const color = bullish ? "#16c784" : p.direction < 0 ? "#ea3943" : "#a78bfa";
      const stroke = p.tier === 0 ? 3 : 2;

      // 1) Trendline / neckline / boundary
      if (p.trendline_points && p.trendline_points.length >= 2) {
        const line = chart.addLineSeries({
          color, lineWidth: stroke as 1 | 2 | 3 | 4,
          lineStyle: p.tier === 0 ? LineStyle.Solid : LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        const data = p.trendline_points
          .map((pt) => ({ time: Math.floor(pt.t / 1000) as UTCTimestamp, value: pt.price }))
          .sort((a, b) => (a.time as number) - (b.time as number))
          .filter((pt, i, arr) => i === 0 || pt.time !== arr[i - 1].time);
        try { line.setData(data); chartPatternSeriesRef.current.push(line); }
        catch { try { chart.removeSeries(line); } catch { /* */ } }
      }

      // 2) Faint breakout entry line so the user can see WHERE the
      //    setup expects price to break out.
      if (p.entry_price != null) {
        try {
          const pl = series.createPriceLine({
            price: p.entry_price,
            color: `${color}88`,                    // 50%-alpha tint
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: `${prettyPattern(p.name)} · ${bullish ? "↑" : "↓"} ${Math.round(p.confidence * 100)}%`,
          });
          chartPatternLinesRef.current.push(pl);
        } catch { /* */ }
      }
    }
  }, [chartPatterns, showChartPatterns]);

  /** Run the Power Analysis. */
  async function runPower(silent = false) {
    if (candlesRef.current.length < 80) {
      setError(`Need ≥ 80 bars (have ${candlesRef.current.length}).`);
      return;
    }
    // `silent` runs (triggered by the live auto-rerun) skip the loading
    // overlay so the chart never visibly freezes while a fresh analysis
    // arrives in the background.
    if (!silent) setRunning(true);
    setError(null);
    try {
      const res = await fetchPowerAnalysis({
        symbol,
        candles: candlesRef.current,
        mode,
        useMl,
        targetR,
        stopPct: useFixedRisk ? stopPct : undefined,
        targetPct: useFixedRisk ? targetPct : undefined,
      });
      if (!res) {
        if (!silent) setError("Power Analysis API unavailable.");
        return;
      }
      setSignals(res.signals);
      setSummary(res.summary);
      setAccuracy(res.accuracy ?? null);
    } finally {
      if (!silent) setRunning(false);
    }
  }

  // ── Live mode: WS subscription + visual chart updates ─────────────────
  //
  // We subscribe to /ws candle events for the currently-selected symbol
  // and push every incoming candle straight into the candlestick series
  // via series.update(). This is the same mechanism the Dashboard uses
  // to make its chart "breathe".
  //
  // Critical: we do NOT re-run the Power Analysis on each bar close. The
  // composer is expensive (~5 s with ML), and the markers / accuracy
  // banner should stay stable while the user reads them. The chart
  // visually ticks; signals refresh only when the user clicks Run.
  useMarketSocket({
    token,
    symbols: liveMode && symbol ? [symbol] : [],
    onEvent: (ev: WsEvent) => {
      if (!liveMode) return;
      if (ev.type !== "candle") return;
      if (ev.candle.symbol !== symbol) return;
      const c = ev.candle;
      const bars = candlesRef.current;
      if (!bars.length) return;
      const tail = bars[bars.length - 1];
      const incoming = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? tail.v };

      // Update the in-memory candle cache so the next analysis run uses
      // the latest bar.
      let newBarClosed = false;
      if (c.t === tail.t) {
        candlesRef.current = [...bars.slice(0, -1), incoming];
      } else if (c.t > tail.t) {
        candlesRef.current = [...bars, incoming].slice(-500);
        lastBarRef.current = c.t;
        newBarClosed = true;
      }

      // Push into the visible chart series so the candle ticks live.
      try {
        seriesRef.current?.update({
          time: Math.floor(c.t / 1000) as UTCTimestamp,
          open: c.o, high: c.h, low: c.l, close: c.c,
        });
      } catch { /* time off-grid */ }

      // Continuous live analysis — schedule a SILENT background rerun
      // on every WS tick. Debounced (1.5 s) so a burst of intra-bar
      // ticks collapses to one analysis pass, but the user feels the
      // signals refreshing continuously rather than "on bar close only".
      // The rerun runs in the background — no loading overlay, no chart
      // freeze — so the live tick remains smooth.
      if (liveRerunPendingRef.current != null) {
        window.clearTimeout(liveRerunPendingRef.current);
      }
      liveRerunPendingRef.current = window.setTimeout(() => {
        liveRerunPendingRef.current = null;
        void runPower(true);
      }, newBarClosed ? 500 : 1500);
      setLiveStatus(
        newBarClosed
          ? `new bar ${new Date(c.t).toLocaleTimeString()} — analysing…`
          : `live · last tick ${new Date(c.t).toLocaleTimeString()}`
      );
    },
  });

  // Status hint when live mode is on but no ticks have arrived yet.
  useEffect(() => {
    if (!liveMode) {
      setLiveStatus("");
      // Drop any in-flight rerun timer.
      if (liveRerunPendingRef.current != null) {
        window.clearTimeout(liveRerunPendingRef.current);
        liveRerunPendingRef.current = null;
      }
      return;
    }
    setLiveStatus("live — waiting for next bar close");
  }, [liveMode]);

  // Actionable signals only (HOLDs aren't shown on chart or in counts).
  const actionable = useMemo(
    () => signals.filter((s) => s.signal === "BUY" || s.signal === "SELL"),
    [signals]
  );

  /** Plot markers whenever the signal set OR accuracy tier changes.
   *
   *  Critical UX rule: if the composer has been MEASURED to lose on this
   *  symbol (win rate < 45% on ≥3 resolved trades, OR negative average
   *  expectancy), we DO NOT draw the BUY/SELL arrows in their normal
   *  bright colours — that would contradict the AVOID banner below the
   *  chart. We either hide them entirely (negative expectancy) or render
   *  them in a desaturated grey so the user sees them as historical
   *  context rather than a tradeable call.
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (actionable.length === 0) {
      try { series.setMarkers([]); } catch { /* */ }
      return;
    }

    // Decide marker styling tier from the measured accuracy.
    // We ALWAYS show markers now — hiding them entirely was misleading
    // (the engine still fired the signal, the user should see it). Bad
    // tiers get desaturated colors + a warning label so they're clearly
    // historical context, not a tradeable call.
    type Tier = "live" | "muted" | "weak" | "losing";
    const tier: Tier = (() => {
      if (!accuracy) return "live";
      if (accuracy.resolved_signals < 3) return "muted";   // tiny sample
      if (accuracy.win_rate_pct < 45) return "losing";     // composer loses on this symbol
      if (accuracy.avg_per_trade_pct < 0) return "weak";   // 50/50 wins but losers bigger
      if (accuracy.win_rate_pct < 55) return "muted";      // coin flip
      return "live";
    })();

    const TIER_STYLE = {
      live:   { buy: "#00C853", sell: "#FF1744", size: 2, suffix: "" },
      muted:  { buy: "#94a3b8", sell: "#94a3b8", size: 1, suffix: " (weak edge)" },
      weak:   { buy: "#f59e0b", sell: "#f59e0b", size: 1, suffix: " (-EV)" },
      losing: { buy: "#7c2d12", sell: "#7c2d12", size: 1, suffix: " (LOSING)" },
    }[tier];

    const sigMarkers: SeriesMarker<Time>[] = actionable.map((s) => {
      const isBuy = s.signal === "BUY";
      const confPct = Math.round((s.composite_confidence ?? 0) * 100);
      return {
        time: Math.floor(s.t / 1000) as UTCTimestamp,
        position: isBuy ? "belowBar" : "aboveBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? TIER_STYLE.buy : TIER_STYLE.sell,
        size: TIER_STYLE.size,
        // Pattern name on the marker so the user can read at a glance
        // WHAT setup the engine matched — not just the direction.
        text: s.pattern
          ? `${prettyPattern(s.pattern)} · ${s.signal} ${confPct}%${TIER_STYLE.suffix}`
          : `${s.signal} ${confPct}%${TIER_STYLE.suffix}`,
      };
    });

    // Candlestick pattern markers — separate layer, merged at setMarkers
    // time because lightweight-charts only supports one markers array per
    // series. BULL patterns sit below the bar (blue ●), BEAR above (orange ●),
    // NEUTRAL on top (grey ○).
    const candleMarkers: SeriesMarker<Time>[] = showCandlePatterns
      ? candlePatterns.map((p) => {
          const isBull = p.bias === "BULL";
          const isBear = p.bias === "BEAR";
          return {
            time: Math.floor(p.t / 1000) as UTCTimestamp,
            position: isBull ? "belowBar" : isBear ? "aboveBar" : "inBar",
            shape: isBull ? "circle" : isBear ? "circle" : "square",
            color: isBull ? "#3b82f6" : isBear ? "#f97316" : "#94a3b8",
            size: 1,
            text: p.name,
          };
        })
      : [];

    const merged = [...candleMarkers, ...sigMarkers]
      .sort((a, b) => (a.time as number) - (b.time as number));
    try { series.setMarkers(merged); } catch { /* */ }
  }, [actionable, accuracy, candlePatterns, showCandlePatterns]);

  // ── Setup lines for the latest BUY/SELL ────────────────────────────────
  // Draws entry / stop / target as horizontal price lines on the candle
  // series, labelled with the pattern name. Tracks the IPriceLine handles
  // so we can detach them cleanly before drawing the next setup.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Tear down any previously drawn setup lines.
    for (const ln of setupLinesRef.current) {
      try { series.removePriceLine(ln); } catch { /* */ }
    }
    setupLinesRef.current = [];

    if (!actionable.length) return;
    const latestSig = [...actionable].sort((a, b) => b.bar_index - a.bar_index)[0];
    if (!latestSig) return;
    const tag = latestSig.pattern ? prettyPattern(latestSig.pattern) : latestSig.signal;
    const isBuy = latestSig.signal === "BUY";
    const lines: IPriceLine[] = [];

    if (latestSig.entry_price != null) {
      lines.push(series.createPriceLine({
        price: latestSig.entry_price,
        color: isBuy ? "#3b82f6" : "#3b82f6",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `${tag} · ENTRY ${latestSig.entry_price.toFixed(2)}`,
      }));
    }
    if (latestSig.target_price != null) {
      lines.push(series.createPriceLine({
        price: latestSig.target_price,
        color: "#16c784",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `TP ${latestSig.target_price.toFixed(2)}`,
      }));
    }
    if (latestSig.stop_loss != null) {
      lines.push(series.createPriceLine({
        price: latestSig.stop_loss,
        color: "#ea3943",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `SL ${latestSig.stop_loss.toFixed(2)}`,
      }));
    }
    setupLinesRef.current = lines;
  }, [actionable]);

  const latest = actionable.length > 0
    ? [...actionable].sort((a, b) => b.bar_index - a.bar_index)[0]
    : null;

  return (
    <div className="bg-bg-panel border border-bg-border rounded-xl overflow-hidden">
      {/* Header + controls */}
      <div className="px-4 py-3 border-b border-bg-border flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 mr-auto">
          <Zap className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
            Power Analysis
          </h3>
          <span className="text-[10px] text-slate-500">
            PPS + Strategy + Composite + ML (when trained)
          </span>
        </div>

        {/* Symbol picker */}
        <select
          value={symbol}
          onChange={(e) => onSymbolChange?.(e.target.value)}
          className="bg-bg-bg/60 border border-bg-border rounded px-2 py-1 text-xs text-slate-200"
        >
          {SYMBOL_UNIVERSE.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        {/* Timeframe */}
        <div className="flex bg-bg-bg/60 rounded border border-bg-border p-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.id}
              onClick={() => setTimeframe(tf.id)}
              className={clsx(
                "px-2.5 py-1 text-[11px] rounded transition-colors",
                timeframe === tf.id ? "bg-accent-info text-white" : "text-slate-300 hover:bg-bg-border/50"
              )}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {/* Mode toggle */}
        <div className="flex bg-bg-bg/60 rounded border border-bg-border p-0.5">
          {(["strict", "loose"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                "px-2.5 py-1 text-[11px] rounded transition-colors capitalize",
                mode === m ? "bg-amber-500/30 text-amber-200" : "text-slate-300 hover:bg-bg-border/50"
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Risk-envelope mode + R-target selector. When "Fixed %" is on,
            every signal uses the same stop% + target%; otherwise the
            R-multiple target gets applied to ATR-derived stops. */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setUseFixedRisk((v) => !v)}
            className={clsx(
              "px-2.5 py-1 text-[11px] rounded border transition-colors",
              useFixedRisk
                ? "bg-accent-buy/20 text-accent-buy border-accent-buy/40"
                : "bg-bg-bg/60 text-slate-400 border-bg-border hover:bg-bg-border/50",
            )}
            title="Fixed % stop and target on every signal (overrides ATR envelope)"
          >
            {useFixedRisk ? "✓ Fixed %" : "Fixed %"}
          </button>
          {useFixedRisk ? (
            <>
              <label className="flex items-center gap-1 text-[11px] text-slate-400">
                Stop
                <input
                  type="number" min={0.1} max={20} step={0.1}
                  value={stopPct}
                  onChange={(e) => setStopPct(Math.max(0.1, Math.min(20, Number(e.target.value) || 0.1)))}
                  className="w-12 bg-bg-bg/60 border border-bg-border rounded px-1.5 py-0.5 text-[11px] text-slate-100"
                />%
              </label>
              <label className="flex items-center gap-1 text-[11px] text-slate-400">
                Target
                <input
                  type="number" min={0.1} max={30} step={0.1}
                  value={targetPct}
                  onChange={(e) => setTargetPct(Math.max(0.1, Math.min(30, Number(e.target.value) || 0.1)))}
                  className="w-12 bg-bg-bg/60 border border-bg-border rounded px-1.5 py-0.5 text-[11px] text-slate-100"
                />%
              </label>
              <span className="text-[10px] text-slate-500 font-mono" title="Reward:risk ratio">
                {(targetPct / Math.max(stopPct, 0.01)).toFixed(2)}:1
              </span>
            </>
          ) : (
            <div
              className="flex bg-bg-bg/60 rounded border border-bg-border p-0.5"
              title="Target = N × risk distance. 4R typically ≈ 4% gain per win."
            >
              {[2, 3, 4].map((r) => (
                <button
                  key={r}
                  onClick={() => setTargetR(r)}
                  className={clsx(
                    "px-2.5 py-1 text-[11px] rounded transition-colors",
                    targetR === r ? "bg-accent-buy/25 text-accent-buy" : "text-slate-300 hover:bg-bg-border/50",
                  )}
                >
                  {r}R
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Indicator overlay toggle */}
        <button
          onClick={() => setShowIndicators((v) => !v)}
          className={clsx(
            "px-2.5 py-1 text-[11px] rounded border transition-colors",
            showIndicators
              ? "bg-violet-500/20 text-violet-200 border-violet-500/40 hover:bg-violet-500/30"
              : "bg-bg-bg/60 text-slate-400 border-bg-border hover:bg-bg-border/50",
          )}
          title="Toggle SMA-40 / SMA-18 / Bollinger Bands overlay"
        >
          {showIndicators ? "✓ Indicators" : "Indicators"}
        </button>

        {/* ML head toggle — when on, ai-service auto-trains a per-symbol
            ensemble (~3 s first run) and adds its vote to the composer. */}
        <button
          onClick={() => setUseMl((v) => !v)}
          className={clsx(
            "px-2.5 py-1 text-[11px] rounded border transition-colors",
            useMl
              ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40 hover:bg-emerald-500/30"
              : "bg-bg-bg/60 text-slate-400 border-bg-border hover:bg-bg-border/50",
          )}
          title="Include ML head vote (auto-trains per-symbol GBM+RF+MLP ensemble)"
        >
          {useMl ? "✓ ML" : "ML"}
        </button>

        {/* Candlestick pattern overlay — Hammer / Doji / Engulfing / etc. */}
        <button
          onClick={() => setShowCandlePatterns((v) => !v)}
          className={clsx(
            "px-2.5 py-1 text-[11px] rounded border transition-colors",
            showCandlePatterns
              ? "bg-sky-500/20 text-sky-200 border-sky-500/40 hover:bg-sky-500/30"
              : "bg-bg-bg/60 text-slate-400 border-bg-border hover:bg-bg-border/50",
          )}
          title="Show classical candlestick patterns (Hammer, Doji, Engulfing, Morning Star, …)"
        >
          {showCandlePatterns ? `✓ Candles${candlePatterns.length ? ` (${candlePatterns.length})` : ""}` : "Candles"}
        </button>

        {/* Chart pattern overlay — Double Top / H&S / Wedge / Diamond / Bump-Run / … */}
        <button
          onClick={() => setShowChartPatterns((v) => !v)}
          className={clsx(
            "px-2.5 py-1 text-[11px] rounded border transition-colors",
            showChartPatterns
              ? "bg-rose-500/20 text-rose-200 border-rose-500/40 hover:bg-rose-500/30"
              : "bg-bg-bg/60 text-slate-400 border-bg-border hover:bg-bg-border/50",
          )}
          title="Draw classical chart patterns (Double Top, H&S, Wedge, Diamond, …) with their neckline / support / resistance lines"
        >
          {showChartPatterns ? `✓ Patterns${chartPatterns.length ? ` (${chartPatterns.length})` : ""}` : "Patterns"}
        </button>

        {/* Live mode toggle — when ON, subscribe to WS and auto re-run
            on every new bar close. OFF (default) = manual mode. */}
        <button
          onClick={() => setLiveMode((v) => !v)}
          className={clsx(
            "px-2.5 py-1 text-[11px] rounded border transition-colors flex items-center gap-1",
            liveMode
              ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40 hover:bg-emerald-500/30"
              : "bg-bg-bg/60 text-slate-400 border-bg-border hover:bg-bg-border/50",
          )}
          title="Live: subscribe to WebSocket candle stream and auto re-run analysis on every bar close"
        >
          <span className={clsx(
            "inline-block w-1.5 h-1.5 rounded-full",
            liveMode ? "bg-emerald-300 animate-pulse" : "bg-slate-500",
          )} />
          {liveMode ? "LIVE" : "Live"}
        </button>

        {/* Run button — the main affordance */}
        <button
          onClick={() => runPower(false)}
          disabled={running || loadingOhlcv || candlesRef.current.length === 0}
          className={clsx(
            "px-3 py-1.5 rounded text-xs font-semibold border transition-colors",
            "bg-amber-500/20 text-amber-200 border-amber-500/40 hover:bg-amber-500/30",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {running ? "Analysing…" : "⚡ Run Power Analysis"}
        </button>
      </div>

      {/* Live-mode status strip — only when LIVE is on. */}
      {liveMode && (
        <div className="px-4 py-1.5 bg-emerald-500/5 border-b border-emerald-500/20 text-[10px] text-emerald-200/80 font-mono flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
          <span>{liveStatus || "live — waiting for next bar close"}</span>
        </div>
      )}

      {/* Measured-accuracy banner — only shown after a Run. The single
          most important thing on this page: the REAL win rate the
          composer just achieved on this symbol's historical bars. */}
      {accuracy && (
        <AccuracyBanner accuracy={accuracy} symbol={symbol} mode={mode} />
      )}

      {/* Chart */}
      <div className="relative" style={{ height: 420 }}>
        {/* Edge warning overlay — sits over the chart whenever the
            composer's measured edge on THIS symbol is weak or negative.
            Markers are still drawn (so the user sees what the engine
            thought), but in muted / warning colours. The banner here
            explains *why* they aren't bright green/red. */}
        {accuracy && accuracy.resolved_signals >= 3 &&
         (accuracy.win_rate_pct < 55 || accuracy.avg_per_trade_pct < 0) && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <div className={clsx(
              "px-3 py-1.5 rounded-md backdrop-blur-sm shadow-lg",
              accuracy.win_rate_pct < 45
                ? "bg-accent-sell/20 border border-accent-sell/50"
                : "bg-amber-500/20 border border-amber-500/50",
            )}>
              <span className={clsx(
                "text-[11px] font-bold tracking-wider uppercase",
                accuracy.win_rate_pct < 45 ? "text-accent-sell" : "text-amber-200",
              )}>
                {accuracy.win_rate_pct < 45
                  ? `⚠ Arrows are HISTORICAL LOSERS — composer loses on ${symbol}`
                  : `⚠ Arrows muted — weak edge on ${symbol} (${accuracy.win_rate_pct.toFixed(0)}% win rate, ${accuracy.avg_per_trade_pct >= 0 ? "+" : ""}${accuracy.avg_per_trade_pct.toFixed(2)}% avg)`}
              </span>
            </div>
          </div>
        )}
        {/* Indicator + candlestick legend — top-left. */}
        {(showIndicators || (showCandlePatterns && candlePatterns.length > 0)) && (
          <div className="absolute top-2 left-2 z-10 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] font-mono bg-bg-panel-solid/60 backdrop-blur-sm border border-bg-border rounded px-2 py-1 pointer-events-none max-w-[480px]">
            {showIndicators && <>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#fbbf24]"/>SMA-40</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#60a5fa]"/>SMA-18</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 border-t border-dashed border-[#a78bfa]"/>Bollinger(20,2)</span>
            </>}
            {showCandlePatterns && candlePatterns.length > 0 && <>
              <span className="text-slate-500">·</span>
              <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[#3b82f6]"/>Bull candle</span>
              <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[#f97316]"/>Bear candle</span>
              <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 bg-[#94a3b8]"/>Neutral</span>
            </>}
            {showChartPatterns && chartPatterns.length > 0 && <>
              <span className="text-slate-500">·</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#16c784]"/>Bull pattern</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#ea3943]"/>Bear pattern</span>
            </>}
          </div>
        )}
        {(loadingOhlcv || running) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-bg/60 backdrop-blur-sm">
            <span className="text-xs text-slate-400 animate-pulse">
              {loadingOhlcv ? "Loading candles…" : "Running super-composer…"}
            </span>
          </div>
        )}
        {error && !loadingOhlcv && !running && (
          <div className="absolute top-2 left-2 right-2 z-10 px-3 py-2 bg-accent-sell/10 border border-accent-sell/40 rounded text-xs text-accent-sell">
            {error}
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0" />
      </div>

      {/* Summary + latest-signal strip */}
      <div className="px-4 py-3 border-t border-bg-border grid grid-cols-2 md:grid-cols-5 gap-3">
        <SumCell label="Signals" value={String(summary?.total_signals ?? "—")} />
        <SumCell label="BUY" value={String(summary?.buy_count ?? "—")} tone="text-accent-buy" />
        <SumCell label="SELL" value={String(summary?.sell_count ?? "—")} tone="text-accent-sell" />
        <SumCell label="Avg conf" value={summary ? `${(summary.avg_confidence * 100).toFixed(0)}%` : "—"} />
        <SumCell
          label="Latest"
          value={latest ? `${latest.signal} · ${Math.round((latest.composite_confidence ?? 0) * 100)}%` : "—"}
          tone={latest?.signal === "BUY" ? "text-accent-buy" : latest?.signal === "SELL" ? "text-accent-sell" : ""}
        />
      </div>

      {/* Signal sources & latest-signal breakdown */}
      <SourcesAndBreakdown latest={latest} useMl={useMl} />

      {/* Honest-warning footer */}
      <div className="px-4 py-2 border-t border-bg-border text-[10px] text-slate-500 leading-relaxed">
        <strong className="text-slate-400">Strict</strong> = majority of active sources agree (allow 1 dissent) + composite ≥ 0.60.
        <strong className="text-slate-400"> Loose</strong> = ≥ 2 sources + composite ≥ 0.55.
        Past patterns do not predict future returns — verify each signal independently before risking capital.
      </div>
    </div>
  );
}

/** Humanise a pattern key for display on a chart marker / price-line label.
 *  Examples: "ascending_triangle" → "Asc Triangle", "bull_flag" → "Bull Flag".
 *  Long names get abbreviated so they fit on a 200-px marker.
 */
function prettyPattern(p: string): string {
  if (!p) return "";
  if (p === "rule_based") return "Rule Setup";
  const map: Record<string, string> = {
    ascending_triangle:        "Asc Triangle",
    descending_triangle:       "Desc Triangle",
    symmetrical_triangle:      "Sym Triangle",
    head_and_shoulders:        "H&S Top",
    inverse_head_and_shoulders:"H&S Bottom",
    rounding_bottom:           "Round Bottom",
    rounding_top:              "Round Top",
    double_top:                "Double Top",
    double_bottom:             "Double Bot",
    triple_top:                "Triple Top",
    triple_bottom:             "Triple Bot",
    bull_flag:                 "Bull Flag",
    bear_flag:                 "Bear Flag",
    bull_pennant:              "Bull Pennant",
    bear_pennant:              "Bear Pennant",
    rising_wedge:              "Rising Wedge",
    falling_wedge:             "Falling Wedge",
    rectangle:                 "Rectangle",
    diamond_top:               "Diamond Top",
    diamond_bottom:            "Diamond Bot",
    horizontal_channel:        "H-Channel",
    bullish_island_reversal:   "Bull Island",
    bearish_island_reversal:   "Bear Island",
  };
  return map[p] ?? p.split("_").map((s) => s[0].toUpperCase() + s.slice(1)).join(" ");
}

/** Compute the indicator overlay series from raw OHLCV candles.
 *
 *  Returns the four line series the chart consumes — SMA-40 (PPS slow
 *  trend), SMA-18 (PPS fast trend), and Bollinger upper/mid/lower at
 *  the standard (20, 2σ) settings used by the Strategy layer.
 */
function computeIndicatorLines(candles: Array<{ t: number; c: number }>) {
  const ts = candles.map((c) => Math.floor(c.t / 1000) as UTCTimestamp);
  const closes = candles.map((c) => c.c);
  const sma = (p: number) => rollingMean(closes, p);
  const std = (p: number) => rollingStd(closes, p);
  const sma40 = sma(40);
  const sma18 = sma(18);
  const sma20 = sma(20);
  const std20 = std(20);
  const bbUpper: Array<{ time: UTCTimestamp; value: number }> = [];
  const bbLower: Array<{ time: UTCTimestamp; value: number }> = [];
  const bbMid:   Array<{ time: UTCTimestamp; value: number }> = [];
  for (let i = 0; i < closes.length; i++) {
    const m = sma20[i]; const s = std20[i];
    if (m != null && s != null) {
      bbUpper.push({ time: ts[i], value: m + 2 * s });
      bbLower.push({ time: ts[i], value: m - 2 * s });
      bbMid  .push({ time: ts[i], value: m });
    }
  }
  const lineFrom = (arr: Array<number | null>) =>
    arr.flatMap((v, i) => v == null ? [] : [{ time: ts[i], value: v }]);
  return {
    sma40:   lineFrom(sma40),
    sma18:   lineFrom(sma18),
    bbUpper, bbLower, bbMid,
  };
}

function rollingMean(xs: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(xs.length).fill(null);
  if (period <= 0 || xs.length < period) return out;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= period) sum -= xs[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rollingStd(xs: number[], period: number): Array<number | null> {
  const means = rollingMean(xs, period);
  const out: Array<number | null> = new Array(xs.length).fill(null);
  for (let i = period - 1; i < xs.length; i++) {
    const m = means[i]!;
    let s2 = 0;
    for (let j = i - period + 1; j <= i; j++) s2 += (xs[j] - m) ** 2;
    out[i] = Math.sqrt(s2 / period);
  }
  return out;
}

function SumCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("font-mono text-sm", tone || "text-slate-200")}>{value}</div>
    </div>
  );
}

/**
 * Show WHAT the composer is fusing — the four signal sources and their
 * weights — and, for the most recent BUY/SELL, the per-source vote
 * breakdown so the user can see exactly why the engine called it.
 *
 * Source weights mirror SOURCE_WEIGHT in ai-service/power_analysis.py.
 */
const POWER_SOURCES: Array<{
  key: string;
  label: string;
  desc: string;
  weight: number;
  indicators: string[];
}> = [
  {
    key: "pps",
    label: "PPS Engine",
    desc: "Pattern Probability + 40/18 SMA trend filter",
    weight: 1.0,
    indicators: ["Chart patterns", "SMA-40", "SMA-18", "Pattern conf %"],
  },
  {
    key: "strategy",
    label: "Strategy Layer",
    desc: "Classical TA: RSI, MACD, ADX, Bollinger, ATR",
    weight: 0.8,
    indicators: ["RSI-14", "MACD(12,26,9)", "ADX-14", "Bollinger(20,2)", "ATR-14"],
  },
  {
    key: "composite",
    label: "Composite Layers",
    desc: "Mean reversion + momentum + breakout fused",
    weight: 0.6,
    indicators: ["Z-score MR", "Donchian breakout", "Multi-TF momentum"],
  },
  {
    key: "ml",
    label: "ML Head",
    desc: "Calibrated GBM (only when trained on this symbol)",
    weight: 0.7,
    indicators: ["sklearn GBM", "isotonic calibration", "feature drift check"],
  },
];

function SourcesAndBreakdown({ latest, useMl }: { latest: PowerSignal | null; useMl: boolean }) {
  return (
    <div className="px-4 py-3 border-t border-bg-border space-y-3">
      {/* ── What's running ──────────────────────────────────────────── */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
          Signal sources fused by Power Analysis
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {POWER_SOURCES.map((s) => {
            const active = s.key !== "ml" || useMl;
            return (
              <div
                key={s.key}
                className={clsx(
                  "rounded border p-2 transition-colors",
                  active ? "border-bg-border bg-bg-elevated/30" : "border-bg-border/50 bg-bg-elevated/10 opacity-50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={clsx(
                      "h-1.5 w-1.5 rounded-full shrink-0",
                      active ? "bg-accent-buy animate-pulse" : "bg-slate-600",
                    )} />
                    <span className="text-xs font-semibold text-slate-200 truncate">{s.label}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 shrink-0">
                    weight {s.weight.toFixed(1)}
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">{s.desc}</div>
                <div className="text-[9px] font-mono text-slate-500 mt-1 truncate">
                  {s.indicators.join(" · ")}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Latest-signal vote breakdown ───────────────────────────── */}
      {latest && (latest.signal === "BUY" || latest.signal === "SELL") && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
            Latest signal vote breakdown
          </div>
          <div className={clsx(
            "rounded border p-2.5",
            latest.signal === "BUY"
              ? "border-accent-buy/30 bg-accent-buy/5"
              : "border-accent-sell/30 bg-accent-sell/5",
          )}>
            <div className="flex items-baseline justify-between mb-2">
              <div>
                <span className={clsx(
                  "text-sm font-bold tracking-wider",
                  latest.signal === "BUY" ? "text-accent-buy" : "text-accent-sell",
                )}>
                  {latest.signal}
                </span>
                {latest.pattern && (
                  <span className="text-[10px] text-slate-400 ml-2 font-mono">
                    via {latest.pattern}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-400">
                <span className="text-slate-200 font-mono">
                  {Math.round((latest.composite_confidence ?? 0) * 100)}%
                </span> composite
                {latest.agreement_count != null && latest.active_sources != null && (
                  <> · <span className="text-slate-200 font-mono">
                    {latest.agreement_count}/{latest.active_sources}
                  </span> sources agreed</>
                )}
              </div>
            </div>

            {/* Per-source votes */}
            {latest.votes && latest.votes.length > 0 && (
              <div className="space-y-1">
                {latest.votes.map((v, i) => {
                  const isBuy = v.direction === "BUY";
                  const isSell = v.direction === "SELL";
                  const pct = Math.min(100, Math.round(v.confidence * 100));
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <div className="w-20 text-[10px] text-slate-300 capitalize truncate">
                        {v.strategy}
                      </div>
                      <div className="flex-1 h-1.5 bg-slate-800/60 rounded overflow-hidden">
                        <div
                          className={clsx(
                            "h-full",
                            isBuy && "bg-accent-buy",
                            isSell && "bg-accent-sell",
                            !isBuy && !isSell && "bg-slate-500",
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className={clsx(
                        "w-14 text-[10px] font-mono text-right tabular-nums",
                        isBuy && "text-accent-buy",
                        isSell && "text-accent-sell",
                        !isBuy && !isSell && "text-slate-400",
                      )}>
                        {v.direction} {pct}%
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Trade levels — only if engine returned them */}
            {(latest.entry_price != null || latest.stop_loss != null || latest.target_price != null) && (
              <div className="grid grid-cols-4 gap-2 pt-2 mt-2 border-t border-bg-border/40 text-[10px] font-mono">
                <div>
                  <div className="text-slate-500 uppercase text-[9px]">Entry</div>
                  <div className="text-slate-100">{latest.entry_price?.toFixed(2) ?? "—"}</div>
                </div>
                <div>
                  <div className="text-slate-500 uppercase text-[9px]">Stop</div>
                  <div className="text-accent-sell">{latest.stop_loss?.toFixed(2) ?? "—"}</div>
                </div>
                <div>
                  <div className="text-slate-500 uppercase text-[9px]">Target</div>
                  <div className="text-accent-buy">{latest.target_price?.toFixed(2) ?? "—"}</div>
                </div>
                <div>
                  <div className="text-slate-500 uppercase text-[9px]">R:R</div>
                  <div className="text-slate-100">{latest.risk_reward?.toFixed(2) ?? "—"}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Stage + Master Confluence summary cards ──────────────────────
          Two side-by-side cards giving the user the "why" behind the
          signal: Weinstein stage classification and the TIER 1-4 scoring
          engine's reasons. */}
      {latest && (latest.stage || latest.master_confluence) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Stage Analysis card */}
          {latest.stage && (
            <StageCard stage={latest.stage} capApplied={!!latest.stage_cap_applied} />
          )}
          {/* Master Confluence card */}
          {latest.master_confluence && (
            <MasterConfluenceCard mc={latest.master_confluence} />
          )}
        </div>
      )}
    </div>
  );
}

/** Stage Analysis card — colour-coded by Weinstein stage. */
function StageCard({
  stage,
  capApplied,
}: {
  stage: NonNullable<PowerSignal["stage"]>;
  capApplied: boolean;
}) {
  const s = stage.current_stage ?? 0;
  const palette = {
    1: { bg: "bg-amber-500/10",   border: "border-amber-500/40",   text: "text-amber-300" },
    2: { bg: "bg-accent-buy/10",  border: "border-accent-buy/40",  text: "text-accent-buy" },
    3: { bg: "bg-orange-500/10",  border: "border-orange-500/40",  text: "text-orange-300" },
    4: { bg: "bg-accent-sell/10", border: "border-accent-sell/40", text: "text-accent-sell" },
    0: { bg: "bg-slate-700/20",   border: "border-slate-600",      text: "text-slate-400"   },
  }[s as 0 | 1 | 2 | 3 | 4] || { bg: "bg-slate-700/20", border: "border-slate-600", text: "text-slate-400" };
  return (
    <div className={clsx("rounded border p-3", palette.bg, palette.border)}>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">
          Weinstein Stage
        </div>
        {capApplied && (
          <div className="text-[9px] uppercase tracking-wider text-amber-300/80 font-mono">
            cap @ 0.40
          </div>
        )}
      </div>
      <div className={clsx("text-2xl font-mono font-semibold", palette.text)}>
        {s || "—"}
      </div>
      <div className={clsx("text-[11px] mt-1 leading-snug", palette.text)}>
        {stage.stage_label ?? "—"}
      </div>
      {stage.warning && (
        <div className="text-[10px] text-slate-400 mt-2 leading-snug">{stage.warning}</div>
      )}
    </div>
  );
}

/** Master Confluence summary card — score, signal, top reasons. */
function MasterConfluenceCard({
  mc,
}: {
  mc: NonNullable<PowerSignal["master_confluence"]>;
}) {
  const score = mc.confluence_score ?? 0;
  const sig = mc.signal ?? "NO_TRADE";
  const tone =
    score >= 40 ? "text-accent-buy" :
    score >= 28 ? "text-amber-300" :
    score >= 15 ? "text-slate-300" :
    "text-slate-500";
  const sigBg =
    sig === "STRONG_BUY"  ? "bg-accent-buy/20 text-accent-buy" :
    sig === "BUY"         ? "bg-accent-buy/15 text-accent-buy" :
    sig === "STRONG_SELL" ? "bg-accent-sell/20 text-accent-sell" :
    sig === "SELL"        ? "bg-accent-sell/15 text-accent-sell" :
    sig === "WATCH"       ? "bg-amber-500/15 text-amber-300" :
    "bg-slate-700/30 text-slate-400";
  return (
    <div className="rounded border border-bg-border bg-bg-bg/40 p-3">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">
          Master Confluence
        </div>
        {mc.institutional_footprint && (
          <div className="text-[9px] uppercase tracking-wider text-violet-300/80 font-mono">
            inst. ★
          </div>
        )}
      </div>
      <div className="flex items-baseline gap-3 mb-2">
        <div className={clsx("text-2xl font-mono font-semibold", tone)}>
          {score.toFixed(0)}
          <span className="text-xs text-slate-500 font-normal ml-1">/100</span>
        </div>
        <div className={clsx("text-[10px] font-bold tracking-wider px-2 py-0.5 rounded", sigBg)}>
          {sig}
        </div>
      </div>
      {mc.top_reasons && mc.top_reasons.length > 0 ? (
        <ul className="space-y-0.5 text-[10px] text-slate-300 leading-snug">
          {mc.top_reasons.slice(0, 3).map((r, i) => (
            <li key={i} className="flex items-baseline gap-1">
              <span className="text-slate-500">→</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[10px] text-slate-500 italic">No confluence reasons recorded.</div>
      )}
    </div>
  );
}

/**
 * The honesty banner. Shown only after a Power Analysis run.
 * Colour-coded so the user can see at a glance whether THIS symbol is
 * one they should trade with this composer.
 *
 *   ≥ 70 %  → green     ("strong measured edge")
 *   55–69 % → amber     ("real edge, trade modestly")
 *   45–54 % → slate     ("coin flip — composer has no edge here")
 *   < 45 %  → red       ("composer LOSES on this symbol — avoid")
 */
function AccuracyBanner({
  accuracy,
  symbol,
  mode,
}: {
  accuracy: PowerAccuracy;
  symbol: string;
  mode: PowerMode;
}) {
  const wr = accuracy.win_rate_pct;
  const resolved = accuracy.resolved_signals;

  const tier =
    resolved < 3 ? "tiny" :
    wr >= 70 ? "strong" :
    wr >= 55 ? "real" :
    wr >= 45 ? "coinflip" :
    "negative";

  const styles = {
    strong:   { bg: "bg-accent-buy/10",  border: "border-accent-buy/40",  text: "text-accent-buy",  label: "STRONG MEASURED EDGE" },
    real:     { bg: "bg-amber-500/10",   border: "border-amber-500/40",   text: "text-amber-300",   label: "REAL EDGE — TRADE MODESTLY" },
    coinflip: { bg: "bg-slate-700/30",   border: "border-slate-600",      text: "text-slate-300",   label: "NO MEASURED EDGE — COIN FLIP" },
    negative: { bg: "bg-accent-sell/10", border: "border-accent-sell/40", text: "text-accent-sell", label: "COMPOSER LOSES ON THIS SYMBOL — AVOID" },
    tiny:     { bg: "bg-slate-700/30",   border: "border-slate-600",      text: "text-slate-400",   label: "INSUFFICIENT SAMPLE — NEED MORE SIGNALS" },
  }[tier];

  const profitable = accuracy.total_return_pct > 0;
  const expectancyPositive = accuracy.avg_per_trade_pct > 0;

  return (
    <div className={clsx("px-4 py-3 border-t", styles.border, styles.bg)}>
      <div className="flex flex-wrap items-baseline gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            Measured win rate ({symbol} · {mode} · 15-bar horizon)
          </div>
          <div className={clsx("text-2xl font-mono font-semibold", styles.text)}>
            {wr.toFixed(1)}%
            <span className="text-xs text-slate-400 font-normal ml-2">
              {accuracy.wins}W / {accuracy.losses}L on {resolved} resolved trades
            </span>
          </div>
          <div className={clsx("text-[11px] font-semibold mt-1 tracking-wider", styles.text)}>
            {styles.label}
          </div>
        </div>

        <div className="ml-auto grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-1">
          <Stat label="Avg win" value={`${accuracy.avg_win_pct >= 0 ? "+" : ""}${accuracy.avg_win_pct.toFixed(2)}%`} tone="text-accent-buy" />
          <Stat label="Avg loss" value={`${accuracy.avg_loss_pct.toFixed(2)}%`} tone="text-accent-sell" />
          <Stat label="Avg/trade" value={`${expectancyPositive ? "+" : ""}${accuracy.avg_per_trade_pct.toFixed(2)}%`} tone={expectancyPositive ? "text-accent-buy" : "text-accent-sell"} />
          <Stat label="Total return" value={`${profitable ? "+" : ""}${accuracy.total_return_pct.toFixed(1)}%`} tone={profitable ? "text-accent-buy" : "text-accent-sell"} />
        </div>
      </div>

      {/* Hard honest footer */}
      <div className="mt-2 pt-2 border-t border-bg-border/50 text-[10px] text-slate-500 leading-relaxed">
        {resolved < 3 ? (
          <>Sample too small to draw any conclusion. Run on a different timeframe or symbol with more history.</>
        ) : tier === "negative" ? (
          <>This is a measured loss, not noise. Do NOT trade the BUY/SELL arrows on this chart. Switch to a symbol with positive measured edge.</>
        ) : tier === "coinflip" ? (
          <>This composer has no demonstrable edge on this symbol. Trading these signals is gambling, not strategy.</>
        ) : (
          <>{accuracy.honest_note} The {accuracy.unresolved_signals} most-recent signals are unresolved (need ≥15 forward bars to score) — they're plotted but not counted.</>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("font-mono text-xs", tone || "text-slate-200")}>{value}</div>
    </div>
  );
}
