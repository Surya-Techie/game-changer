import { SymbolPicker } from "../components/SymbolSearchInput";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import clsx from "clsx";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/errors";

// ============================ types ===========================================

interface BacktestSummary {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  netPnl: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  lossRate: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  sharpe: number;
  sortino: number | null;
  calmar: number;
  partialExits?: number;
  filterBlocked?: number;
  totalBrokerage?: number;
  barsEvaluated?: number;
}

interface BacktestTrade {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entry_price: number;
  exit_price: number;
  entry_idx: number;
  exit_idx: number;
  entry_t: number;
  exit_t: number;
  gross_pnl: number;
  brokerage: number;
  pnl: number;
  pnl_pct: number;
  reason: string;
  duration_ms: number;
}

interface BacktestResult {
  summary: BacktestSummary;
  equityCurve: Array<{ t: number; equity: number; drawdownPct: number }>;
  monthlyReturns: Record<string, number>;
  trades: BacktestTrade[];
  error?: string;
}

const SYMBOLS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL"];

// ============================ page ============================================

export default function BacktestPage() {
  // Page-level tab selector — Strategy backtest stays exactly as it was;
  // Pattern backtest is a Phase-7 sibling rendered conditionally.
  const [pageTab, setPageTab] = useState<"strategy" | "pattern">("strategy");
  const [symbol, setSymbol] = useState("RELIANCE");
  const [bars, setBars] = useState(500);
  const [warmup, setWarmup] = useState(60);
  const [minConfidence, setMinConfidence] = useState(0.55);
  const [capital, setCapital] = useState(100000);
  const [riskPct, setRiskPct] = useState(1);

  const [stopMode, setStopMode] = useState<"ATR" | "FIXED_PCT">("FIXED_PCT");
  const [stopPct, setStopPct] = useState(2);
  const [targetRR, setTargetRR] = useState(2);
  const [regimeFilter, setRegimeFilter] = useState(false);
  const [regimeMinAdx, setRegimeMinAdx] = useState(18);
  const [mtfConfirmation, setMtfConfirmation] = useState(false);
  const [trailingPct, setTrailingPct] = useState<number | "">("");
  const [partialTp, setPartialTp] = useState(false);
  const [brokerageFlat, setBrokerageFlat] = useState(40);
  const [brokeragePct, setBrokeragePct] = useState(0.03);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [baseline, setBaseline] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runBacktest(mode: "withFilters" | "baseline") {
    setRunning(true);
    setError(null);
    const useFilters = mode !== "baseline";
    try {
      const body: Record<string, unknown> = {
        symbol,
        bars,
        warmup,
        minConfidence,
        capital,
        riskPerTradePct: riskPct,
        brokerageFlat,
        brokeragePct: brokeragePct / 100, // user inputs %, API takes ratio
        strategy: useFilters
          ? { stopMode, stopPct, targetRR, regimeFilter, regimeMinAdx, mtfConfirmation }
          : { stopMode: "ATR", targetRR: 2 },
        trailingStopPct: useFilters && trailingPct !== "" ? Number(trailingPct) : undefined,
        partialTpEnabled: useFilters ? partialTp : false,
      };
      const { data } = await api.post("/api/backtest", body);
      if (data.error) {
        setError(data.error);
        return;
      }
      if (mode === "baseline") setBaseline(data as BacktestResult);
      else setResult(data as BacktestResult);
    } catch (err) {
      setError(apiErrorMessage(err, "Backtest failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="min-h-full bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4 flex items-center justify-between print:hidden">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
          <h1 className="text-xl font-semibold text-white">Strategy Backtest</h1>
          <div className="text-xs text-slate-500">A/B test stop modes, trailing, partial TP, regime + MTF filters.</div>
        </div>
        {(result || baseline) && (
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => exportTradesCsv(result ?? baseline!, "your-config")} className="border border-bg-border rounded-md px-3 py-1.5 text-slate-300 hover:text-white">
              Export trades CSV
            </button>
            <button onClick={() => window.print()} className="border border-bg-border rounded-md px-3 py-1.5 text-slate-300 hover:text-white">
              Print report (PDF)
            </button>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <nav className="flex gap-2 text-sm print:hidden">
          {(["strategy", "pattern"] as const).map((id) => (
            <button
              key={id}
              onClick={() => setPageTab(id)}
              className={clsx(
                "px-4 py-2 rounded-lg border",
                pageTab === id
                  ? "bg-accent-info/10 border-accent-info/40 text-white"
                  : "bg-bg-panel-solid/60 border-bg-border text-slate-400 hover:text-slate-200"
              )}
            >
              {id === "strategy" ? "Strategy Backtest" : "Pattern Backtest"}
            </button>
          ))}
        </nav>

        {pageTab === "pattern" && <PatternBacktestTab />}

        {pageTab === "strategy" && (
        <>
        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5 grid grid-cols-2 md:grid-cols-6 gap-4 items-end print:hidden">
          <Field label="Symbol">
            <SymbolPicker value={symbol} onSelect={setSymbol} placeholder="Search any stock…" />
          </Field>
          <Field label="Bars">
            <input type="number" min={100} max={1000} value={bars} onChange={(e) => setBars(Number(e.target.value))} className="input" />
          </Field>
          <Field label="Warmup">
            <input type="number" min={30} max={200} value={warmup} onChange={(e) => setWarmup(Number(e.target.value))} className="input" />
          </Field>
          <Field label="Min confidence">
            <input type="number" step={0.05} min={0.3} max={0.95} value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))} className="input" />
          </Field>
          <Field label="Capital ₹">
            <input type="number" min={10000} step={10000} value={capital} onChange={(e) => setCapital(Number(e.target.value))} className="input" />
          </Field>
          <Field label="Risk / trade %">
            <input type="number" step={0.5} min={0.1} max={5} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} className="input" />
          </Field>
        </section>

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5 print:hidden">
          <div className="text-sm uppercase tracking-wider text-slate-500 mb-4">Strategy toggles</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
            <Field label="Stop mode">
              <select value={stopMode} onChange={(e) => setStopMode(e.target.value as "ATR" | "FIXED_PCT")} className="input">
                <option value="FIXED_PCT">Fixed %</option>
                <option value="ATR">ATR</option>
              </select>
            </Field>
            {stopMode === "FIXED_PCT" && (
              <Field label="Stop-loss %">
                <input type="number" step={0.1} min={0.5} max={10} value={stopPct} onChange={(e) => setStopPct(Number(e.target.value))} className="input" />
              </Field>
            )}
            <Field label="Take-profit (×stop)">
              <input type="number" step={0.5} min={0.5} max={6} value={targetRR} onChange={(e) => setTargetRR(Number(e.target.value))} className="input" />
            </Field>
            <Field label="Trailing stop %">
              <input type="number" step={0.1} min={0} max={10} value={trailingPct} onChange={(e) => setTrailingPct(e.target.value === "" ? "" : Number(e.target.value))} placeholder="off" className="input" />
            </Field>
            <Field label="Brokerage / trade ₹">
              <input type="number" step={5} min={0} max={500} value={brokerageFlat} onChange={(e) => setBrokerageFlat(Number(e.target.value))} className="input" />
            </Field>
            <Field label="Brokerage % per side">
              <input type="number" step={0.01} min={0} max={1} value={brokeragePct} onChange={(e) => setBrokeragePct(Number(e.target.value))} className="input" />
            </Field>
            <Toggle label="Regime filter (ADX)" checked={regimeFilter} onChange={setRegimeFilter} />
            {regimeFilter && (
              <Field label="Min ADX">
                <input type="number" min={10} max={40} value={regimeMinAdx} onChange={(e) => setRegimeMinAdx(Number(e.target.value))} className="input" />
              </Field>
            )}
            <Toggle label="Multi-timeframe (5m + 15m)" checked={mtfConfirmation} onChange={setMtfConfirmation} />
            <Toggle label="Partial TP at 1R" checked={partialTp} onChange={setPartialTp} />
          </div>
          <div className="mt-5 flex items-center gap-3">
            <button onClick={() => runBacktest("withFilters")} disabled={running} className="bg-accent-info text-white font-semibold rounded-lg px-5 py-2 disabled:opacity-50">
              {running ? "Running…" : "Run backtest"}
            </button>
            <button onClick={() => runBacktest("baseline")} disabled={running} className="border border-bg-border text-slate-300 rounded-lg px-4 py-2">
              Run vanilla baseline
            </button>
            {error && <span className="text-sm text-accent-sell">{error}</span>}
          </div>
        </section>

        {!result && !baseline && !running && <EmptyState />}
        {running && !result && !baseline && <LoadingState />}

        {(result || baseline) && (
          <>
            {result && baseline && <ComparisonStrip baseline={baseline.summary} enhanced={result.summary} />}

            {result && (
              <ResultBlock title="Your configuration" data={result} highlight />
            )}
            {baseline && (
              <ResultBlock title="Vanilla baseline (ATR stop, no filters)" data={baseline} />
            )}
          </>
        )}
        </>
        )}
      </main>

      <style>{`
        .input { width: 100%; background: #0a0d12; border: 1px solid #1f2a3d; border-radius: 8px; padding: 8px 10px; color: #e2e8f0; outline: none; }
        .input:focus { border-color: #3b82f6; }
        @media print {
          body { background: white !important; color: black !important; }
          .print\\:hidden { display: none !important; }
          .bg-bg-panel-solid\\/70 { background: white !important; }
          .text-white, .text-slate-200, .text-slate-300, .text-slate-400 { color: black !important; }
          .border-bg-border { border-color: #ccc !important; }
        }
      `}</style>
    </div>
  );
}

