import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  createChart,
  ColorType,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  LineStyle,
} from "lightweight-charts";
import {
  detectPatternsLive,
  fetchPatternConsensus,
  fetchPatternOhlcv,
  type PatternChartTimeframe,
  type PatternConsensusResponse,
  type PatternDoc,
  type PatternTimeframe,
} from "../lib/patternApi";
import { useAuth } from "../store/auth";
import { useMarketSocket, type WsEvent, type WsPatternPayload } from "../lib/socket";
import { getPatternAdvice } from "../lib/patternMetadata";
import { Eye, EyeOff } from "lucide-react";


/**
 * Self-contained live chart that highlights detected patterns the moment
 * they form. Lives on the Pattern Analytics page so the user can watch
 * the engine in action without leaving the dashboard. Owns its own
 * lightweight-charts instance — does NOT plug into the global
 * overlayManager so it can run alongside the main Dashboard chart.
 */

interface TfDef {
  id: PatternChartTimeframe;
  label: string;
  // Pattern detection only supports the four core TFs; chart-only TFs
  // fall back to the nearest supported one for the detector pass.
  detectTf: PatternTimeframe;
}

const TIMEFRAMES: TfDef[] = [
  { id: "M1",  label: "1m",  detectTf: "M1"  },
  { id: "M5",  label: "5m",  detectTf: "M5"  },
  { id: "M15", label: "15m", detectTf: "M15" },
  { id: "M30", label: "30m", detectTf: "M30" },
  { id: "H1",  label: "1h",  detectTf: "H1"  },
  { id: "D1",  label: "1d",  detectTf: "D1"  },
  { id: "Y1",  label: "1y",  detectTf: "D1"  },
];

// How often to poll REST OHLCV as a fallback for symbols the WS feed
// doesn't broadcast (BSE listings, foreign tickers, anything that isn't
// in the dev mock universe). Faster TFs poll harder.
const TF_POLL_MS: Record<PatternChartTimeframe, number> = {
  M1:    5_000,
  M5:   10_000,
  M15:  20_000,
  M30:  30_000,
  H1:   60_000,
  D1:  120_000,
  Y1:  300_000,
};

const SYMBOL_UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
  "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL",
];

interface ActiveOverlay {
  key: string;
  payload: WsPatternPayload;
  priceLines: IPriceLine[];
  trendlineSeries?: ISeriesApi<"Line">;
}

interface Props {
  symbol: string;
  onSymbolChange: (s: string) => void;
}

function dirColor(direction: WsPatternPayload["direction"]): string {
  switch (direction) {
    case "bullish":      return "#16c784";
    case "bearish":      return "#ea3943";
    case "continuation": return "#f59e0b";
    default:             return "#94a3b8";
  }
}

function payloadKey(p: WsPatternPayload): string {
  if (p.patternId) return p.patternId;
  const last = p.candle_indices.length ? p.candle_indices[p.candle_indices.length - 1] : -1;
  return `${p.symbol}:${p.timeframe}:${p.pattern_name}:${last}`;
}

function toPayload(symbol: string, tf: string, p: PatternDoc): WsPatternPayload {
  return {
    patternId: p._id,
    symbol,
    timeframe: tf,
    pattern_name: p.pattern_name,
    category: p.category,
    direction: p.direction,
    confidence: Math.round(p.confidence_score ?? 0),
    grade: p.grade ?? "C",
    candle_indices: p.candle_indices ?? [],
    // The AI service emits trendline times in bar-index units on some
    // codepaths — drop those so we don't try to draw at 1970. Only
    // keep epoch-ms-shaped values (year ≥ 2000).
    trendline_points: (p.trendline_points ?? []).filter((pt) => typeof pt.time === "number" && pt.time > 9.4e11),
    entry: p.entry_price,
    target: p.target_price,
    stop: p.stop_price,
    rr: p.risk_reward,
    ai_explanation: p.ai_explanation,
    detected_at: p.detected_at ? new Date(p.detected_at).getTime() : Date.now(),
  };
}

