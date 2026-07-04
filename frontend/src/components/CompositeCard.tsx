import { useEffect, useState } from "react";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "../lib/api";
import { fetchLatestPatterns, type PatternDoc } from "../lib/patternApi";
import { apiErrorMessage } from "../lib/errors";

interface CompositeSignal {
  name: string;
  signal: -1 | 0 | 1;
  confidence: number;
  reason: string;
  metadata: Record<string, unknown>;
}

interface CompositeResponse {
  symbol: string;
  asof: string;
  bars: number;
  composite_score: number;
  weighted_score: number;
  recommendation: "STRONG BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG SELL";
  confidence: number;
  weights: Record<string, number>;
  signals: Record<string, CompositeSignal>;
  context?: {
    peer_index_bars?: number;
    ad_ratio?: number | null;
    news_proxy_score?: number | null;
  };
}

const STRATEGY_ORDER = ["trend", "reversion", "breakout", "pairs", "sentiment"];
const STRATEGY_LABEL: Record<string, string> = {
  trend: "Trend Following",
  reversion: "Mean Reversion",
  breakout: "Breakout",
  pairs: "Pairs Trading",
  // Phase 11 — renamed from "Macro Sentiment". The sub-signal scoring still
  // comes from the macro sentiment layer; the live pattern contribution is
  // displayed inline as a separate badge underneath.
  sentiment: "Sentiment + Pattern",
};

const DEFAULT_WEIGHTS: Record<string, number> = {
  trend: 0.25,
  reversion: 0.15,
  breakout: 0.25,
  pairs: 0.10,
  sentiment: 0.25,
};

