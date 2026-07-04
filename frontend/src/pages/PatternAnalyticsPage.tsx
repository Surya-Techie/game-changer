import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { api } from "../lib/api";
import {
  fetchPatternAnalytics,
  type AnalyticsBundle,
  type AnalyticsParams,
  type LeaderboardRow,
} from "../lib/patternApi";
import PowerAnalysisPanel from "../components/PowerAnalysisPanel";
import SymbolSearchInput from "../components/SymbolSearchInput";

/**
 * Pattern Analytics dashboard — Phase 10.
 *
 * 5 summary cards + 5 SVG charts + leaderboard + filter controls. Reads
 * /api/patterns/analytics, which aggregates from MongoDB on demand.
 * Matches PaperAnalyticsPage visual conventions (no external chart deps).
 */

const TIMEFRAMES = ["M5", "M15", "H1", "D1"] as const;
const DIRECTIONS = ["bullish", "bearish", "continuation", "neutral"] as const;

const EMPTY_SUMMARY: AnalyticsBundle["summary"] = {
  total_detected: 0,
  resolved: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  overall_win_rate: 0,
  avg_rr_achieved: 0,
  last_24h_count: 0,
  best_pattern: null,
};

/** Fill in any missing fields on an analytics bundle so the renderer never
 *  has to defend against `undefined`. Backend may return partial payloads
 *  while the data layer is still being wired (e.g. Mongo connected but
 *  empty collection, or an old build returning {error: ...}). */
function normaliseBundle(raw: Partial<AnalyticsBundle> | null | undefined): AnalyticsBundle {
  return {
    filter: raw?.filter ?? { since: "", until: "", symbols: [], timeframes: [], directions: [] },
    summary: { ...EMPTY_SUMMARY, ...(raw?.summary ?? {}) },
    win_rate_by_pattern: Array.isArray(raw?.win_rate_by_pattern) ? raw!.win_rate_by_pattern : [],
    pnl_by_timeframe: Array.isArray(raw?.pnl_by_timeframe) ? raw!.pnl_by_timeframe : [],
    frequency_heatmap: Array.isArray(raw?.frequency_heatmap) ? raw!.frequency_heatmap : [],
    confidence_vs_winrate: Array.isArray(raw?.confidence_vs_winrate) ? raw!.confidence_vs_winrate : [],
    daily_volume: Array.isArray(raw?.daily_volume) ? raw!.daily_volume : [],
    leaderboard: Array.isArray(raw?.leaderboard) ? raw!.leaderboard : [],
  };
}
const RANGE_PRESETS: Array<{ id: string; label: string; days: number }> = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "1y", label: "Last 1 year", days: 365 },
];