export default function PatternLiveChart({ symbol, onSymbolChange }: Props) {
  const token = useAuth((s) => s.token);
  const [timeframe, setTimeframe] = useState<PatternChartTimeframe>("D1");
  const [candles, setCandles] = useState<Array<{ t: number; o: number; h: number; l: number; c: number }>>([]);
  const [patterns, setPatterns] = useState<WsPatternPayload[]>([]);
  const [verdict, setVerdict] = useState<PatternConsensusResponse | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [visiblePatternKeys, setVisiblePatternKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlaysRef = useRef<Map<string, ActiveOverlay>>(new Map());
  // Mirror of `candles` that the WS tick handler / REST poller can mutate
  // between renders without triggering one re-render per tick. The chart
  // series itself is the source of truth for what's drawn — this ref just
  // tracks the current bar so successive ticks accumulate (high/low grow
  // through the bar, new bars open at bucket boundaries).
  const candlesRef = useRef<Array<{ t: number; o: number; h: number; l: number; c: number }>>([]);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  // ── Live candle, mirrors DashboardPage exactly ─────────────────────────
  // The Dashboard chart breathes because the backend pushes a fully-formed
  // `candle` event ~4×/sec for every subscribed symbol and the Chart
  // component re-applies it via series.update(). We do the same here.
  const [liveCandle, setLiveCandle] = useState<{ t: number; o: number; h: number; l: number; c: number } | null>(null);
  const lastLiveUpdateRef = useRef(0);

  // Snapshot of the current candle price range. The overlay reconciler
  // reads this to decide whether a pattern's entry/SL/TP belongs on the
  // chart — anything wildly out of range (e.g. pre-split historical
  // prices) is rejected so the y-axis can't be yanked into a 1k-3k
  // span that compresses real candles into a 1-px line.
  const candleRangeRef = useRef<{ min: number; max: number; mid: number; tol: number } | null>(null);

  // Detach every price line + trend-line series from the chart so the
  // y-axis no longer auto-scales to their (possibly-stale) prices.
  // Without this, switching from RELIANCE (₹1300-range) to BHARTIARTL
  // (₹1880-range) leaves the old SL/TP price lines attached to the
  // candlestick series — the y-axis spans 1240→1920 and the real
  // candles render as a flat band at the top. After the user scrolls
  // Lightweight Charts re-fits to visible bars and the chart "fixes
  // itself" — which is exactly what the screenshots showed.
  const clearOverlays = () => {
    const series = seriesRef.current;
    const chart  = chartRef.current;
    if (!series) {
      overlaysRef.current.clear();
      return;
    }
    for (const [, ov] of overlaysRef.current) {
      for (const line of ov.priceLines) {
        try { series.removePriceLine(line); } catch { /* */ }
      }
      if (ov.trendlineSeries && chart) {
        try { chart.removeSeries(ov.trendlineSeries); } catch { /* */ }
      }
    }
    overlaysRef.current.clear();
  };

  // Create chart once.
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
        autoScale: true,
        entireTextOnly: false,
      },
      timeScale: {
        borderColor:   "#1f2a3d",
        timeVisible:   true,
        secondsVisible: false,
        // ── Zoom limits ────────────────────────────────────────────
        // Without these the chart collapses bars into a wick-only
        // line when zoomed out (looks like a continuous line) and
        // overshoots into illegible blobs when zoomed in hard.
        barSpacing:    8,   // initial: comfortable candle width
        minBarSpacing: 5,   // floor — never shrink below 5 px / bar
        rightOffset:   6,   // leave a little space at the right edge
        // Allow horizontal pan + zoom to grab whole bars cleanly
        fixLeftEdge:   false,
        fixRightEdge:  false,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar:    true,
      },
      crosshair: { mode: 1 },
      autoSize:  true,
      // ── Explicit interaction config ──────────────────────────────
      // Defaults *should* enable these, but on macOS trackpads with
      // some Vite/HMR sequences they have been observed to no-op until
      // explicitly turned on. Belt-and-braces.
      handleScroll: {
        mouseWheel:        true,   // mouse-wheel pan
        pressedMouseMove:  true,   // click-and-drag pan
        horzTouchDrag:     true,   // trackpad horizontal swipe
        vertTouchDrag:     true,
      },
      handleScale: {
        mouseWheel:           true,   // ⌘+wheel / pinch via wheel
        pinch:                true,   // trackpad pinch
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      kineticScroll: { touch: true, mouse: false },
    });
    const series = chart.addCandlestickSeries({
      upColor:        "#16c784",
      downColor:      "#ea3943",
      wickUpColor:    "#16c784",
      wickDownColor:  "#ea3943",
      // Render body outlines so the candle bodies remain visible even
      // when the user zooms out tight (otherwise only the 1-px wick
      // shows and the chart looks like a thin line).
      borderVisible:   true,
      borderUpColor:   "#16c784",
      borderDownColor: "#ea3943",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      clearOverlays();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Load candles + run a fresh detection pass whenever symbol/timeframe changes.
  useEffect(() => {
    if (!symbol) return;
    let aborted = false;
    setLoading(true);
    setError(null);
    clearOverlays();   // ← actually detaches price lines from the series
    setPatterns([]);
    setVerdict(null);
    // Force y-axis to forget the old min/max so the new symbol's candles
    // render at a sensible scale immediately (instead of inheriting the
    // previous symbol's price range until the user scrolls).
    try {
      seriesRef.current?.setData([]);
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    } catch { /* */ }

    (async () => {
      // Pull OHLCV from the same yfinance source the detector uses so the
      // candle price range and the pattern's entry/SL/TP land on the same
      // scale (the in-memory mock feed has a different price floor).
      const ohlcv = await fetchPatternOhlcv(symbol, timeframe, 300);
      if (aborted) return;
      const rows = (ohlcv?.candles ?? []).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
      if (rows.length === 0) {
        setError("No data for this symbol / timeframe.");
        setCandles([]);
        try { seriesRef.current?.setData([]); } catch { /* */ }
        setLoading(false);
        return;
      }
      setCandles(rows);
      // Show seconds when the bar size is sub-minute (M1) so labels don't
      // collapse to identical HH:MM stamps for adjacent candles. For Y1
      // weekly bars we don't need time-of-day at all.
      const tf = timeframe;
      try {
        chartRef.current?.applyOptions({
          timeScale: {
            timeVisible: tf === "M1" || tf === "M5" || tf === "M15" || tf === "M30" || tf === "H1",
            secondsVisible: tf === "M1",
            borderColor: "#1f2a3d",
          },
        });
      } catch { /* */ }
      const seriesData: CandlestickData[] = rows.map((c) => ({
        time: Math.floor(c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      }));
      try {
        seriesRef.current?.setData(seriesData);
        // Zoom to the most recent N bars so each candle is readable
        // instead of compressing 300 bars into a thin smear.
        const visibleBars =
          tf === "M1" ? 90  :
          tf === "M5" ? 80  :
          tf === "M15" ? 70 :
          tf === "M30" ? 65 :
          tf === "H1" ? 60  :
          tf === "D1" ? 80  :
                        60; // Y1
        const from = Math.max(0, seriesData.length - visibleBars);
        const to = seriesData.length - 1;
        chartRef.current?.timeScale().setVisibleLogicalRange({ from, to });
      } catch { /* */ }

      // Run pattern detection + consensus aggregation in parallel.
      const tfDef = TIMEFRAMES.find((d) => d.id === tf) ?? TIMEFRAMES[4];
      const [res, cons] = await Promise.all([
        detectPatternsLive(symbol, tfDef.detectTf, 120),
        fetchPatternConsensus(symbol, tfDef.detectTf, 120),
      ]);
      if (aborted) return;
      setVerdict(cons);
      if (!res || !res.patterns) {
        setLoading(false);
        return;
      }
      // Sanity-check pattern prices against the actual candle range so
      // stale rows (e.g. pre-split RELIANCE entries from a DB before a
      // bonus issue) don't yank the y-axis from ~2800 down to ~1300 —
      // which is what was making the chart compress into a thin line
      // and looking like a tiny minute-bar smear after zoom.
      const closes = rows.map((r) => r.c);
      const candleMin = Math.min(...closes);
      const candleMax = Math.max(...closes);
      const candleMid = (candleMin + candleMax) / 2;
      const candleSpan = Math.max(candleMax - candleMin, candleMid * 0.05);
      // Allow overlays up to 30% above/below the candle mid — anything
      // beyond that is almost certainly mis-scaled historical data.
      const TOLERANCE = Math.max(candleSpan * 4, candleMid * 0.3);
      candleRangeRef.current = { min: candleMin, max: candleMax, mid: candleMid, tol: TOLERANCE };
      const inRange = (p?: number | null) =>
        p == null || (Math.abs(p - candleMid) <= TOLERANCE);

      const payloads = res.patterns
        .filter((p) => Number(p.confidence_score ?? 0) >= 35 && p.entry_price != null)
        .filter((p) => inRange(p.entry_price) && inRange(p.target_price) && inRange(p.stop_price))
        .sort((a, b) => Number(b.confidence_score ?? 0) - Number(a.confidence_score ?? 0))
        .slice(0, 4)
        .map((p) => toPayload(symbol, timeframe, p));
      setPatterns(payloads);
      if (payloads[0]) {
        const k = payloadKey(payloads[0]);
        setVisiblePatternKeys(new Set([k]));
        setHighlightKey(k);
        window.setTimeout(() => setHighlightKey((curr) => (curr === k ? null : curr)), 2500);
      } else {
        setVisiblePatternKeys(new Set());
      }
      setLoading(false);
    })();

    return () => {
      aborted = true;
    };
  }, [symbol, timeframe]);

  // Subscribe to the live WebSocket so we light up the chart when the
  // background pattern engine emits a fresh detection for this symbol.
  useMarketSocket({
    token,
    symbols: [symbol].filter(Boolean),
    onEvent: (ev: WsEvent) => {
      // Mirror the Dashboard chart's live-update path exactly: the
      // backend pushes a fully-formed candle ~4×/sec, we drop everything
      // arriving inside a 250 ms window, and feed the rest into
      // setLiveCandle which a useEffect re-applies via series.update().
      if (ev.type === "candle" && ev.candle.symbol === symbol) {
        const now = Date.now();
        if (now - lastLiveUpdateRef.current < 250) return;
        lastLiveUpdateRef.current = now;
        setLiveCandle({
          t: ev.candle.t,
          o: ev.candle.o,
          h: ev.candle.h,
          l: ev.candle.l,
          c: ev.candle.c,
        });
        return;
      }
      if (ev.type === "pattern" || ev.type === "pattern_signal") {
        const payload = ev.pattern as WsPatternPayload;
        if (payload.symbol?.toUpperCase() !== symbol.toUpperCase()) return;
        if (payload.timeframe !== timeframe) return;
        const k = payloadKey(payload);
        setPatterns((curr) => {
          const filtered = curr.filter((p) => payloadKey(p) !== k);
          return [payload, ...filtered].slice(0, 4);
        });
        setVisiblePatternKeys((curr) => {
          const next = new Set(curr);
          next.add(k);
          return next;
        });
        setHighlightKey(k);
        window.setTimeout(() => setHighlightKey((curr) => (curr === k ? null : curr)), 3500);
      }
    },
  });

  // REST polling fallback — keeps the chart breathing for symbols the
  // WS mock feed doesn't broadcast (BSE `.BO` listings, foreign tickers,
  // anything beyond the dev universe). Interval scales with the chart
  // timeframe so we don't hammer the OHLCV endpoint on a daily chart.
  useEffect(() => {
    if (!symbol) return;
    const pollMs = TF_POLL_MS[timeframe];

    const pollOnce = async () => {
      // limit=3 was rejected by the backend Zod schema (min=20); we only
      // need the latest bar but the route enforces a floor for cache
      // efficiency. 20 bars ≈ 1 KB payload — fine for the poll fallback.
      const ohlcv = await fetchPatternOhlcv(symbol, timeframe, 20);
      const series = seriesRef.current;
      if (!ohlcv?.candles?.length || !series) return;
      const last = ohlcv.candles[ohlcv.candles.length - 1];

      // Merge into candlesRef so the WS tick handler sees fresh state
      // and successive ticks accumulate on top of the latest poll.
      const bars = candlesRef.current;
      if (bars.length) {
        const tail = bars[bars.length - 1];
        if (tail.t === last.t) {
          candlesRef.current = [...bars.slice(0, -1), { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c }];
        } else if (last.t > tail.t) {
          candlesRef.current = [...bars, { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c }];
        }
      }

      try {
        series.update({
          time:  Math.floor(last.t / 1000) as UTCTimestamp,
          open:  last.o,
          high:  last.h,
          low:   last.l,
          close: last.c,
        });
      } catch { /* time off-grid */ }
    };

    const id = window.setInterval(pollOnce, pollMs);
    return () => window.clearInterval(id);
  }, [symbol, timeframe]);

  // Apply the live candle to the series — identical to Chart.tsx:110-119
  // which is what makes the Dashboard chart visibly tick.
  useEffect(() => {
    const series = seriesRef.current;
    if (!liveCandle || !series) return;
    try {
      series.update({
        time:  Math.floor(liveCandle.t / 1000) as UTCTimestamp,
        open:  liveCandle.o,
        high:  liveCandle.h,
        low:   liveCandle.l,
        close: liveCandle.c,
      });
    } catch { /* time off-grid */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [liveCandle?.t, liveCandle?.c, liveCandle?.h, liveCandle?.l]);

  // Reset liveCandle whenever the symbol or timeframe changes so we
  // don't apply a stale candle to a fresh series.
  useEffect(() => { setLiveCandle(null); }, [symbol, timeframe]);

  // Reconcile overlays whenever the active pattern list changes.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    const wanted = new Map(
      patterns
        .filter((p) => visiblePatternKeys.has(payloadKey(p)))
        .map((p) => [payloadKey(p), p])
    );

    // Remove overlays whose pattern is no longer in the list or hidden.
    for (const [key, ov] of overlaysRef.current) {
      if (!wanted.has(key)) {
        for (const line of ov.priceLines) {
          try { series.removePriceLine(line); } catch { /* */ }
        }
        if (ov.trendlineSeries) {
          try { chart.removeSeries(ov.trendlineSeries); } catch { /* */ }
        }
        overlaysRef.current.delete(key);
      }
    }

    // Belt-and-braces: even if a stale pattern slipped past the
    // load-time filter, never draw a price line outside the candle
    // range — that's what was distorting the y-axis.
    const range = candleRangeRef.current;
    const inRange = (price: number) =>
      !range || Math.abs(price - range.mid) <= range.tol;

    // Add overlays for new patterns.
    for (const [key, p] of wanted) {
      if (overlaysRef.current.has(key)) continue;
      const color = dirColor(p.direction);
      const priceLines: IPriceLine[] = [];
      const advice = getPatternAdvice(p.pattern_name, p.direction);

      if (p.entry != null && inRange(p.entry)) {
        priceLines.push(series.createPriceLine({
          price: p.entry,
          color: "#3b82f6",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${p.pattern_name} · ${advice.strengthText}`,
        }));
      }
      if (p.target != null && inRange(p.target)) {
        priceLines.push(series.createPriceLine({
          price: p.target,
          color: "#16c784",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `TP ${p.target.toFixed(2)}`,
        }));
      }
      if (p.stop != null && inRange(p.stop)) {
        priceLines.push(series.createPriceLine({
          price: p.stop,
          color: "#ea3943",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `SL ${p.stop.toFixed(2)}`,
        }));
      }

      let trendlineSeries: ISeriesApi<"Line"> | undefined;
      if (p.trendline_points && p.trendline_points.length >= 2) {
        trendlineSeries = chart.addLineSeries({
          color,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        const data = p.trendline_points
          .map((pt) => ({ time: Math.floor(pt.time / 1000) as UTCTimestamp, value: pt.price }))
          .sort((a, b) => (a.time as number) - (b.time as number))
          .filter((pt, i, arr) => i === 0 || pt.time !== arr[i - 1].time);
        try { trendlineSeries.setData(data); } catch { /* time mismatch */ }
      }

      overlaysRef.current.set(key, { key, payload: p, priceLines, trendlineSeries });
    }

    // Refresh markers (lightweight-charts only supports setMarkers replace).
    const markers: SeriesMarker<Time>[] = patterns.map((p) => {
      const t = Math.floor(p.detected_at / 1000) as UTCTimestamp;
      const pos = p.direction === "bullish" ? "belowBar"
        : p.direction === "bearish" ? "aboveBar" : "inBar";
      const shape = p.direction === "bullish" ? "arrowUp"
        : p.direction === "bearish" ? "arrowDown" : "circle";
      const advice = getPatternAdvice(p.pattern_name, p.direction);
      return {
        time: t,
        position: pos,
        shape,
        color: dirColor(p.direction),
        text: `${p.pattern_name} (${advice.strengthText})`,
      };
    });
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    try { series.setMarkers(markers); } catch { /* */ }

    // Force the right price scale to re-auto-fit so removing a stale
    // overlay actually shrinks the y-axis back to the candle range.
    try { chart.priceScale("right").applyOptions({ autoScale: true }); } catch { /* */ }

  }, [patterns, visiblePatternKeys]);

  // ─── Render ────────────────────────────────────────────────────────────
  const ranked = useMemo(
    () => [...patterns].sort((a, b) => b.confidence - a.confidence),
    [patterns],
  );

  const togglePatternVisibility = (key: string) => {
    setVisiblePatternKeys((curr) => {
      const next = new Set(curr);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleAllPatterns = () => {
    if (visiblePatternKeys.size === patterns.length) {
      setVisiblePatternKeys(new Set());
    } else {
      setVisiblePatternKeys(new Set(patterns.map(payloadKey)));
    }
  };

  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500">Live pattern chart</div>
            <div className="text-sm text-slate-200 font-mono">
              {symbol || "—"} · {TIMEFRAMES.find((t) => t.id === timeframe)?.label ?? timeframe}
            </div>
          </div>
          <span className="flex items-center gap-1 text-[10px] text-slate-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-buy animate-pulse" />
            LIVE
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                onClick={() => setTimeframe(tf.id)}
                className={clsx(
                  "text-xs px-2 py-1 rounded border font-mono",
                  timeframe === tf.id ? "border-accent-info text-white bg-accent-info/10" : "border-bg-border text-slate-400 hover:text-slate-200",
                )}
                title={tf.id}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <select
            value={symbol}
            onChange={(e) => onSymbolChange(e.target.value)}
            className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-xs text-slate-200 font-mono"
          >
            {!SYMBOL_UNIVERSE.includes(symbol) && symbol && <option value={symbol}>{symbol}</option>}
            {SYMBOL_UNIVERSE.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3">
        <div
          className={clsx(
            "relative rounded border transition-all duration-300",
            highlightKey ? "border-accent-buy shadow-[0_0_24px_-6px_rgba(22,199,132,0.6)]" : "border-bg-border",
          )}
          style={{ height: 420 }}
        >
          <div ref={containerRef} className="absolute inset-0" />
          {loading && (
            <div className="absolute top-2 right-2 text-[10px] text-slate-500 font-mono bg-bg-panel-solid/80 px-2 py-0.5 rounded">
              loading…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-accent-sell">{error}</div>
          )}
        </div>

        <aside className="space-y-2 max-h-[420px] overflow-y-auto pr-1">

          {/* ──────────── FINAL VERDICT (fused consensus) ──────────── */}
          {verdict && (
            <div className={clsx(
              "rounded-lg p-3 border-2 mb-2 transition-all",
              verdict.action === "BUY"
                ? "border-accent-buy  bg-accent-buy/10"
                : "border-accent-sell bg-accent-sell/10"
            )}>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                  Final verdict
                </span>
                <span className={clsx(
                  "text-[9px] font-mono uppercase",
                  verdict.action === "BUY" ? "text-accent-buy" : "text-accent-sell"
                )}>
                  {verdict.n_patterns} signals fused
                </span>
              </div>

              <div className="flex items-center gap-3 mb-2">
                <div className={clsx(
                  "text-3xl font-black tracking-tight tabular-nums",
                  verdict.action === "BUY" ? "text-accent-buy" : "text-accent-sell"
                )}>
                  {verdict.action}
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="text-xl font-mono font-bold text-white">
                    {verdict.confidence}%
                  </span>
                  <span className="text-[9px] text-slate-500 uppercase">
                    confidence
                  </span>
                </div>
                <div className="ml-auto text-right">
                  <div className="text-[9px] text-slate-500 uppercase">Agreement</div>
                  <div className="text-sm font-mono font-bold text-slate-200">
                    {Math.round(verdict.agreement * 100)}%
                  </div>
                </div>
              </div>

              <div className="text-[10px] text-slate-400 leading-snug mb-2">
                {verdict.rationale}
              </div>

              {/* mini vote bar */}
              {(verdict.bullish_count + verdict.bearish_count) > 0 && (
                <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-700/40 mb-2">
                  <div
                    className="bg-accent-buy"
                    style={{ width: `${(verdict.bullish_count / (verdict.bullish_count + verdict.bearish_count)) * 100}%` }}
                  />
                  <div
                    className="bg-accent-sell"
                    style={{ width: `${(verdict.bearish_count / (verdict.bullish_count + verdict.bearish_count)) * 100}%` }}
                  />
                </div>
              )}

              {/* aggregate setup */}
              {verdict.entry_price != null && (
                <div className="grid grid-cols-3 gap-1 text-[10px] font-mono pt-1.5 border-t border-bg-border">
                  <div>
                    <div className="text-slate-500 uppercase text-[9px]">Entry</div>
                    <div className="text-white">{verdict.entry_price.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 uppercase text-[9px]">Target</div>
                    <div className="text-accent-buy">{verdict.target_price?.toFixed(2) ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 uppercase text-[9px]">Stop</div>
                    <div className="text-accent-sell">{verdict.stop_price?.toFixed(2) ?? "—"}</div>
                  </div>
                  {verdict.weighted_rr != null && (
                    <div className="col-span-3 text-right text-slate-400 text-[9px] mt-0.5">
                      Weighted R:R = <span className="text-slate-200 font-bold">{verdict.weighted_rr.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between items-center text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            <span>Active patterns · {ranked.length}</span>
            {ranked.length > 0 && (
              <button
                onClick={toggleAllPatterns}
                className="text-[9px] text-accent-info hover:text-white transition-colors uppercase font-bold"
              >
                {visiblePatternKeys.size === patterns.length ? "Hide All" : "Show All"}
              </button>
            )}
          </div>
          {ranked.length === 0 && !loading && (
            <div className="text-xs text-slate-500 py-6 text-center border border-dashed border-bg-border rounded">
              No patterns detected for {symbol} · {timeframe}.
            </div>
          )}
          {ranked.map((p) => {
            const key = payloadKey(p);
            const isVisible = visiblePatternKeys.has(key);
            const isHi = key === highlightKey;
            const advice = getPatternAdvice(p.pattern_name, p.direction);
            return (
              <div
                key={key}
                className={clsx(
                  "border rounded p-2.5 transition-all space-y-2 relative group",
                  isHi ? "border-accent-buy bg-accent-buy/10" : "border-bg-border bg-bg-elevated/40",
                  !isVisible && "opacity-60 hover:opacity-100"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => togglePatternVisibility(key)}
                        className={clsx(
                          "p-0.5 rounded transition-colors shrink-0",
                          isVisible ? "text-accent-info hover:text-white" : "text-slate-500 hover:text-slate-300"
                        )}
                        title={isVisible ? "Hide overlay on chart" : "Show overlay on chart"}
                      >
                        {isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </button>
                      <span className="text-xs text-slate-200 font-semibold truncate">{p.pattern_name}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-0.5 pl-6">
                      {p.timeframe} · {p.direction}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span
                      className={clsx("text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider", advice.badgeClass)}
                    >
                      {advice.strengthText}
                    </span>
                  </div>
                </div>

                <div className="text-[10px] leading-relaxed text-slate-300 bg-bg-panel/40 px-2 py-1.5 rounded border border-bg-border/60 pl-6">
                  💡 <span className="font-semibold text-white">{advice.strengthText} Signal:</span> {advice.adviceMsg}
                </div>

                {(p.entry != null || p.target != null || p.stop != null) && (
                  <div className="mt-1.5 grid grid-cols-3 gap-1 text-[10px] font-mono pt-1.5 border-t border-bg-border/40 pl-6">
                    <div>
                      <div className="text-slate-500">Entry</div>
                      <div className="text-blue-400 font-semibold">{p.entry?.toFixed(2) ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">TP</div>
                      <div className="text-accent-buy font-semibold">{p.target?.toFixed(2) ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">SL</div>
                      <div className="text-accent-sell font-semibold">{p.stop?.toFixed(2) ?? "—"}</div>
                    </div>
                  </div>
                )}
                {p.rr != null && (
                  <div className="text-[10px] text-slate-400 font-mono flex justify-between items-center pt-1 border-t border-bg-border/20 pl-6">
                    <span>Risk-Reward</span>
                    <span className="text-white font-medium">RR {p.rr.toFixed(2)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </aside>
      </div>
    </section>
  );
}