export default function CompositeCard({ symbol }: { symbol: string }) {
  const [data, setData] = useState<CompositeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showWeights, setShowWeights] = useState(false);
  const [weights, setWeights] = useState<Record<string, number>>(DEFAULT_WEIGHTS);
  // Phase 11 — top recent pattern shown inline beneath the Sentiment row.
  const [topPattern, setTopPattern] = useState<PatternDoc | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let aborted = false;
    fetchLatestPatterns(symbol, 5).then((res) => {
      if (aborted) return;
      const best = (res?.patterns ?? [])
        .filter((p) => (p.confidence_score ?? 0) >= 60)
        .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))[0];
      setTopPattern(best ?? null);
    });
    return () => { aborted = true; };
  }, [symbol]);

  async function load(customWeights?: Record<string, number>) {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    try {
      if (customWeights) {
        const { data } = await api.post(`/api/composite/${symbol}`, { weights: customWeights });
        setData(data as CompositeResponse);
      } else {
        const { data } = await api.get(`/api/composite/${symbol}`);
        setData(data as CompositeResponse);
        setWeights(data.weights ?? DEFAULT_WEIGHTS);
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Composite failed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [symbol]);

  if (loading && !data) {
    return <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5 text-slate-400 text-sm">Computing composite signal…</div>;
  }

  if (error && !data) {
    return (
      <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5">
        <div className="text-sm uppercase tracking-wider text-slate-500 mb-2">Composite Signal</div>
        <div className="text-sm text-accent-sell">{error}</div>
        <button onClick={() => void load()} className="mt-2 text-xs text-accent-info hover:underline">Retry</button>
      </div>
    );
  }

  if (!data) return null;

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const weightsValid = Math.abs(total - 1.0) < 0.02;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5"
    >
      <div className="flex items-start justify-between mb-3">
        <button onClick={() => setCollapsed((c) => !c)} className="text-left flex-1">
          <div className="text-sm uppercase tracking-wider text-slate-500 flex items-center gap-2">
            Gainz Alpha Signals
            <span className="text-[10px] text-slate-500">{collapsed ? "▶" : "▼"}</span>
          </div>
          <div className="text-xs text-slate-500">5-layer ensemble · {data.bars} bars</div>
        </button>
        <RecommendationBadge recommendation={data.recommendation} />
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Gauge score={data.composite_score} />

            <div className="mt-4 space-y-2">
              {STRATEGY_ORDER.map((name) => {
                const sig = data.signals[name];
                const w = weights[name] ?? data.weights[name];
                if (!sig) return null;
                return (
                  <div key={name}>
                    <SignalRow label={STRATEGY_LABEL[name] ?? name} signal={sig} weight={w} />
                    {/* Inline pattern contribution shown beneath the sentiment row only. */}
                    {name === "sentiment" && topPattern && (
                      <div className="ml-3 pl-3 border-l border-bg-border mt-1 text-[10px] text-slate-400">
                        <div className="flex items-center gap-2">
                          <span className={clsx(
                            topPattern.direction === "bullish" ? "text-accent-buy" :
                            topPattern.direction === "bearish" ? "text-accent-sell" : "text-amber-400"
                          )}>{topPattern.direction === "bullish" ? "▲" : topPattern.direction === "bearish" ? "▼" : "●"}</span>
                          <span className="text-slate-300">{topPattern.pattern_name}</span>
                          {topPattern.grade && <span className={clsx(
                            "px-1 py-0.5 rounded text-[8px] font-bold",
                            topPattern.grade === "A+" ? "bg-emerald-500/20 text-emerald-300" :
                            topPattern.grade === "A" ? "bg-emerald-500/15 text-emerald-400" :
                            topPattern.grade === "B" ? "bg-amber-500/15 text-amber-400" :
                            "bg-slate-500/15 text-slate-400"
                          )}>{topPattern.grade}</span>}
                          <span className="ml-auto font-mono text-slate-500">live pattern · {topPattern.confidence_score}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {data.context && (
              <div className="mt-3 pt-3 border-t border-bg-border text-[10px] text-slate-500 font-mono space-y-0.5">
                {data.context.peer_index_bars != null && <div>peer index bars: {data.context.peer_index_bars}</div>}
                {data.context.ad_ratio != null && <div>A/D ratio: {data.context.ad_ratio.toFixed(2)}</div>}
                {data.context.news_proxy_score != null && <div>news proxy: {data.context.news_proxy_score.toFixed(2)}</div>}
              </div>
            )}

            <div className="mt-3 pt-3 border-t border-bg-border">
              <button
                onClick={() => setShowWeights((s) => !s)}
                className="text-[11px] text-accent-info hover:text-white uppercase tracking-wider"
              >
                {showWeights ? "Hide weights" : "Adjust weights"}
              </button>
              {showWeights && (
                <div className="mt-3 space-y-2">
                  {STRATEGY_ORDER.map((name) => (
                    <WeightSlider
                      key={name}
                      label={STRATEGY_LABEL[name]}
                      value={weights[name] ?? 0}
                      onChange={(v) => setWeights((w) => ({ ...w, [name]: v }))}
                    />
                  ))}
                  <div className={clsx("text-[11px] font-mono flex justify-between", weightsValid ? "text-slate-400" : "text-accent-sell")}>
                    <span>Sum: {(total * 100).toFixed(1)}%</span>
                    <span className="text-slate-500">should equal 100%</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void load(weights)}
                      disabled={loading || !weightsValid}
                      className="bg-accent-info text-white rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    >
                      {loading ? "Recalculating…" : "Recalculate"}
                    </button>
                    <button
                      onClick={() => { setWeights(DEFAULT_WEIGHTS); void load(); }}
                      className="border border-bg-border text-slate-400 hover:text-white rounded-md px-3 py-1.5 text-xs"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function WeightSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-400 w-32 shrink-0">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-accent-info"
      />
      <span className="text-xs font-mono tabular-nums w-12 text-right text-slate-300">{(value * 100).toFixed(0)}%</span>
    </div>
  );
}

function RecommendationBadge({ recommendation }: { recommendation: CompositeResponse["recommendation"] }) {
  const styles: Record<CompositeResponse["recommendation"], string> = {
    "STRONG BUY": "bg-accent-buy/20 text-accent-buy border-accent-buy/60",
    BUY: "bg-accent-buy/10 text-accent-buy border-accent-buy/30",
    NEUTRAL: "bg-slate-500/15 text-slate-300 border-slate-500/30",
    SELL: "bg-accent-sell/10 text-accent-sell border-accent-sell/30",
    "STRONG SELL": "bg-accent-sell/20 text-accent-sell border-accent-sell/60",
  };
  return <div className={clsx("px-3 py-1.5 rounded-full text-xs font-bold border whitespace-nowrap", styles[recommendation])}>{recommendation}</div>;
}

function Gauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const angle = -90 + (clamped / 100) * 180;
  return (
    <div className="relative h-32 flex flex-col items-center justify-end">
      <svg viewBox="0 0 200 110" className="w-full max-w-xs">
        <defs>
          <linearGradient id="gauge-grad" x1="0%" x2="100%" y1="0%" y2="0%">
            <stop offset="0%" stopColor="#ea3943" />
            <stop offset="40%" stopColor="#f0b90b" />
            <stop offset="60%" stopColor="#f0b90b" />
            <stop offset="100%" stopColor="#16c784" />
          </linearGradient>
        </defs>
        <path d="M 15 100 A 85 85 0 0 1 185 100" fill="none" stroke="#1f2a3d" strokeWidth="14" strokeLinecap="round" />
        <path d="M 15 100 A 85 85 0 0 1 185 100" fill="none" stroke="url(#gauge-grad)" strokeWidth="14" strokeLinecap="round" strokeDasharray={`${(clamped / 100) * 267} 267`} />
        {[0, 25, 50, 75, 100].map((t) => {
          const a = (-90 + (t / 100) * 180) * (Math.PI / 180);
          return <line key={t} x1={100 + Math.cos(a) * 65} y1={100 + Math.sin(a) * 65} x2={100 + Math.cos(a) * 75} y2={100 + Math.sin(a) * 75} stroke="#475569" strokeWidth="1" />;
        })}
        <motion.line
          x1="100" y1="100" x2="100" y2="35" stroke="#e2e8f0" strokeWidth="2.5" strokeLinecap="round"
          initial={{ rotate: -90 }} animate={{ rotate: angle }} transition={{ type: "spring", stiffness: 140, damping: 22 }}
          style={{ transformOrigin: "100px 100px" }}
        />
        <circle cx="100" cy="100" r="6" fill="#e2e8f0" />
      </svg>
      <div className="-mt-4 text-center">
        <div className="text-3xl font-mono tabular-nums text-white">{clamped.toFixed(1)}</div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500">composite / 100</div>
      </div>
    </div>
  );
}

function SignalRow({ label, signal, weight }: { label: string; signal: CompositeSignal; weight?: number }) {
  const sign = signal.signal;
  const tone = sign > 0 ? "buy" : sign < 0 ? "sell" : "neutral";
  return (
    <div
      className="bg-bg-elevated/40 border border-bg-border rounded-lg px-3 py-2 group relative"
      title={signal.reason}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={clsx("w-1.5 h-1.5 rounded-full", tone === "buy" ? "bg-accent-buy" : tone === "sell" ? "bg-accent-sell" : "bg-slate-500")} />
          <span className="text-sm text-slate-200">{label}</span>
          {weight != null && <span className="text-[10px] text-slate-500 font-mono">w={(weight * 100).toFixed(0)}%</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className={clsx("text-xs font-bold px-1.5 py-0.5 rounded", tone === "buy" ? "bg-accent-buy/15 text-accent-buy" : tone === "sell" ? "bg-accent-sell/15 text-accent-sell" : "bg-slate-500/15 text-slate-400")}>
            {sign > 0 ? "LONG" : sign < 0 ? "SHORT" : "FLAT"}
          </span>
          <div className="w-16 h-1.5 rounded bg-bg-elevated overflow-hidden">
            <div className={clsx("h-full", tone === "buy" ? "bg-accent-buy" : tone === "sell" ? "bg-accent-sell" : "bg-slate-500")} style={{ width: `${Math.round(signal.confidence * 100)}%` }} />
          </div>
          <span className="text-[10px] font-mono text-slate-400 w-8 text-right">{Math.round(signal.confidence * 100)}%</span>
        </div>
      </div>
      <div className="text-[11px] text-slate-400 leading-snug">{signal.reason}</div>
    </div>
  );
}
