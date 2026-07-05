import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SymbolPicker } from "../components/SymbolSearchInput";
import {
  createChart,
  ColorType,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  fetchPpsSignals,
  recordPpsOutcomes,
  PATTERN_SHORT,
  type PpsBar,
  type PpsSignal,
} from "../lib/ppsApi";
import {
  fetchPatternOhlcv,
  type PatternChartTimeframe,
} from "../lib/patternApi";
import PpsSignalFilters, {
  applyFilters,
  type PpsFilters,
} from "../components/PpsSignalFilters";
import PpsSignalPanel from "../components/PpsSignalPanel";
import PpsSignalTable from "../components/PpsSignalTable";
import { toCandlestickData } from "../lib/candleSanitize";
import { useMarketSocket, type WsEvent } from "../lib/socket";
import { useAuth } from "../store/auth";

/** Bar duration per timeframe — used to bucket the 1-minute WS candle
 *  stream into the chart's selected timeframe (same mechanism as the
 *  POWER panel), so signals refresh once per completed bar. */
const TF_MS: Record<PatternChartTimeframe, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  D1: 24 * 60 * 60_000,
  Y1: 365 * 24 * 60 * 60_000,
};

/** Raw candle carrying the epoch-ms timestamp (WS + bucketing unit). */
interface RawCandle { t: number; o: number; h: number; l: number; c: number; v: number }

/**
 * PPS (Pattern Probability Strategy) Signals page.
 *
 * Layout:
 *   ┌── filter bar ────────────────────────────────────────────────────┐
 *   ┌── candlestick chart with BUY/SELL marker arrows ─────────────────┐
 *   ┌── latest-signal panel ──────────┐ ┌── summary cards ─────────────┐
 *   ┌── signal history table (scrollable) ─────────────────────────────┐
 *
 * Architecture: a single fetchPpsSignals() call gives us the full signal
 * list; filter changes never re-hit the API — we just refilter the array
 * and call setMarkers() with the new subset.
 */

const SYMBOL_UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
  "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL",
];

const TIMEFRAMES: Array<{ id: PatternChartTimeframe; label: string }> = [
  { id: "M1", label: "1m" },
  { id: "M5", label: "5m" },
  { id: "M15", label: "15m" },
  { id: "M30", label: "30m" },
  { id: "H1", label: "1h" },
  { id: "D1", label: "1d" },
];

const DEFAULT_FILTERS: PpsFilters = {
  group: "all",
  minConfidence: 0.5,
  direction: "all",
  trendAlignedOnly: true,
  showSignals: true,
};

