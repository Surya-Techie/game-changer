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
  { id: "M5", label: "5m" },
  { id: "M15", label: "15m" },
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
      timeScale: {
        borderColor: "#1f2a3d",
        timeVisible: true,
        secondsVisible: false,
        minBarSpacing: 5, // Prevent candles from becoming minute and small when zooming out
        barSpacing: 8,    // Set a comfortable default candle spacing
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

  // Load OHLCV + signals whenever symbol/timeframe changes.
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
          setBars([]);
          setError("No candle data available for this symbol/timeframe.");
          return;
        }
        // Convert AI-service `t` (epoch ms) → lightweight-charts time +
        // PPS bar shape (date string YYYY-MM-DD). Sanitized: null/NaN OHLC
        // rows (yfinance illiquid sessions) hard-crash the chart library.
        const clean = ohlcv.candles.filter(
          (c) => c.o != null && c.h != null && c.l != null && c.c != null &&
            isFinite(c.o) && isFinite(c.h) && isFinite(c.l) && isFinite(c.c)
        );
        const cdata: CandlestickData[] = toCandlestickData(clean);
        seriesRef.current?.setData(cdata);
        chartRef.current?.timeScale().fitContent();
        const ppsBars: PpsBar[] = clean.map((c) => ({
          date: new Date(c.t).toISOString().slice(0, 10),
          open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v,
        }));
        setBars(ppsBars);

        if (ppsBars.length < 50) {
          setError(`Need ≥ 50 bars for PPS — got ${ppsBars.length}.`);
          return;
        }
        const resp = await fetchPpsSignals({ symbol, timeframe, bars: ppsBars });
        if (aborted) return;
        if (!resp) {
          setError("Signal API unavailable.");
          return;
        }
        setSignals(resp.signals);
        setSummary(resp.summary);
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => { aborted = true; };
  }, [symbol, timeframe]);

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
      const short = s.pattern ? PATTERN_SHORT[s.pattern] : "";
      const confPct = Math.round(s.confidence * 100);
      const barTimeSec = Math.floor(new Date(s.date).getTime() / 1000) as UTCTimestamp;
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
            Pattern Probability Strategy — 40/18 SMA trend filter + 6 pattern detectors,
            ATR-based stops, 3R targets. No look-ahead.
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