export default function PatternAnalyticsPage() {
  const [searchParams] = useSearchParams();
  const [bundle, setBundle] = useState<AnalyticsBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters.
  const [rangePreset, setRangePreset] = useState("30d");
  const [symbolsInput, setSymbolsInput] = useState(searchParams.get("symbol") ?? "");
  const [timeframes, setTimeframes] = useState<string[]>([]);
  const [directions, setDirections] = useState<string[]>([]);

  // The symbol handed to the heavy panels (chart / power analysis / Chan
  // advisor) and to the analytics query. It changes ONLY when the user
  // commits — picks a suggestion or presses Enter — never while typing,
  // so half-typed tickers ("ZOMA…") fire zero API calls.
  const [panelSymbol, setPanelSymbol] = useState(
    (searchParams.get("symbol") ?? "").split(",")[0]?.trim().toUpperCase() || "RELIANCE"
  );
  const [appliedSymbols, setAppliedSymbols] = useState<string>(searchParams.get("symbol") ?? "");
  const commitSymbols = (picked?: string) => {
    // Note: on suggestion pick this closure still sees the pre-pick input,
    // whose last segment is the partial query — replace it with the picked
    // symbol rather than appending alongside it.
    const list = symbolsInput.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (picked) {
      if (list.length) list[list.length - 1] = picked;
      else list.push(picked);
    }
    const unique = [...new Set(list)];
    setAppliedSymbols(unique.join(","));
    setPanelSymbol(picked || unique[0] || "RELIANCE");
  };

  const params: AnalyticsParams = useMemo(() => {
    const preset = RANGE_PRESETS.find((p) => p.id === rangePreset) ?? RANGE_PRESETS[1];
    const until = new Date();
    const since = new Date(until.getTime() - preset.days * 24 * 60 * 60 * 1000);
    // Committed (Enter / suggestion pick) symbols only — not raw keystrokes.
    const syms = appliedSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    return {
      since: since.toISOString(),
      until: until.toISOString(),
      symbols: syms,
      timeframes: timeframes as Array<"M5" | "M15" | "H1" | "D1">,
      directions: directions as Array<"bullish" | "bearish" | "continuation" | "neutral">,
    };
  }, [rangePreset, appliedSymbols, timeframes, directions]);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    fetchPatternAnalytics(params)
      .then((data) => {
        if (aborted) return;
        if (!data) {
          setError("Analytics service unavailable.");
          setBundle(null);
          return;
        }
        // Normalise: the backend may return an empty / partial payload when
        // Mongo has no patterns yet, or when the route exists but the data
        // layer hasn't been wired. Fill in safe defaults so the renderer
        // never has to defend against missing fields.
        setBundle(normaliseBundle(data));
      })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [params.since, params.until, params.symbols?.join(","), params.timeframes?.join(","), params.directions?.join(",")]);

  function toggleSet(set: string[], v: string, setter: (s: string[]) => void) {
    setter(set.includes(v) ? set.filter((x) => x !== v) : [...set, v]);
  }

  return (
    <div className="min-h-full bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4 flex items-center justify-between">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
          <h1 className="text-xl font-semibold text-white">Pattern Analytics</h1>
          <div className="text-xs text-slate-500">Win-rate and frequency rollups across the detected patterns.</div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/patterns/pps"
            className="text-xs font-medium px-3 py-1.5 rounded border border-accent-buy/40 bg-accent-buy/10 text-accent-buy hover:bg-accent-buy/20 transition-colors"
          >
            PPS Signals →
          </Link>
          <div className="text-xs text-slate-500 font-mono">
            {loading
              ? "Updating…"
              : bundle?.summary?.total_detected != null
                ? `${bundle.summary.total_detected.toLocaleString()} patterns in window`
                : "—"}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <FilterBar
          rangePreset={rangePreset}
          onRange={setRangePreset}
          symbolsInput={symbolsInput}
          onCommitSymbol={(s) => commitSymbols(s)}
          onSymbols={setSymbolsInput}
          timeframes={timeframes}
          onTimeframes={(v) => toggleSet(timeframes, v, setTimeframes)}
          directions={directions}
          onDirections={(v) => toggleSet(directions, v, setDirections)}
        />

        {/* Power Analysis — THE signal panel. One chart, one POWER mode,
            BUY/SELL arrows + levels + per-bar verdict timeline. The old
            duplicate pattern chart and advisor card were removed: three
            overlapping chart panels made the page confusing without
            adding signal. */}
        <PowerAnalysisPanel symbol={panelSymbol} onSymbolChange={(s) => setSymbolsInput(s)} />

        {/* Measured (backtested) per-pattern performance — the ground truth
            the AI confidence engine is calibrated against. Collapsed by
            default; reference material, not a live control. */}
        <CalibrationPanel />

        {error && <div className="text-sm text-accent-sell">{error}</div>}

        {!bundle && !loading && !error && (
          <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-8 text-center text-slate-400">
            Choose a window above to load analytics.
          </div>
        )}
        {bundle && bundle.summary && (
          <>
            <SummaryCards summary={bundle.summary} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card title="Win rate by pattern (top 25)">
                <WinRateBars rows={(bundle.win_rate_by_pattern ?? []).slice(0, 25)} />
              </Card>
              <Card title="Confidence score vs realised win rate">
                <ConfidenceScatter buckets={bundle.confidence_vs_winrate ?? []} />
              </Card>
              <Card title="P&L by timeframe (net R)">
                <TimeframeBars rows={bundle.pnl_by_timeframe ?? []} />
              </Card>
              <Card title="Daily detection volume">
                <DailyVolumeChart points={bundle.daily_volume ?? []} />
              </Card>
              <Card title="Pattern frequency heatmap" wide>
                <FrequencyHeatmap cells={bundle.frequency_heatmap ?? []} />
              </Card>
            </div>

            <Leaderboard rows={bundle.leaderboard ?? []} />
          </>
        )}
      </main>
    </div>
  );
}

// ─── Measured calibration panel ─────────────────────────────────────────────

interface CalibrationRow {
  pattern_name: string;
  win_rate: number;
  expectancy_r: number;
  samples: number;
  resolved: number;
  expired: number;
  verdict: "TRADEABLE" | "MARGINAL" | "AVOID";
}