export default function PpsSignalsPage() {
  const [symbol, setSymbol] = useState("RELIANCE");
  const [timeframe, setTimeframe] = useState<PatternChartTimeframe>("D1");
  const [filters, setFilters] = useState<PpsFilters>(DEFAULT_FILTERS);
  const [bars, setBars] = useState<PpsBar[]>([]);
  const [signals, setSignals] = useState<PpsSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ total_signals: number; buy_count: number; sell_count: number; avg_confidence: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordMsg, setRecordMsg] = useState<string | null>(null);

  // ── Live mode (ported from the POWER panel) ────────────────────────────
  const token = useAuth((s) => s.token);
  const [liveMode, setLiveMode] = useState(true);
  const [liveStatus, setLiveStatus] = useState("");
  const [lastBarT, setLastBarT] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [reloadNonce, setReloadNonce] = useState(0);
  // Raw candles (epoch-ms) kept so WS ticks can be bucketed into the
  // selected timeframe and the signals re-fetched on each bar close.
  const candlesRef = useRef<RawCandle[]>([]);
  const barsRef = useRef<PpsBar[]>([]);          // last analysed bar set (for markers)
  const lastWs1mRef = useRef<{ t: number; v: number } | null>(null);
  const liveRerunPendingRef = useRef<number | null>(null);
  const analysingRef = useRef(false);
  const rerunQueuedRef = useRef(false);
  const barsSinceReloadRef = useRef(0);
  const tfLabel = TIMEFRAMES.find((t) => t.id === timeframe)?.label ?? timeframe;

  // PPS → Analytics: resolve this window's outcomes and commit them to the
  // pattern-accuracy store so PPS patterns gain measured win rates.
  async function handleRecord() {
    setRecording(true);
    setRecordMsg(null);
    const res = await recordPpsOutcomes({ symbol, timeframe, bars });
    setRecording(false);
    if (!res) {
      setRecordMsg("Failed — AI service unreachable.");
    } else if (res.reason) {
      setRecordMsg(res.reason);
    } else {
      setRecordMsg(`Recorded ${res.recorded} outcomes (${res.wins ?? 0}W / ${res.losses ?? 0}L) to Analytics.`);
    }
  }

  // Chart refs.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

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
      },
      // NSE times everywhere — lightweight-charts labels in UTC by default,
      // which shifts the 09:15–15:30 IST session by 5½ h on the axis.
      localization: {
        timeFormatter: (time: number) =>
          new Date(time * 1000).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
            hour: "2-digit", minute: "2-digit", hour12: false,
          }),
      },
      timeScale: {
        borderColor: "#1f2a3d",
        timeVisible: true,
        secondsVisible: false,
        minBarSpacing: 5, // Prevent candles from becoming minute and small when zooming out
        barSpacing: 8,    // Set a comfortable default candle spacing
        tickMarkFormatter: (time: number, tickMarkType: number) => {
          const d = new Date(time * 1000);
          if (tickMarkType < 3) {
            return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" });
          }
          return d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
        },
      },
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
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Re-fetch PPS signals from the current candle buffer. `silent` runs
  // (live auto-reruns on bar close) skip the loading overlay. An overlap
  // guard prevents two concurrent fetches from clobbering each other.
  async function runPps(silent = false) {
    const raw = candlesRef.current;
    if (raw.length < 50) {
      if (!silent) setError(`Need ≥ 50 bars for PPS — got ${raw.length}.`);
      return;
    }
    if (analysingRef.current) { rerunQueuedRef.current = true; return; }
    analysingRef.current = true;
    if (!silent) setLoading(true);
    setError(null);
    try {
      // Carry `t` so the engine's intraday session setups (ORB/PDH/VWAP)
      // fire and markers can be placed by timestamp, not the colliding
      // YYYY-MM-DD date string.
      const ppsBars: PpsBar[] = raw.map((c) => ({
        date: new Date(c.t).toISOString().slice(0, 10),
        t: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v,
      }));
      const resp = await fetchPpsSignals({ symbol, timeframe, bars: ppsBars });
      if (!resp) {
        setError("Signal API unavailable.");
        return;
      }
      barsRef.current = ppsBars;
      setBars(ppsBars);
      setSignals(resp.signals);
      setSummary(resp.summary);
    } finally {
      analysingRef.current = false;
      if (!silent) setLoading(false);
      if (rerunQueuedRef.current) { rerunQueuedRef.current = false; void runPps(true); }
    }
  }

  // Load OHLCV whenever symbol/timeframe changes (or the reconciliation
  // nonce bumps), then run the PPS analysis.
  useEffect(() => {
    let aborted = false;
    (async () => {
      setLoading(true);
      setError(null);
      setSignals([]);
      setSummary(null);
      try {
        const ohlcv = await fetchPatternOhlcv(symbol, timeframe, 400);
        if (aborted) return;
        if (!ohlcv || !ohlcv.candles?.length) {
          candlesRef.current = [];
          setBars([]);
          setError("No candle data available for this symbol/timeframe.");
          return;
        }
        // Sanitized: null/NaN OHLC rows (yfinance illiquid sessions) hard-
        // crash the chart library.
        const clean = ohlcv.candles.filter(
          (c) => c.o != null && c.h != null && c.l != null && c.c != null &&
            isFinite(c.o) && isFinite(c.h) && isFinite(c.l) && isFinite(c.c)
        );
        candlesRef.current = clean.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? 0 }));
        setLastBarT(clean.length ? clean[clean.length - 1].t : null);
        const cdata: CandlestickData[] = toCandlestickData(clean);
        seriesRef.current?.setData(cdata);
        chartRef.current?.timeScale().fitContent();
        await runPps(false);
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => { aborted = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs only on the listed deps
  }, [symbol, timeframe, reloadNonce]);

  // ── Live mode: bucket the 1m WS stream into the selected timeframe and
  // re-fetch signals on every completed bar (same mechanism as POWER). ──
  useMarketSocket({
    token,
    symbols: liveMode && symbol ? [symbol] : [],
    onEvent: (ev: WsEvent) => {
      if (!liveMode) return;
      if (ev.type !== "candle") return;
      if (ev.candle.symbol !== symbol) return;
      const c = ev.candle;
      const buf = candlesRef.current;
      if (!buf.length) return;
      const tfMs = TF_MS[timeframe] ?? 60_000;
      const tail = buf[buf.length - 1];
      if (c.t < tail.t) return; // stale / out-of-order

      const newBarClosed = c.t >= tail.t + tfMs;
      const bucketT = newBarClosed ? tail.t + tfMs * Math.floor((c.t - tail.t) / tfMs) : tail.t;
      const last1m = lastWs1mRef.current;
      const vDelta = last1m && last1m.t === c.t ? Math.max(0, (c.v ?? 0) - last1m.v) : (c.v ?? 0);
      lastWs1mRef.current = { t: c.t, v: c.v ?? 0 };

      let visible: RawCandle;
      if (newBarClosed) {
        visible = { t: bucketT, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? 0 };
        candlesRef.current = [...buf, visible].slice(-500);
        setLastBarT(bucketT);
      } else {
        visible = {
          t: tail.t, o: tail.o,
          h: Math.max(tail.h, c.h), l: Math.min(tail.l, c.l),
          c: c.c, v: (tail.v ?? 0) + vDelta,
        };
        candlesRef.current = [...buf.slice(0, -1), visible];
      }
      try {
        seriesRef.current?.update({
          time: Math.floor(visible.t / 1000) as UTCTimestamp,
          open: visible.o, high: visible.h, low: visible.l, close: visible.c,
        });
      } catch { /* off-grid */ }

      if (newBarClosed) {
        // Periodic reconciliation so locally-built buckets can't drift.
        barsSinceReloadRef.current += 1;
        if (barsSinceReloadRef.current >= 12) {
          barsSinceReloadRef.current = 0;
          setReloadNonce((v) => v + 1);
          return;
        }
        if (liveRerunPendingRef.current != null) window.clearTimeout(liveRerunPendingRef.current);
        liveRerunPendingRef.current = window.setTimeout(() => {
          liveRerunPendingRef.current = null;
          void runPps(true);
        }, 400);
        setLiveStatus(`${tfLabel} bar closed ${new Date(bucketT).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} — recomputing…`);
      } else {
        setLiveStatus(`live · ${tfLabel} bar forming · last tick ${new Date(c.t).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}`);
      }
    },
  });

  // Status + 1s countdown clock while live.
  useEffect(() => {
    if (!liveMode) {
      setLiveStatus("");
      if (liveRerunPendingRef.current != null) {
        window.clearTimeout(liveRerunPendingRef.current);
        liveRerunPendingRef.current = null;
      }
      return;
    }
    setLiveStatus(`live — waiting for next ${tfLabel} bar close`);
    const id = window.setInterval(() => setNowTs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [liveMode, tfLabel]);

  const tfMsNow = TF_MS[timeframe] ?? 60_000;
  const nextVerdictMs = lastBarT != null ? lastBarT + tfMsNow - nowTs : null;
  const countdown = (() => {
    if (nextVerdictMs == null) return null;
    if (nextVerdictMs <= -2 * tfMsNow) return "waiting for market data";
    if (nextVerdictMs <= 0) return "on next tick";
    const s = Math.floor(nextVerdictMs / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}:${String(sec).padStart(2, "0")}`;
  })();

  // Filtered signals — derived, no extra API call.
  const filteredSignals = useMemo(
    () => applyFilters(signals, filters),
    [signals, filters]
  );

  // Latest actionable signal (newest by bar_index in the filtered set).
  const latestSignal: PpsSignal | null = useMemo(() => {
    if (filteredSignals.length === 0) return null;
    return [...filteredSignals].sort((a, b) => b.bar_index - a.bar_index)[0];
  }, [filteredSignals]);

  // Push markers into the chart whenever the filtered list or show-toggle changes.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || bars.length === 0) return;
    if (!filters.showSignals) {
      try { series.setMarkers([]); } catch { /* lib state shift, ignore */ }
      return;
    }
    const markers: SeriesMarker<Time>[] = filteredSignals.map((s) => {
      const isBuy = s.signal === "BUY";
      const short = s.pattern ? (PATTERN_SHORT[s.pattern] ?? "") : "";
      const confPct = Math.round(s.confidence * 100);
      // Place by the bar's real timestamp (bar_index → candle). The
      // signal's `date` string is only day-resolution and collides on
      // intraday timeframes, which stacked every same-day arrow at midnight.
      const barT = bars[s.bar_index]?.t;
      const barTimeSec = Math.floor(
        (barT ?? new Date(s.date).getTime()) / 1000
      ) as UTCTimestamp;
      return {
        time: barTimeSec,
        position: isBuy ? "belowBar" : "aboveBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? "#00C853" : "#FF1744",
        size: 2,
        text: `${s.signal}\n${short}\n${confPct}%`,
      };
    });
    try { series.setMarkers(markers); } catch { /* */ }
  }, [filteredSignals, filters.showSignals, bars.length]);

  return (
    <div className="px-4 md:px-6 py-4 md:py-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-white transition-colors">← Dashboard</Link>
          <h1 className="text-xl font-semibold text-slate-100">PPS Signals</h1>
          <p className="text-xs text-slate-500 mt-1">
            Pattern Probability Strategy — 40/18 SMA trend filter + chart patterns,
            ORB / PDH-PDL / VWAP / Supertrend setups, ATR stops. No look-ahead ·
            live: recomputes each {tfLabel} bar close.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Symbol picker */}
          <SymbolPicker value={symbol} onSelect={setSymbol} className="w-[240px]" placeholder="Search any stock…" />
          {/* Timeframe picker */}
          <div className="flex bg-bg-panel rounded border border-bg-border p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                onClick={() => setTimeframe(tf.id)}
                className={`px-3 py-1 text-xs rounded transition-colors ${
                  timeframe === tf.id ? "bg-accent-info text-white" : "text-slate-300 hover:bg-bg-border/50"
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
          {/* Live toggle — subscribe to the WS stream and recompute on
              each selected-timeframe bar close. */}
          <button
            onClick={() => setLiveMode((v) => !v)}
            title={`Live: recompute signals automatically each time a ${tfLabel} bar closes`}
            className={`px-3 py-1.5 text-xs rounded border transition-colors flex items-center gap-1.5 ${
              liveMode
                ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40 hover:bg-emerald-500/30"
                : "bg-bg-panel text-slate-400 border-bg-border hover:bg-bg-border/50"
            }`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${liveMode ? "bg-emerald-300 animate-pulse" : "bg-slate-500"}`} />
            {liveMode ? "LIVE" : "Live"}
          </button>
          {/* PPS → Analytics: commit this window's resolved outcomes. */}
          <button
            onClick={handleRecord}
            disabled={recording || bars.length < 50}
            title="Resolve these signals' outcomes and record them to Pattern Analytics (append-only)."
            className="px-3 py-1.5 text-xs rounded border border-bg-border text-slate-200 hover:bg-bg-border/50 disabled:opacity-50"
          >
            {recording ? "Recording…" : "Record to Analytics"}
          </button>
        </div>
      </div>

      {/* Live status strip */}
      {liveMode && (
        <div className="text-[11px] font-mono text-emerald-200/80 bg-emerald-500/5 border border-emerald-500/20 rounded px-3 py-1.5 flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
          <span>{liveStatus || `live — waiting for next ${tfLabel} bar close`}</span>
          {countdown && (
            <span className="ml-auto text-emerald-200/90">
              {countdown === "waiting for market data"
                ? <span className="font-semibold">waiting for market data</span>
                : <>next {tfLabel} verdict in <span className="font-semibold">{countdown}</span></>}
            </span>
          )}
        </div>
      )}
      {recordMsg && (
        <div className="mb-3 text-xs text-slate-400 border border-bg-border rounded px-3 py-1.5 bg-bg-panel/50">
          {recordMsg}
        </div>
      )}

      {/* Filters */}
      <PpsSignalFilters value={filters} onChange={setFilters} />

      {/* Chart */}
      <div className="relative bg-bg-panel border border-bg-border rounded-xl overflow-hidden" style={{ height: 460 }}>
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-bg/60 backdrop-blur-sm">
            <span className="text-sm text-slate-400 animate-pulse">Computing signals…</span>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-bg/60">
            <span className="text-sm text-accent-sell">{error}</span>
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0" />
      </div>

      {/* Summary + latest-signal stacked on mobile, side-by-side on lg */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <PpsSignalPanel signal={latestSignal} />
        </div>
        <div className="bg-bg-panel border border-bg-border rounded-xl p-5">
          <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Window summary</div>
          <div className="grid grid-cols-2 gap-3">
            <SummaryCell label="Total" value={String(summary?.total_signals ?? 0)} />
            <SummaryCell label="Avg conf" value={summary ? `${(summary.avg_confidence * 100).toFixed(0)}%` : "—"} />
            <SummaryCell label="BUY" value={String(summary?.buy_count ?? 0)} tone="text-accent-buy" />
            <SummaryCell label="SELL" value={String(summary?.sell_count ?? 0)} tone="text-accent-sell" />
          </div>
          <div className="mt-3 pt-3 border-t border-bg-border text-xs text-slate-500">
            After filters: <span className="text-slate-300 font-mono">{filteredSignals.length}</span> signals
          </div>
        </div>
      </div>

      {/* History table */}
      <PpsSignalTable signals={filteredSignals} bars={bars} />
    </div>
  );
}

function SummaryCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-lg ${tone ?? "text-slate-200"}`}>{value}</div>
    </div>
  );
}