// ============================ result block ====================================

function ResultBlock({ title, data, highlight }: { title: string; data: BacktestResult; highlight?: boolean }) {
  return (
    <div className={clsx("rounded-xl border", highlight ? "border-accent-info/40 bg-accent-info/5" : "border-bg-border bg-bg-panel-solid/70 backdrop-blur-glass")}>
      <div className="px-5 pt-4 pb-2 text-sm uppercase tracking-wider text-slate-500">{title}</div>
      <SummaryGrid summary={data.summary} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
        <PanelBox title="Equity curve">
          <EquityChart points={data.equityCurve.map((p) => ({ t: p.t, value: p.equity }))} />
        </PanelBox>
        <PanelBox title="Drawdown %">
          <DrawdownChart points={data.equityCurve.map((p) => ({ t: p.t, value: -p.drawdownPct }))} />
        </PanelBox>
        <PanelBox title="Monthly returns">
          <MonthlyHeatmap returns={data.monthlyReturns} />
        </PanelBox>
        <PanelBox title="P&L distribution">
          <TradeDistribution trades={data.trades} />
        </PanelBox>
      </div>
      <TradeLog trades={data.trades} />
    </div>
  );
}

function PanelBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-panel-solid/60 border border-bg-border rounded-lg p-3">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">{title}</div>
      {children}
    </div>
  );
}

