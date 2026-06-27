import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";
import {
  fetchLatestPatterns,
  fetchPatternAccuracy,
  type PatternDoc,
  type PatternAccuracyRollup,
} from "../lib/patternApi";
import type { WsPatternPayload, WsPatternSignalPayload } from "../lib/socket";
import { getPatternAdvice } from "../lib/patternMetadata";


/**
 * Right-rail Pattern Panel — Phase 6.
 *
 * Three tabs:
 *   • Live — patterns detected for the current symbol in the current session
 *            (driven by WebSocket events the Dashboard accumulates).
 *   • History — last N detected patterns from MongoDB for the active symbol,
 *               with outcome icons (✅ / ❌ / ⏳).
 *   • Accuracy — backend win-rate rollups per pattern_name × timeframe.
 *
 * Click a Live row → fires a `qti:pattern-focus` window event with the
 * payload, which the Dashboard chart layer listens to in order to scroll
 * the chart to the relevant candle.
 */

type Tab = "live" | "history" | "accuracy";

interface Props {
  symbol: string;
  livePatterns: WsPatternPayload[];
}

export default function PatternPanel({ symbol, livePatterns }: Props) {
  const [tab, setTab] = useState<Tab>("live");
  const [history, setHistory] = useState<PatternDoc[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [accuracy, setAccuracy] = useState<PatternAccuracyRollup[] | null>(null);
  const [accuracyAvailable, setAccuracyAvailable] = useState(true);
  const [accuracyLoading, setAccuracyLoading] = useState(false);

  // Lazy-load history on tab switch / symbol change.
  useEffect(() => {
    if (tab !== "history" || !symbol) return;
    let aborted = false;
    setHistoryLoading(true);
    fetchLatestPatterns(symbol, 50)
      .then((res) => { if (!aborted) setHistory(res?.patterns ?? []); })
      .finally(() => { if (!aborted) setHistoryLoading(false); });
    return () => { aborted = true; };
  }, [tab, symbol]);

  useEffect(() => {
    if (tab !== "accuracy") return;
    let aborted = false;
    setAccuracyLoading(true);
    fetchPatternAccuracy()
      .then((res) => {
        if (aborted) return;
        if (!res) { setAccuracy([]); setAccuracyAvailable(false); return; }
        setAccuracy(res.rollups ?? []);
        setAccuracyAvailable(res.available);
      })
      .finally(() => { if (!aborted) setAccuracyLoading(false); });
    return () => { aborted = true; };
  }, [tab]);

  // Reset live tab selection when symbol changes.
  useEffect(() => {
    setTab("live");
  }, [symbol]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl overflow-hidden"
    >
      <header className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-bg-border">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500">AI Patterns</div>
          <div className="text-xs text-slate-400 mt-0.5">
            {livePatterns.length} active · {symbol || "—"}
          </div>
        </div>
        <nav className="flex gap-1 text-[11px] font-mono">
          {(["live", "history", "accuracy"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                "px-2 py-1 rounded transition-colors",
                tab === t
                  ? "bg-bg-elevated text-white border border-bg-border"
                  : "text-slate-500 hover:text-slate-300 border border-transparent"
              )}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </nav>
      </header>

      <div className="p-3 max-h-[28rem] overflow-y-auto">
        {tab === "live" && <LiveTab patterns={livePatterns} />}
        {tab === "history" && <HistoryTab loading={historyLoading} patterns={history ?? []} />}
        {tab === "accuracy" && (
          <AccuracyTab loading={accuracyLoading} available={accuracyAvailable} rollups={accuracy ?? []} />
        )}
      </div>
    </motion.div>
  );
}

// ─── Live tab ─────────────────────────────────────────────────────────────

function LiveTab({ patterns }: { patterns: WsPatternPayload[] }) {
  if (patterns.length === 0) {
    return (
      <div className="text-sm text-slate-400 py-6 text-center">
        Watching… no high-confidence patterns yet.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {patterns.map((p) => (
          <PatternRow key={`${p.symbol}-${p.pattern_name}-${p.detected_at}`} payload={p} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function PatternRow({ payload }: { payload: WsPatternPayload | WsPatternSignalPayload }) {
  const [expanded, setExpanded] = useState(false);
  const tone = directionTone(payload.direction);
  const isSignal = (payload as WsPatternSignalPayload).signal_action != null;
  const advice = getPatternAdvice(payload.pattern_name, payload.direction);
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      className="bg-bg-elevated/40 border border-bg-border rounded-lg overflow-hidden hover:border-bg-border-bright transition-colors"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={clsx("w-1.5 h-1.5 rounded-full shrink-0", tone.dot)} />
            <span className="text-sm text-white truncate font-semibold">{payload.pattern_name}</span>
            <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0", tone.badge)}>
              {payload.direction.toUpperCase()}
            </span>
            {isSignal && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-400 shrink-0">
                {(payload as WsPatternSignalPayload).signal_action}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold", gradeBadge(payload.grade))}>
              {payload.grade}
            </span>
            <span className="text-[11px] font-mono text-slate-300">{advice.winRate}% Acc</span>
          </div>
        </div>
        <div className="mt-1 h-1 w-full bg-bg-border rounded">
          <div
            className={clsx("h-full rounded", confidenceBar(payload.confidence))}
            style={{ width: `${Math.max(0, Math.min(100, payload.confidence))}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
          <span>{payload.timeframe}</span>
          <span>
            {payload.rr != null ? `RR ${payload.rr.toFixed(2)}` : "—"} · {new Date(payload.detected_at).toLocaleTimeString()}
          </span>
        </div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="border-t border-bg-border bg-bg-panel-solid/40 px-3 py-2.5 space-y-2.5"
          >
            <div className="text-[11px] leading-relaxed text-slate-300 bg-bg-panel/40 px-2 py-1.5 rounded border border-bg-border/60">
              <div className="flex items-center justify-between mb-1">
                <span className={clsx("text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider", advice.badgeClass)}>
                  {advice.strengthText}
                </span>
              </div>
              <span className="font-semibold text-white">Signal:</span> {advice.adviceMsg}
            </div>

            {/* AI Explanation or fallback */}
            <div className="text-[11px] text-slate-300 whitespace-pre-line leading-relaxed border-t border-bg-border/30 pt-2">
              {payload.ai_explanation || "No explanation available for this pattern yet."}
            </div>

            <div className="flex gap-2 pt-1 border-t border-bg-border/30">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent("qti:pattern-focus", { detail: payload }));
                }}
                className="text-[10px] text-accent-info hover:text-white border border-bg-border rounded px-2 py-0.5 transition-colors hover:bg-bg-elevated/40"
              >
                Show on chart
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── History tab ──────────────────────────────────────────────────────────

function HistoryTab({ loading, patterns }: { loading: boolean; patterns: PatternDoc[] }) {
  if (loading) return <div className="text-xs text-slate-400 py-4 text-center">Loading…</div>;
  if (patterns.length === 0) {
    return <div className="text-xs text-slate-400 py-4 text-center">No history yet — patterns appear here after the engine has been running.</div>;
  }
  return (
    <div className="space-y-1.5">
      {patterns.map((p) => {
        const icon = p.outcome === "win" ? "✅" : p.outcome === "loss" ? "❌" : p.outcome === "breakeven" ? "⚪" : "⏳";
        const tone = directionTone(p.direction);
        return (
          <div key={p._id} className="bg-bg-elevated/30 border border-bg-border rounded px-2 py-1.5 text-xs flex items-center gap-2">
            <span className="shrink-0">{icon}</span>
            <span className={clsx("w-1 h-1 rounded-full shrink-0", tone.dot)} />
            <span className="text-white truncate flex-1">{p.pattern_name}</span>
            <span className={clsx("px-1 py-0.5 rounded text-[9px] font-bold shrink-0", gradeBadge(p.grade ?? "C"))}>
              {p.grade ?? "—"}
            </span>
            <span className="text-[10px] text-slate-500 font-mono shrink-0">
              {p.timeframe} · {p.confidence_score}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Accuracy tab ─────────────────────────────────────────────────────────

function AccuracyTab({ loading, available, rollups }: { loading: boolean; available: boolean; rollups: PatternAccuracyRollup[] }) {
  if (loading) return <div className="text-xs text-slate-400 py-4 text-center">Loading…</div>;
  if (!available) {
    return (
      <div className="text-xs text-slate-400 py-4 text-center">
        Accuracy store is offline. Stats become available once MongoDB is reachable from the AI service.
      </div>
    );
  }
  if (rollups.length === 0) {
    return <div className="text-xs text-slate-400 py-4 text-center">No outcomes resolved yet. Pattern win/loss accumulates as the engine resolves pending detections.</div>;
  }
  // Sort highest win-rate first; require at least 5 trades to surface.
  const ranked = useMemo(() => {
    return [...rollups]
      .filter((r) => r.total_detected >= 5)
      .sort((a, b) => b.win_rate - a.win_rate)
      .slice(0, 25);
  }, [rollups]);
  const max = ranked.length ? Math.max(0.01, ranked[0].win_rate) : 1;
  return (
    <div className="space-y-1.5">
      {ranked.map((r) => (
        <div key={`${r.pattern_name}:${r.timeframe}`} className="text-xs">
          <div className="flex justify-between mb-0.5">
            <span className="text-white truncate">
              {r.pattern_name} <span className="text-[10px] text-slate-500 font-mono">{r.timeframe}</span>
            </span>
            <span className="font-mono text-slate-300">
              {(r.win_rate * 100).toFixed(1)}% · {r.wins}/{r.total_detected}
            </span>
          </div>
          <div className="h-1 bg-bg-border rounded">
            <div className="h-full rounded bg-accent-buy" style={{ width: `${(r.win_rate / max) * 100}%` }} />
          </div>
        </div>
      ))}
      <a
        href="/patterns/analytics"
        className="block mt-3 text-center text-[11px] text-accent-info hover:text-white border border-bg-border rounded px-2 py-1"
      >
        Open full Pattern Analytics →
      </a>
    </div>
  );
}

// ─── Styling helpers ──────────────────────────────────────────────────────

function directionTone(dir: string) {
  switch (dir) {
    case "bullish":
      return { dot: "bg-accent-buy", badge: "bg-accent-buy/15 text-accent-buy" };
    case "bearish":
      return { dot: "bg-accent-sell", badge: "bg-accent-sell/15 text-accent-sell" };
    case "continuation":
      return { dot: "bg-amber-500", badge: "bg-amber-500/15 text-amber-400" };
    default:
      return { dot: "bg-slate-500", badge: "bg-slate-500/15 text-slate-400" };
  }
}

function gradeBadge(grade: string) {
  switch (grade) {
    case "A+":
      return "bg-emerald-500/20 text-emerald-300";
    case "A":
      return "bg-emerald-500/15 text-emerald-400";
    case "B":
      return "bg-amber-500/15 text-amber-400";
    default:
      return "bg-slate-500/15 text-slate-400";
  }
}

function confidenceBar(conf: number) {
  if (conf >= 80) return "bg-accent-buy";
  if (conf >= 65) return "bg-amber-500";
  return "bg-slate-500";
}