function CalibrationPanel() {
  const [rows, setRows] = useState<CalibrationRow[]>([]);
  const [meta, setMeta] = useState<{ source?: string; total_trades?: number; generated?: string } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let aborted = false;
    api.get("/api/patterns/calibration")
      .then((r) => {
        if (aborted || !r.data?.available) return;
        setRows(r.data.patterns ?? []);
        setMeta(r.data.meta ?? null);
      })
      .catch(() => {});
    return () => { aborted = true; };
  }, []);

  if (rows.length === 0) return null;

  const tradeable = rows.filter((r) => r.verdict === "TRADEABLE").length;
  const avoid = rows.filter((r) => r.verdict === "AVOID").length;

  return (
    <section className="card-aurora rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-5 py-3 flex items-center justify-between text-left"
      >
        <div>
          <div className="text-sm font-semibold text-white">
            Measured pattern performance <span className="text-[10px] font-mono text-emerald-400/90 ml-1">REAL BACKTEST</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {meta?.source ?? "walk-forward event study"} · {meta?.total_trades ?? "—"} simulated trades ·
            {" "}{tradeable} tradeable · {avoid} confidence-penalised. This is what the AI confidence engine is calibrated against.
          </div>
        </div>
        <span className="text-slate-500 text-xs font-mono">{open ? "▲ collapse" : "▼ expand"}</span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-bg-border">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500 bg-black/10">
              <tr>
                <th className="text-left px-4 py-2.5">Pattern</th>
                <th className="text-center px-3 py-2.5">Verdict</th>
                <th className="text-right px-3 py-2.5 font-mono">Expectancy</th>
                <th className="text-right px-3 py-2.5 font-mono">Win rate*</th>
                <th className="text-right px-3 py-2.5 font-mono">Samples</th>
                <th className="text-right px-3 py-2.5 font-mono">Resolved</th>
                <th className="text-right px-4 py-2.5 font-mono">Expired</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {rows.map((r) => (
                <tr key={r.pattern_name} className="hover:bg-white/[0.01]">
                  <td className="px-4 py-1.5 text-slate-200">{r.pattern_name}</td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={clsx(
                      "px-1.5 py-0.5 rounded text-[10px] font-bold",
                      r.verdict === "TRADEABLE" ? "bg-accent-buy/15 text-accent-buy" :
                      r.verdict === "AVOID" ? "bg-accent-sell/15 text-accent-sell" :
                      "bg-slate-500/15 text-slate-400"
                    )}>{r.verdict}</span>
                  </td>
                  <td className={clsx("px-3 py-1.5 text-right font-mono",
                    r.expectancy_r >= 0.05 ? "text-accent-buy" : r.expectancy_r <= -0.05 ? "text-accent-sell" : "text-slate-300")}>
                    {r.expectancy_r >= 0 ? "+" : ""}{r.expectancy_r.toFixed(3)}R
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-300">{(r.win_rate * 100).toFixed(0)}%</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-400">{r.samples}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-400">{r.resolved}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-slate-500">{r.expired}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-2 text-[10px] text-slate-500 border-t border-bg-border">
            *Win rate is shrunk toward 50% for small samples (Bayesian prior), so thin patterns can't claim extreme rates.
            Patterns marked AVOID get a confidence penalty of up to −25 points in the live engine, keeping them below emit thresholds.
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────

interface FilterProps {
  rangePreset: string;
  onRange: (s: string) => void;
  symbolsInput: string;
  onSymbols: (s: string) => void;
  onCommitSymbol: (symbol: string) => void;
  timeframes: string[];
  onTimeframes: (s: string) => void;
  directions: string[];
  onDirections: (s: string) => void;
}

function FilterBar({
  rangePreset,
  onRange,
  symbolsInput,
  onSymbols,
  onCommitSymbol,
  timeframes,
  onTimeframes,
  directions,
  onDirections,
}: FilterProps) {
  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Range</span>
          {RANGE_PRESETS.map((r) => (
            <button
              key={r.id}
              onClick={() => onRange(r.id)}
              className={clsx(
                "text-xs px-2 py-1 rounded border",
                rangePreset === r.id ? "border-accent-info text-white bg-accent-info/10" : "border-bg-border text-slate-400 hover:text-slate-200"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Timeframes</span>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => onTimeframes(tf)}
              className={clsx(
                "text-xs px-2 py-1 rounded border font-mono",
                timeframes.includes(tf) ? "border-accent-info text-white bg-accent-info/10" : "border-bg-border text-slate-400 hover:text-slate-200"
              )}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Direction</span>
          {DIRECTIONS.map((d) => (
            <button
              key={d}
              onClick={() => onDirections(d)}
              className={clsx(
                "text-xs px-2 py-1 rounded border",
                directions.includes(d) ? "border-accent-info text-white bg-accent-info/10" : "border-bg-border text-slate-400 hover:text-slate-200"
              )}
            >
              {d}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Symbols</span>
          <SymbolSearchInput
            value={symbolsInput}
            onChange={onSymbols}
            onCommit={onCommitSymbol}
            placeholder="Search symbol or company, Enter to run…"
            className="w-[280px]"
          />
        </label>
      </div>
    </section>
  );
}


// ─── Summary cards ────────────────────────────────────────────────────────

function SummaryCards({ summary }: { summary: AnalyticsBundle["summary"] }) {
  const wrColor = summary.overall_win_rate >= 0.55 ? "text-accent-buy" : summary.overall_win_rate >= 0.45 ? "text-slate-200" : "text-accent-sell";
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Stat label="Total patterns detected" value={summary.total_detected.toLocaleString()} />
      <Stat
        label="Overall win rate"
        value={summary.resolved > 0 ? `${(summary.overall_win_rate * 100).toFixed(1)}%` : "—"}
        sub={`${summary.wins} W / ${summary.losses} L / ${summary.breakevens} BE`}
        cls={wrColor}
      />
      <Stat
        label="Best pattern (≥10 trades)"
        value={summary.best_pattern ? `${(summary.best_pattern.win_rate * 100).toFixed(0)}%` : "—"}
        sub={summary.best_pattern ? `${summary.best_pattern.pattern_name} · ${summary.best_pattern.trades} trades` : "Insufficient data"}
        cls={summary.best_pattern ? "text-accent-buy" : undefined}
      />
      <Stat
        label="Avg realised RR"
        value={summary.avg_rr_achieved.toFixed(2)}
        cls={summary.avg_rr_achieved >= 1.0 ? "text-accent-buy" : undefined}
      />
      <Stat label="Patterns in last 24h" value={summary.last_24h_count.toLocaleString()} />
    </div>
  );
}

function Stat({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("text-2xl font-mono tabular-nums mt-1", cls ?? "text-white")}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Card({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={clsx("bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4", wide && "lg:col-span-2")}>
      <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-3">{title}</div>
      {children}
    </div>
  );
}


// ─── Charts (inline SVG) ──────────────────────────────────────────────────

function WinRateBars({ rows }: { rows: AnalyticsBundle["win_rate_by_pattern"] }) {
  if (rows.length === 0) return <EmptyMsg msg="No resolved patterns yet — need at least 5 outcomes per name." />;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.pattern_name} className="text-xs">
          <div className="flex justify-between mb-0.5">
            <span className="text-slate-200 truncate">{r.pattern_name}</span>
            <span className="font-mono text-slate-300">{(r.win_rate * 100).toFixed(1)}% · {r.wins}/{r.trades}</span>
          </div>
          <div className="h-1.5 bg-bg-border rounded">
            <div
              className={clsx("h-full rounded", r.win_rate >= 0.6 ? "bg-accent-buy" : r.win_rate >= 0.5 ? "bg-amber-500" : "bg-accent-sell")}
              style={{ width: `${r.win_rate * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function TimeframeBars({ rows }: { rows: AnalyticsBundle["pnl_by_timeframe"] }) {
  if (rows.length === 0) return <EmptyMsg msg="No resolved patterns in window." />;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net_r)));
  const w = 600;
  const h = 180;
  const mid = h / 2;
  const bw = (w - 40) / Math.max(rows.length, 1);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <line x1="20" x2={w - 20} y1={mid} y2={mid} stroke="#3b4660" />
      {rows.map((r, i) => {
        const x = 20 + i * bw + 4;
        const barW = bw - 8;
        const barH = (Math.abs(r.net_r) / max) * (mid - 18);
        const y = r.net_r >= 0 ? mid - barH : mid;
        const fill = r.net_r >= 0 ? "#16c784" : "#ea3943";
        return (
          <g key={r.timeframe}>
            <rect x={x} y={y} width={barW} height={Math.max(1, barH)} fill={fill} rx={2} />
            <text x={x + barW / 2} y={r.net_r >= 0 ? y - 4 : y + barH + 12} textAnchor="middle" fontSize={10} fill="#cbd5e1" fontFamily="monospace">
              {r.net_r >= 0 ? "+" : ""}{r.net_r.toFixed(1)}R
            </text>
            <text x={x + barW / 2} y={h - 6} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
              {r.timeframe} · {r.trades}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ConfidenceScatter({ buckets }: { buckets: AnalyticsBundle["confidence_vs_winrate"] }) {
  if (buckets.length === 0) return <EmptyMsg msg="Resolve some pending patterns to calibrate." />;
  const w = 600;
  const h = 180;
  const pad = 24;
  const fx = (b: number) => pad + ((b - 30) / 70) * (w - 2 * pad); // map 30..100
  const fy = (wr: number) => h - pad - wr * (h - 2 * pad);
  const idealLine = (
    <line
      x1={fx(50)}
      y1={fy(0.5)}
      x2={fx(100)}
      y2={fy(1.0)}
      stroke="#3b4660"
      strokeDasharray="3 3"
    />
  );
  const maxN = Math.max(...buckets.map((b) => b.trades), 1);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      {/* gridlines */}
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={pad} x2={w - pad} y1={fy(g)} y2={fy(g)} stroke="#1f2a3d" strokeDasharray="2 4" />
      ))}
      {/* y-axis labels */}
      {[0, 0.5, 1.0].map((g) => (
        <text key={g} x={4} y={fy(g) + 3} fontSize={9} fill="#64748b" fontFamily="monospace">
          {(g * 100).toFixed(0)}%
        </text>
      ))}
      {/* x-axis labels */}
      {[40, 60, 80, 100].map((b) => (
        <text key={b} x={fx(b)} y={h - 6} fontSize={9} fill="#64748b" textAnchor="middle" fontFamily="monospace">
          {b}
        </text>
      ))}
      {idealLine}
      {buckets.map((b) => {
        const x = fx((b.bucket_lo + b.bucket_hi) / 2);
        const y = fy(b.win_rate);
        const r = 3 + (b.trades / maxN) * 10; // bubble size = sample count
        const color = b.win_rate >= 0.55 ? "#16c784" : b.win_rate >= 0.45 ? "#f59e0b" : "#ea3943";
        return (
          <g key={b.bucket}>
            <circle cx={x} cy={y} r={r} fill={color} fillOpacity="0.6" stroke={color} />
            <title>{`${b.bucket}% confidence → ${(b.win_rate * 100).toFixed(1)}% win rate (${b.wins}/${b.trades})`}</title>
          </g>
        );
      })}
      <text x={w / 2} y={h - 18} textAnchor="middle" fontSize={9} fill="#64748b" fontFamily="monospace">
        confidence score
      </text>
      <text x={w / 2} y={14} textAnchor="middle" fontSize={9} fill="#64748b" fontFamily="monospace">
        dashed = ideal calibration (confidence = win rate)
      </text>
    </svg>
  );
}

function DailyVolumeChart({ points }: { points: AnalyticsBundle["daily_volume"] }) {
  if (points.length === 0) return <EmptyMsg msg="No detections in window." />;
  const w = 600;
  const h = 180;
  const pad = 22;
  const max = Math.max(1, ...points.map((p) => p.count));
  const fx = (i: number) => pad + (i / Math.max(1, points.length - 1)) * (w - 2 * pad);
  const fy = (n: number) => h - pad - (n / max) * (h - 2 * pad);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${fx(i)} ${fy(p.count)}`).join(" ");
  const area = `${path} L ${fx(points.length - 1)} ${h - pad} L ${fx(0)} ${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <defs>
        <linearGradient id="vol-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#vol-grad)" />
      <path d={path} stroke="#3b82f6" strokeWidth={1.5} fill="none" />
      {/* axis labels */}
      <text x={4} y={fy(max) + 3} fontSize={9} fill="#64748b" fontFamily="monospace">{max}</text>
      <text x={4} y={h - pad + 4} fontSize={9} fill="#64748b" fontFamily="monospace">0</text>
      <text x={pad} y={h - 6} fontSize={9} fill="#64748b" fontFamily="monospace">{points[0]?.date}</text>
      <text x={w - pad} y={h - 6} textAnchor="end" fontSize={9} fill="#64748b" fontFamily="monospace">{points[points.length - 1]?.date}</text>
    </svg>
  );
}

function FrequencyHeatmap({ cells }: { cells: AnalyticsBundle["frequency_heatmap"] }) {
  if (cells.length === 0) return <EmptyMsg msg="No patterns to map." />;
  const symbols = Array.from(new Set(cells.map((c) => c.symbol)));
  const patterns = Array.from(new Set(cells.map((c) => c.pattern_name)));
  // Sort by total counts (most frequent first).
  const symCount: Record<string, number> = {};
  const patCount: Record<string, number> = {};
  cells.forEach((c) => {
    symCount[c.symbol] = (symCount[c.symbol] ?? 0) + c.count;
    patCount[c.pattern_name] = (patCount[c.pattern_name] ?? 0) + c.count;
  });
  symbols.sort((a, b) => (symCount[b] ?? 0) - (symCount[a] ?? 0));
  patterns.sort((a, b) => (patCount[b] ?? 0) - (patCount[a] ?? 0));
  const max = Math.max(1, ...cells.map((c) => c.count));
  const byKey: Record<string, number> = {};
  cells.forEach((c) => { byKey[`${c.symbol}|${c.pattern_name}`] = c.count; });
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] font-mono border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th />
            {patterns.map((p) => (
              <th key={p} className="text-slate-500 font-normal text-left rotate-[-45deg] origin-bottom-left whitespace-nowrap pr-2 pb-2" style={{ height: 80 }}>
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {symbols.map((s) => (
            <tr key={s}>
              <td className="pr-2 text-slate-400 text-right">{s}</td>
              {patterns.map((p) => {
                const c = byKey[`${s}|${p}`] ?? 0;
                const intensity = c / max;
                const bg = c > 0 ? `rgba(59,130,246,${0.15 + intensity * 0.7})` : "rgba(31,42,61,0.4)";
                return (
                  <td key={p} title={`${s} · ${p}: ${c}`} style={{ background: bg, minWidth: 18, height: 18 }} className="text-center text-white">
                    {c > 0 ? c : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyMsg({ msg }: { msg: string }) {
  return <div className="h-32 flex items-center justify-center text-xs text-slate-500">{msg}</div>;
}


// ─── Leaderboard ──────────────────────────────────────────────────────────

function Leaderboard({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl overflow-hidden">
      <div className="px-5 pt-4 pb-2 text-sm uppercase tracking-wider text-slate-500">
        Pattern leaderboard · {rows.length}
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400 text-center">
          No resolved patterns yet — leaderboard surfaces names with ≥5 resolved trades.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Pattern</th>
                <th className="text-right px-3 py-2">Total</th>
                <th className="text-right px-3 py-2">Wins</th>
                <th className="text-right px-3 py-2">Losses</th>
                <th className="text-right px-3 py-2">Win %</th>
                <th className="text-right px-3 py-2">Avg RR</th>
                <th className="text-right px-3 py-2">Avg hold (d)</th>
                <th className="text-left px-3 py-2">Best symbol</th>
                <th className="text-center px-3 py-2">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {rows.map((r) => (
                <tr key={r.pattern_name}>
                  <td className="px-3 py-1.5 text-slate-200">{r.pattern_name}</td>
                  <td className="px-3 py-1.5 text-right text-slate-300">{r.total}</td>
                  <td className="px-3 py-1.5 text-right text-accent-buy">{r.wins}</td>
                  <td className="px-3 py-1.5 text-right text-accent-sell">{r.losses}</td>
                  <td className={clsx(
                    "px-3 py-1.5 text-right",
                    r.win_rate >= 0.6 ? "text-accent-buy" : r.win_rate >= 0.5 ? "text-amber-400" : "text-accent-sell"
                  )}>{(r.win_rate * 100).toFixed(1)}%</td>
                  <td className={clsx(
                    "px-3 py-1.5 text-right",
                    r.avg_rr >= 1.0 ? "text-accent-buy" : r.avg_rr < 0 ? "text-accent-sell" : "text-slate-300"
                  )}>{r.avg_rr.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right text-slate-400">{r.avg_hold_bars.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-slate-300">
                    {r.best_symbol ? `${r.best_symbol.symbol} (${r.best_symbol.wins}/${r.best_symbol.total})` : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    {r.trend === "rising" && <span className="text-accent-buy">▲ rising</span>}
                    {r.trend === "falling" && <span className="text-accent-sell">▼ falling</span>}
                    {r.trend === "flat" && <span className="text-slate-500">— flat</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