// ============================ summary grid ====================================

function SummaryGrid({ summary }: { summary: BacktestSummary }) {
  const cells = [
    { label: "Total Trades", value: String(summary.trades) },
    { label: "Win Rate", value: `${(summary.winRate * 100).toFixed(1)}%`, cls: summary.winRate >= 0.5 ? "text-accent-buy" : undefined },
    { label: "Loss Rate", value: `${(summary.lossRate * 100).toFixed(1)}%`, cls: "text-slate-300" },
    { label: "Profit Factor", value: summary.profitFactor != null ? summary.profitFactor.toFixed(2) : "∞", cls: (summary.profitFactor ?? 0) >= 1 ? "text-accent-buy" : "text-accent-sell" },
    { label: "Max Drawdown", value: `${summary.maxDrawdownPct.toFixed(2)}%`, cls: "text-accent-sell" },
    { label: "Net P&L", value: fmtINR(summary.netPnl, true), cls: summary.netPnl >= 0 ? "text-accent-buy" : "text-accent-sell" },
    { label: "Avg Win", value: fmtINR(summary.avgWin, true), cls: "text-accent-buy" },
    { label: "Avg Loss", value: fmtINR(summary.avgLoss, true), cls: "text-accent-sell" },
    { label: "Sharpe (annualised)", value: summary.sharpe.toFixed(2) },
    { label: "Sortino", value: summary.sortino != null ? summary.sortino.toFixed(2) : "∞" },
    { label: "Calmar", value: summary.calmar.toFixed(2) },
    { label: "Expectancy", value: fmtINR(summary.expectancy, true), cls: summary.expectancy >= 0 ? "text-accent-buy" : "text-accent-sell" },
  ];
  return (
    <div className="grid grid-cols-3 md:grid-cols-4 gap-3 px-5 py-3 border-b border-bg-border">
      {cells.map((c) => (
        <div key={c.label}>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">{c.label}</div>
          <div className={clsx("text-base font-mono tabular-nums", c.cls ?? "text-white")}>{c.value}</div>
        </div>
      ))}
      {summary.totalBrokerage != null && (
        <div className="col-span-3 md:col-span-4 text-[10px] text-slate-500 font-mono">
          Total brokerage paid: {fmtINR(summary.totalBrokerage, false)} · Bars evaluated: {summary.barsEvaluated ?? "—"} · Filter blocks: {summary.filterBlocked ?? 0} · Partial exits: {summary.partialExits ?? 0}
        </div>
      )}
    </div>
  );
}

// ============================ comparison strip ================================

function ComparisonStrip({ baseline, enhanced }: { baseline: BacktestSummary; enhanced: BacktestSummary }) {
  const rows: Array<{ label: string; b: number; e: number; betterIsHigher: boolean; fmt: (n: number) => string }> = [
    { label: "Win rate", b: baseline.winRate * 100, e: enhanced.winRate * 100, betterIsHigher: true, fmt: (n) => `${n.toFixed(1)}%` },
    { label: "Profit factor", b: baseline.profitFactor ?? 0, e: enhanced.profitFactor ?? 0, betterIsHigher: true, fmt: (n) => n.toFixed(2) },
    { label: "Max drawdown %", b: baseline.maxDrawdownPct, e: enhanced.maxDrawdownPct, betterIsHigher: false, fmt: (n) => `${n.toFixed(2)}%` },
    { label: "Net P&L", b: baseline.netPnl, e: enhanced.netPnl, betterIsHigher: true, fmt: (n) => fmtINR(n, true) },
    { label: "Sharpe", b: baseline.sharpe, e: enhanced.sharpe, betterIsHigher: true, fmt: (n) => n.toFixed(2) },
    { label: "Expectancy", b: baseline.expectancy, e: enhanced.expectancy, betterIsHigher: true, fmt: (n) => fmtINR(n, true) },
  ];
  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-accent-info/30 rounded-xl p-5">
      <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Your config vs vanilla baseline</div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {rows.map((r) => {
          const delta = r.e - r.b;
          const improved = r.betterIsHigher ? delta > 0 : delta < 0;
          const pct = r.b === 0 ? 0 : (delta / Math.abs(r.b)) * 100;
          return (
            <div key={r.label} className="bg-bg-panel-solid/60 border border-bg-border rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{r.label}</div>
              <div className="text-xs text-slate-400 font-mono">{r.fmt(r.b)} → <span className="text-white">{r.fmt(r.e)}</span></div>
              <div className={clsx("text-xs font-mono mt-1", improved ? "text-accent-buy" : "text-accent-sell")}>
                {improved ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ============================ charts ==========================================

function EquityChart({ points }: { points: Array<{ t: number; value: number }> }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#94a3b8", attributionLogo: false },
      grid: { vertLines: { color: "#1f2a3d" }, horzLines: { color: "#1f2a3d" } },
      rightPriceScale: { borderColor: "#1f2a3d" },
      timeScale: { borderColor: "#1f2a3d", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    seriesRef.current = chart.addAreaSeries({
      lineColor: "#3b82f6",
      topColor: "rgba(59,130,246,0.4)",
      bottomColor: "rgba(59,130,246,0.05)",
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.value })));
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={containerRef} className="h-48" />;
}

function DrawdownChart({ points }: { points: Array<{ t: number; value: number }> }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#94a3b8", attributionLogo: false },
      grid: { vertLines: { color: "#1f2a3d" }, horzLines: { color: "#1f2a3d" } },
      rightPriceScale: { borderColor: "#1f2a3d" },
      timeScale: { borderColor: "#1f2a3d", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    seriesRef.current = chart.addAreaSeries({
      lineColor: "#ea3943",
      topColor: "rgba(234,57,67,0.05)",
      bottomColor: "rgba(234,57,67,0.4)",
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.value })));
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={containerRef} className="h-48" />;
}

function MonthlyHeatmap({ returns }: { returns: Record<string, number> }) {
  const entries = useMemo(() => Object.entries(returns).sort(([a], [b]) => a.localeCompare(b)), [returns]);
  if (entries.length === 0) {
    return <div className="h-48 flex items-center justify-center text-xs text-slate-500">Not enough span — try a longer backtest window.</div>;
  }
  // Determine min/max for color scale.
  const max = Math.max(...entries.map(([, v]) => Math.abs(v)), 0.01);
  return (
    <div className="h-48 overflow-y-auto">
      <table className="w-full text-xs font-mono">
        <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-bg-panel-solid">
          <tr><th className="text-left px-2 py-1">Month</th><th className="text-right px-2 py-1">Return</th><th className="px-2 py-1">Intensity</th></tr>
        </thead>
        <tbody>
          {entries.map(([month, ret]) => {
            const intensity = Math.min(1, Math.abs(ret) / max);
            const bg = ret >= 0
              ? `rgba(22,199,132,${0.1 + intensity * 0.6})`
              : `rgba(234,57,67,${0.1 + intensity * 0.6})`;
            return (
              <tr key={month}>
                <td className="px-2 py-1 text-slate-300">{month}</td>
                <td className={clsx("px-2 py-1 text-right", ret >= 0 ? "text-accent-buy" : "text-accent-sell")}>
                  {ret >= 0 ? "+" : ""}{ret.toFixed(2)}%
                </td>
                <td className="px-2 py-1">
                  <div className="h-3 rounded" style={{ background: bg, width: `${10 + intensity * 90}%` }} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TradeDistribution({ trades }: { trades: BacktestTrade[] }) {
  const bins = useMemo(() => buildHistogram(trades.map((t) => t.pnl_pct), 16), [trades]);
  if (!bins || bins.counts.every((c) => c === 0)) {
    return <div className="h-48 flex items-center justify-center text-xs text-slate-500">No trades to plot.</div>;
  }
  const maxCount = Math.max(...bins.counts);
  return (
    <div className="h-48 flex items-end gap-1 px-1">
      {bins.counts.map((c, i) => {
        const center = (bins.edges[i] + bins.edges[i + 1]) / 2;
        const pct = (c / maxCount) * 100;
        return (
          <div key={i} className="flex-1 flex flex-col items-center justify-end">
            <div
              className={clsx("w-full rounded-t", center >= 0 ? "bg-accent-buy/60" : "bg-accent-sell/60")}
              style={{ height: `${pct}%` }}
              title={`${center.toFixed(1)}% → ${c} trades`}
            />
            {(i === 0 || i === bins.counts.length - 1 || i === Math.floor(bins.counts.length / 2)) && (
              <div className="text-[9px] text-slate-500 mt-1">{center.toFixed(1)}%</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function buildHistogram(values: number[], n: number): { counts: number[]; edges: number[] } | null {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { counts: [values.length], edges: [min, max] };
  const span = max - min;
  const edges = Array.from({ length: n + 1 }, (_, i) => min + (i / n) * span);
  const counts = Array(n).fill(0);
  for (const v of values) {
    let idx = Math.floor(((v - min) / span) * n);
    if (idx >= n) idx = n - 1;
    counts[idx]++;
  }
  return { counts, edges };
}

// ============================ trade log =======================================

type SortKey = "exit_t" | "pnl" | "pnl_pct" | "side" | "reason";
type SortDir = "asc" | "desc";

function TradeLog({ trades }: { trades: BacktestTrade[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("exit_t");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filterSide, setFilterSide] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [filterResult, setFilterResult] = useState<"ALL" | "W" | "L">("ALL");

  const filtered = useMemo(() => {
    let arr = trades.slice();
    if (filterSide !== "ALL") arr = arr.filter((t) => t.side === filterSide);
    if (filterResult !== "ALL") arr = arr.filter((t) => (filterResult === "W" ? t.pnl > 0 : t.pnl <= 0));
    arr.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [trades, sortKey, sortDir, filterSide, filterResult]);

  function header(label: string, key: SortKey) {
    const active = sortKey === key;
    return (
      <th
        className="text-left px-3 py-2 cursor-pointer hover:text-white select-none"
        onClick={() => {
          if (active) setSortDir(sortDir === "asc" ? "desc" : "asc");
          else { setSortKey(key); setSortDir("desc"); }
        }}
      >
        {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
      </th>
    );
  }

  return (
    <section className="border-t border-bg-border">
      <div className="px-5 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm uppercase tracking-wider text-slate-500">Trade log ({filtered.length} of {trades.length})</div>
        <div className="flex items-center gap-2 text-xs">
          <select value={filterSide} onChange={(e) => setFilterSide(e.target.value as "ALL" | "LONG" | "SHORT")} className="bg-bg-elevated border border-bg-border rounded px-2 py-1">
            <option value="ALL">All sides</option>
            <option value="LONG">LONG only</option>
            <option value="SHORT">SHORT only</option>
          </select>
          <select value={filterResult} onChange={(e) => setFilterResult(e.target.value as "ALL" | "W" | "L")} className="bg-bg-elevated border border-bg-border rounded px-2 py-1">
            <option value="ALL">All results</option>
            <option value="W">Wins only</option>
            <option value="L">Losses only</option>
          </select>
        </div>
      </div>
      {trades.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400 text-center">No trades executed. Lower the entry threshold or stretch the window.</div>
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-xs font-mono">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-bg-panel-solid">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                {header("Date", "exit_t")}
                {header("Side", "side")}
                <th className="text-right px-3 py-2">Qty</th>
                <th className="text-right px-3 py-2">Entry</th>
                <th className="text-right px-3 py-2">Exit</th>
                <th className="text-right px-3 py-2">Gross</th>
                <th className="text-right px-3 py-2">Brok.</th>
                {header("Net P&L", "pnl")}
                {header("%", "pnl_pct")}
                <th className="text-right px-3 py-2">Hold</th>
                {header("Exit", "reason")}
                <th className="text-center px-3 py-2">W/L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {filtered.map((t, i) => {
                const win = t.pnl > 0;
                return (
                  <tr key={i}>
                    <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                    <td className="px-3 py-1.5 text-slate-400">{fmtTime(t.exit_t)}</td>
                    <td className={clsx("px-3 py-1.5", t.side === "LONG" ? "text-accent-buy" : "text-accent-sell")}>{t.side}</td>
                    <td className="px-3 py-1.5 text-right text-slate-300">{t.qty}</td>
                    <td className="px-3 py-1.5 text-right text-slate-300">{t.entry_price.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-300">{t.exit_price.toFixed(2)}</td>
                    <td className={clsx("px-3 py-1.5 text-right", t.gross_pnl >= 0 ? "text-accent-buy" : "text-accent-sell")}>{t.gross_pnl.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-500">{t.brokerage.toFixed(2)}</td>
                    <td className={clsx("px-3 py-1.5 text-right", win ? "text-accent-buy" : "text-accent-sell")}>{t.pnl.toFixed(2)}</td>
                    <td className={clsx("px-3 py-1.5 text-right", win ? "text-accent-buy" : "text-accent-sell")}>{t.pnl_pct.toFixed(2)}%</td>
                    <td className="px-3 py-1.5 text-right text-slate-400">{fmtDuration(t.duration_ms)}</td>
                    <td className="px-3 py-1.5 text-slate-400">{t.reason}</td>
                    <td className="px-3 py-1.5 text-center">
                      <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold", win ? "bg-accent-buy/15 text-accent-buy" : "bg-accent-sell/15 text-accent-sell")}>{win ? "W" : "L"}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ============================ helpers =========================================

function fmtINR(n: number, signed = false): string {
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function fmtDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)}m`;
  const hr = min / 60;
  if (hr < 24) return `${hr.toFixed(1)}h`;
  return `${(hr / 24).toFixed(1)}d`;
}

function exportTradesCsv(data: BacktestResult, label: string) {
  if (!data.trades.length) return;
  const header = [
    "idx", "date", "side", "qty", "entry_price", "exit_price",
    "gross_pnl", "brokerage", "net_pnl", "pnl_pct", "duration_ms", "exit_reason",
  ];
  const rows = data.trades.map((t, i) => [
    i + 1,
    new Date(t.exit_t).toISOString(),
    t.side,
    t.qty,
    t.entry_price,
    t.exit_price,
    t.gross_pnl,
    t.brokerage,
    t.pnl,
    t.pnl_pct,
    t.duration_ms,
    t.reason,
  ]);
  const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `qti-backtest-${label}-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-slate-500 mb-1 inline-block">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={clsx(
        "flex items-center justify-between gap-3 px-3 py-2 rounded-md border text-sm",
        checked ? "border-accent-info bg-accent-info/10 text-white" : "border-bg-border text-slate-400"
      )}
    >
      <span>{label}</span>
      <span className={clsx("relative w-8 h-4 rounded-full transition-colors", checked ? "bg-accent-info" : "bg-bg-elevated")}>
        <span className={clsx("absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
      </span>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-8 text-center">
      <div className="text-sm text-slate-300 mb-2">Run a backtest to see results.</div>
      <div className="text-xs text-slate-500 max-w-md mx-auto">
        Pick parameters above and click <span className="text-white">Run backtest</span>. Then click <span className="text-white">Run vanilla baseline</span> to see a side-by-side comparison.
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6">
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 bg-bg-elevated/40 rounded-lg animate-pulse" />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// PatternBacktestTab — Phase 7
// =============================================================================

interface PatternBacktestResult {
  symbol: string;
  timeframe: string;
  config: Record<string, unknown>;
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  profit_factor: number | "inf";
  total_return_pct: number;
  max_drawdown: number;
  sharpe: number;
  avg_rr_achieved: number;
  final_equity: number;
  by_pattern: Record<string, {
    trades: number;
    wins: number;
    losses: number;
    breakevens: number;
    expired: number;
    win_rate: number;
    avg_pnl: number;
    pnl_total: number;
    best_trade: number;
    worst_trade: number;
  }>;
  equity_curve: Array<{ t: number; date: string; equity: number }>;
  trade_log: Array<{
    pattern_name: string;
    direction: string;
    entry_t: number;
    exit_t: number;
    entry: number;
    exit: number;
    qty: number;
    pnl: number;
    pnl_pct: number;
    rr_planned: number;
    rr_achieved: number;
    outcome: string;
    hold_bars: number;
    confidence: number;
    grade: string;
  }>;
  error?: string;
}

function PatternBacktestTab() {
  const [symbol, setSymbol] = useState("RELIANCE");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [timeframe, setTimeframe] = useState<"D1" | "H1" | "M15" | "M5">("D1");
  const [capital, setCapital] = useState(100_000);
  const [riskPct, setRiskPct] = useState(1);
  const [minConfidence, setMinConfidence] = useState(60);
  const [selected, setSelected] = useState<string[]>([]); // [] means all
  const [namesList, setNamesList] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PatternBacktestResult | null>(null);

  // Load pattern names from backend on mount.
  useEffect(() => {
    let aborted = false;
    api.get("/api/backtest/patterns/names")
      .then((r) => { if (!aborted) setNamesList((r.data?.names ?? []) as string[]); })
      .catch(() => {});
    return () => { aborted = true; };
  }, []);

  const filteredNames = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return namesList;
    return namesList.filter((n) => n.toLowerCase().includes(q));
  }, [namesList, filter]);

  function togglePattern(name: string) {
    setSelected((prev) => (prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name]));
  }

  async function run(preset: "user" | "best" = "user") {
    setRunning(true);
    setError(null);
    try {
      const body = {
        symbol,
        start_date: startDate,
        end_date: endDate,
        timeframe,
        capital,
        risk_per_trade_pct: riskPct,
        min_confidence: preset === "best" ? 60 : minConfidence,
        pattern_names: preset === "best" ? [] : selected,
      };
      const { data } = await api.post("/api/backtest/patterns", body);
      if (data.error) {
        setError(data.error);
        return;
      }
      setResult(data as PatternBacktestResult);
    } catch (err) {
      setError(apiErrorMessage(err, "Backtest failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5 print:hidden">
        <div className="text-sm uppercase tracking-wider text-slate-500 mb-4">Pattern backtest configuration</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 items-end">
          <Field label="Symbol">
            <SymbolPicker value={symbol} onSelect={setSymbol} placeholder="Search any stock…" />
          </Field>
          <Field label="Start date">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input" />
          </Field>
          <Field label="End date">
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="input" />
          </Field>
          <Field label="Timeframe">
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as "D1" | "H1" | "M15" | "M5")} className="input">
              <option value="D1">D1 — daily</option>
              <option value="H1">H1 — hourly</option>
              <option value="M15">M15</option>
              <option value="M5">M5</option>
            </select>
          </Field>
          <Field label="Capital ₹">
            <input type="number" min={10_000} step={10_000} value={capital} onChange={(e) => setCapital(Number(e.target.value))} className="input" />
          </Field>
          <Field label="Risk / trade %">
            <input type="number" step={0.25} min={0.1} max={5} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} className="input" />
          </Field>
          <Field label="Min confidence">
            <input type="range" min={50} max={95} value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))} />
            <div className="text-xs font-mono text-slate-300">{minConfidence}%</div>
          </Field>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase tracking-wider text-slate-500">
              Patterns ({selected.length === 0 ? "all" : `${selected.length} selected`})
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Filter patterns…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="input text-xs"
                style={{ width: 180 }}
              />
              <button
                onClick={() => setSelected([])}
                className="text-xs text-slate-400 hover:text-white"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-44 overflow-y-auto border border-bg-border rounded-md p-2 bg-bg-elevated/30 grid grid-cols-2 md:grid-cols-4 gap-1.5">
            {filteredNames.length === 0 ? (
              <div className="text-xs text-slate-500 col-span-full py-2">{namesList.length === 0 ? "Loading pattern list…" : "No patterns match the filter."}</div>
            ) : filteredNames.map((name) => {
              const on = selected.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => togglePattern(name)}
                  className={clsx(
                    "text-left text-[11px] px-2 py-1 rounded border truncate",
                    on
                      ? "border-accent-info bg-accent-info/10 text-white"
                      : "border-bg-border text-slate-400 hover:text-slate-200"
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3 flex-wrap">
          <button onClick={() => run("user")} disabled={running} className="bg-accent-info text-white font-semibold rounded-lg px-5 py-2 disabled:opacity-50">
            {running ? "Running…" : "Run pattern backtest"}
          </button>
          <button onClick={() => run("best")} disabled={running} className="border border-bg-border text-slate-300 rounded-lg px-4 py-2">
            Which patterns work best on this symbol?
          </button>
          {error && <span className="text-sm text-accent-sell">{error}</span>}
        </div>
      </section>

      {!result && !running && (
        <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-8 text-center">
          <div className="text-sm text-slate-300 mb-2">Run a pattern backtest to see results.</div>
          <div className="text-xs text-slate-500 max-w-md mx-auto">
            Pick a symbol, a date range, and either select specific patterns or leave them all selected. The engine walks each bar, fires the same rule engine the live system uses, and simulates entries on the next bar's open with target/stop exits.
          </div>
        </div>
      )}
      {running && !result && <LoadingState />}
      {result && <PatternBacktestResults data={result} />}
    </div>
  );
}

function PatternBacktestResults({ data }: { data: PatternBacktestResult }) {
  const winColor = data.total_return_pct >= 0 ? "text-accent-buy" : "text-accent-sell";
  const cells = [
    { label: "Trades", value: String(data.total_trades) },
    { label: "Win rate", value: `${(data.win_rate * 100).toFixed(1)}%`, cls: data.win_rate >= 0.5 ? "text-accent-buy" : undefined },
    { label: "Profit factor", value: data.profit_factor === "inf" || data.profit_factor === Infinity ? "∞" : Number(data.profit_factor).toFixed(2), cls: (Number(data.profit_factor) || 0) >= 1 ? "text-accent-buy" : "text-accent-sell" },
    { label: "Total return", value: `${data.total_return_pct >= 0 ? "+" : ""}${data.total_return_pct.toFixed(2)}%`, cls: winColor },
    { label: "Max drawdown", value: `${data.max_drawdown.toFixed(2)}%`, cls: "text-accent-sell" },
    { label: "Sharpe", value: data.sharpe.toFixed(2) },
    { label: "Avg RR achieved", value: data.avg_rr_achieved.toFixed(2), cls: data.avg_rr_achieved >= 1 ? "text-accent-buy" : undefined },
    { label: "Final equity", value: fmtINR(data.final_equity, false) },
  ];

  const perPattern = useMemo(() => {
    return Object.entries(data.by_pattern)
      .map(([name, r]) => ({ name, ...r }))
      .sort((a, b) => b.pnl_total - a.pnl_total);
  }, [data]);

  return (
    <div className="rounded-xl border border-accent-info/40 bg-accent-info/5">
      <div className="px-5 pt-4 pb-2 text-sm uppercase tracking-wider text-slate-500">
        Pattern backtest · {data.symbol} · {data.timeframe}
      </div>
      <div className="grid grid-cols-3 md:grid-cols-4 gap-3 px-5 py-3 border-b border-bg-border">
        {cells.map((c) => (
          <div key={c.label}>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{c.label}</div>
            <div className={clsx("text-base font-mono tabular-nums", c.cls ?? "text-white")}>{c.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
        <PanelBox title="Equity curve">
          <EquityChart points={data.equity_curve.map((p) => ({ t: p.t, value: p.equity }))} />
        </PanelBox>
        <PanelBox title="Per-pattern P&L">
          <PerPatternTable rows={perPattern} />
        </PanelBox>
      </div>

      <PatternTradeLog trades={data.trade_log} />
    </div>
  );
}

function PerPatternTable({ rows }: { rows: Array<{ name: string; trades: number; wins: number; losses: number; win_rate: number; avg_pnl: number; pnl_total: number; best_trade: number; worst_trade: number }> }) {
  if (rows.length === 0) {
    return <div className="text-xs text-slate-500 py-3">No pattern triggered.</div>;
  }
  return (
    <div className="max-h-48 overflow-y-auto">
      <table className="w-full text-xs font-mono">
        <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-bg-panel-solid">
          <tr>
            <th className="text-left px-2 py-1">Pattern</th>
            <th className="text-right px-2 py-1">N</th>
            <th className="text-right px-2 py-1">Win%</th>
            <th className="text-right px-2 py-1">Avg</th>
            <th className="text-right px-2 py-1">Total</th>
            <th className="text-right px-2 py-1">Best</th>
            <th className="text-right px-2 py-1">Worst</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-bg-border">
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="px-2 py-1 text-slate-200 truncate">{r.name}</td>
              <td className="px-2 py-1 text-right text-slate-300">{r.trades}</td>
              <td className={clsx("px-2 py-1 text-right", r.win_rate >= 0.5 ? "text-accent-buy" : "text-accent-sell")}>{(r.win_rate * 100).toFixed(0)}%</td>
              <td className={clsx("px-2 py-1 text-right", r.avg_pnl >= 0 ? "text-accent-buy" : "text-accent-sell")}>{r.avg_pnl.toFixed(0)}</td>
              <td className={clsx("px-2 py-1 text-right", r.pnl_total >= 0 ? "text-accent-buy" : "text-accent-sell")}>{r.pnl_total.toFixed(0)}</td>
              <td className="px-2 py-1 text-right text-accent-buy">{r.best_trade.toFixed(0)}</td>
              <td className="px-2 py-1 text-right text-accent-sell">{r.worst_trade.toFixed(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PatternTradeLog({ trades }: { trades: PatternBacktestResult["trade_log"] }) {
  return (
    <section className="border-t border-bg-border">
      <div className="px-5 py-3 text-sm uppercase tracking-wider text-slate-500">Trade log · {trades.length}</div>
      {trades.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400 text-center">No trades. Lower min confidence or widen the date range.</div>
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-xs font-mono">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-bg-panel-solid">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Pattern</th>
                <th className="text-left px-3 py-2">Dir</th>
                <th className="text-right px-3 py-2">Qty</th>
                <th className="text-right px-3 py-2">Entry</th>
                <th className="text-right px-3 py-2">Exit</th>
                <th className="text-right px-3 py-2">P&L</th>
                <th className="text-right px-3 py-2">%</th>
                <th className="text-right px-3 py-2">RR</th>
                <th className="text-right px-3 py-2">Hold</th>
                <th className="text-center px-3 py-2">Out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {trades.map((t, i) => {
                return (
                  <tr key={i}>
                    <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                    <td className="px-3 py-1.5 text-slate-400">{fmtTime(t.exit_t)}</td>
                    <td className="px-3 py-1.5 text-slate-200">{t.pattern_name}</td>
                    <td className={clsx("px-3 py-1.5", t.direction === "bullish" ? "text-accent-buy" : t.direction === "bearish" ? "text-accent-sell" : "text-amber-400")}>{t.direction}</td>
                    <td className="px-3 py-1.5 text-right text-slate-300">{t.qty}</td>
                    <td className="px-3 py-1.5 text-right text-slate-300">{t.entry.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-300">{t.exit.toFixed(2)}</td>
                    <td className={clsx("px-3 py-1.5 text-right", t.pnl >= 0 ? "text-accent-buy" : "text-accent-sell")}>{t.pnl.toFixed(2)}</td>
                    <td className={clsx("px-3 py-1.5 text-right", t.pnl_pct >= 0 ? "text-accent-buy" : "text-accent-sell")}>{t.pnl_pct.toFixed(2)}%</td>
                    <td className="px-3 py-1.5 text-right text-slate-400">{t.rr_achieved.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-400">{t.hold_bars}</td>
                    <td className="px-3 py-1.5 text-center">
                      <span className={clsx(
                        "px-1.5 py-0.5 rounded text-[10px] font-bold",
                        t.outcome === "win" ? "bg-accent-buy/15 text-accent-buy" :
                        t.outcome === "loss" ? "bg-accent-sell/15 text-accent-sell" :
                        t.outcome === "breakeven" ? "bg-slate-500/15 text-slate-300" :
                        "bg-amber-500/15 text-amber-400"
                      )}>
                        {t.outcome === "win" ? "W" : t.outcome === "loss" ? "L" : t.outcome === "breakeven" ? "BE" : "EXP"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
