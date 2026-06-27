import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import PaperBanner from "../components/paper/PaperBanner";
import { PaperSubNav } from "./PaperAnalyticsPage";
import { paperApi, type PaperTrade } from "../lib/paperApi";
import { fetchLatestPatterns, type PatternDoc } from "../lib/patternApi";

const EMOTIONS = ["", "Calm", "Confident", "FOMO", "Anxious", "Revenge", "Bored", "Excited"] as const;
const QUALITY = ["", "A+", "A", "B", "C", "Mistake"] as const;
const SETUP = ["", "Trend", "Breakout", "Reversion", "Scalp", "News", "Other"] as const;

export default function PaperJournalPage() {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const r = await paperApi.listTrades({ limit: 200 });
    setTrades(r.trades);
    if (!selectedId && r.trades.length > 0) setSelectedId(r.trades[0]._id);
  }

  const selected = useMemo(() => trades.find((t) => t._id === selectedId) ?? null, [trades, selectedId]);

  return (
    <div className="min-h-screen flex flex-col bg-app-radial text-slate-200">
      <PaperBanner />
      <Topbar symbol="Journal" wsStatus="open" />
      <div className="flex-1 flex">
        <Sidebar symbols={[]} prices={{}} prevPrices={{}} active="" onSelect={() => {}} />
        <main className="flex-1 p-4 space-y-4 min-w-0">
          <PaperSubNav active="journal" />
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-4 bg-bg-panel-solid/60 border border-bg-border rounded-xl p-2 max-h-[78vh] overflow-auto">
              <div className="text-[10px] uppercase text-slate-500 px-2 pb-2">Trade history ({trades.length})</div>
              {trades.length === 0 && <div className="text-xs text-slate-500 p-3">No closed paper trades yet.</div>}
              <ul className="space-y-1">
                {trades.map((t) => (
                  <li key={t._id}>
                    <button
                      onClick={() => setSelectedId(t._id)}
                      className={clsx(
                        "w-full text-left px-3 py-2 rounded-md text-xs transition-colors",
                        selectedId === t._id ? "bg-bg-elevated text-white" : "text-slate-300 hover:bg-bg-elevated/60"
                      )}
                    >
                      <div className="flex justify-between font-mono">
                        <span>{t.symbol}</span>
                        <span className={t.netPnl > 0 ? "text-accent-buy" : "text-accent-sell"}>
                          {t.netPnl >= 0 ? "+" : ""}₹{t.netPnl.toFixed(0)}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 flex justify-between">
                        <span>{t.direction} · {t.qty}</span>
                        <span>{new Date(t.exitTime).toLocaleDateString("en-IN")}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="col-span-8">
              {selected ? <JournalEntry key={selected._id} trade={selected} onSaved={load} /> : (
                <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-8 text-center text-slate-500 text-sm">
                  Select a trade to view its journal entry.
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function AutoReview({ tradeId }: { tradeId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof paperApi.tradeReview>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function load() {
    setBusy(true);
    setErr(null);
    try {
      setData(await paperApi.tradeReview(tradeId));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase text-slate-500">Auto-review</div>
        <button onClick={load} disabled={busy} className="text-xs text-accent-info hover:text-blue-300">
          {busy ? "…" : data ? "Refresh" : "Generate"}
        </button>
      </div>
      {err && <div className="text-xs text-rose-400">{err}</div>}
      {data && (
        <>
          <div className="text-sm text-white">{data.headline}</div>
          <ul className="text-xs text-slate-300 list-disc pl-5 space-y-1">
            {data.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
          <div className="text-[10px] text-slate-500">Grade: <span className="font-mono text-white">{data.score}</span></div>
        </>
      )}
      {!data && !busy && !err && <div className="text-xs text-slate-500">Click Generate for an automatic coaching summary of this trade.</div>}
    </div>
  );
}

function JournalEntry({ trade, onSaved }: { trade: PaperTrade; onSaved: () => void }) {
  const [plan, setPlan] = useState(trade.preTradePlan ?? "");
  const [mistake, setMistake] = useState(trade.mistake ?? "");
  const [lesson, setLesson] = useState(trade.lesson ?? "");
  const [notes, setNotes] = useState(trade.notes ?? "");
  const [stars, setStars] = useState(trade.executionStars ?? 0);
  const [emoIn, setEmoIn] = useState(trade.emotionTagEntry ?? "");
  const [emoOut, setEmoOut] = useState(trade.emotionTagExit ?? "");
  const [quality, setQuality] = useState(trade.qualityTag ?? "");
  const [setup, setSetup] = useState(trade.setupType ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    try {
      await paperApi.updateTradeJournal(trade._id, {
        preTradePlan: plan,
        mistake,
        lesson,
        notes,
        executionStars: stars,
        emotionTagEntry: emoIn as typeof EMOTIONS[number],
        emotionTagExit: emoOut as typeof EMOTIONS[number],
        qualityTag: quality as typeof QUALITY[number],
        setupType: setup as typeof SETUP[number],
      });
      setSaved(new Date().toLocaleTimeString());
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  const rText = trade.rMultiple != null ? `${trade.rMultiple >= 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R` : "—";
  const mae = trade.maxAdverseExcursion;
  const mfe = trade.maxFavorableExcursion;
  const slUsed = mae != null && trade.entryPrice ? Math.abs(trade.entryPrice - mae) : null;
  const tpReached = mfe != null && trade.entryPrice ? Math.abs(mfe - trade.entryPrice) : null;

  return (
    <div className="space-y-3">
      <AutoReview tradeId={trade._id} />
      <PatternCaptureRow trade={trade} />
      <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-4 space-y-2 text-sm font-mono">
        <div className="flex justify-between">
          <div className="text-lg text-white">
            {trade.symbol} <span className={trade.direction === "LONG" ? "text-accent-buy" : "text-accent-sell"}>{trade.direction}</span>
          </div>
          <div className={`text-lg ${trade.netPnl >= 0 ? "text-accent-buy" : "text-accent-sell"}`}>
            {trade.netPnl >= 0 ? "+" : ""}₹{trade.netPnl.toFixed(0)} ({trade.pnlPct.toFixed(2)}%)
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 text-xs">
          <Info label="Entry" value={`₹${trade.entryPrice.toFixed(2)}`} />
          <Info label="Exit" value={`₹${trade.exitPrice.toFixed(2)}`} />
          <Info label="Qty" value={String(trade.qty)} />
          <Info label="Charges" value={`₹${trade.brokerage.toFixed(2)}`} />
          <Info label="Hold" value={`${trade.holdDurationMins}m`} />
          <Info label="Exit" value={trade.exitReason} />
          <Info label="R-Multiple" value={rText} />
          <Info label="Setup" value={trade.strategyTag || "—"} />
        </div>
        {trade.entrySignal != null && (
          <details className="text-xs">
            <summary className="text-slate-500 cursor-pointer">Entry signal snapshot (AI)</summary>
            <pre className="text-[10px] text-slate-400 mt-1 whitespace-pre-wrap break-all">
              {JSON.stringify(trade.entrySignal, null, 2)}
            </pre>
          </details>
        )}
        {(slUsed != null || tpReached != null) && (
          <div className="text-xs text-slate-400 pt-1 border-t border-bg-border">
            {mae != null && <div>MAE: ₹{mae.toFixed(2)} (max adverse move {slUsed?.toFixed(2)})</div>}
            {mfe != null && <div>MFE: ₹{mfe.toFixed(2)} (max favorable move {tpReached?.toFixed(2)})</div>}
          </div>
        )}
      </div>

      <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-4 space-y-3 text-sm">
        <Field label="Pre-trade plan">
          <textarea value={plan} onChange={(e) => setPlan(e.target.value)} rows={2} className="ta" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Execution (1–5 stars)">
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setStars(n)} className={n <= stars ? "text-amber-400" : "text-slate-600"}>
                  ★
                </button>
              ))}
            </div>
          </Field>
          <Field label="Quality">
            <select value={quality} onChange={(e) => setQuality(e.target.value)} className="sel">
              {QUALITY.map((q) => <option key={q} value={q}>{q || "—"}</option>)}
            </select>
          </Field>
          <Field label="Emotion at entry">
            <select value={emoIn} onChange={(e) => setEmoIn(e.target.value)} className="sel">
              {EMOTIONS.map((e) => <option key={e} value={e}>{e || "—"}</option>)}
            </select>
          </Field>
          <Field label="Emotion at exit">
            <select value={emoOut} onChange={(e) => setEmoOut(e.target.value)} className="sel">
              {EMOTIONS.map((e) => <option key={e} value={e}>{e || "—"}</option>)}
            </select>
          </Field>
          <Field label="Setup type">
            <select value={setup} onChange={(e) => setSetup(e.target.value)} className="sel col-span-2">
              {SETUP.map((s) => <option key={s} value={s}>{s || "—"}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Mistake (if any)">
          <textarea value={mistake} onChange={(e) => setMistake(e.target.value)} rows={2} className="ta" />
        </Field>
        <Field label="Lesson learned">
          <textarea value={lesson} onChange={(e) => setLesson(e.target.value)} rows={2} className="ta" />
        </Field>
        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="ta" />
        </Field>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={busy}
            className="bg-accent-info hover:bg-blue-500 text-white text-sm px-4 py-1.5 rounded"
          >
            {busy ? "Saving…" : "Save journal"}
          </button>
          {saved && <span className="text-xs text-emerald-400">Saved at {saved}</span>}
        </div>
      </div>

      <style>{`
        .ta { background: rgba(20,26,41,0.6); border: 1px solid #1f2a3d; border-radius: 6px; padding: 6px 8px; font-size: 13px; color: #fff; width: 100%; }
        .sel { background: rgba(20,26,41,0.6); border: 1px solid #1f2a3d; border-radius: 6px; padding: 4px 6px; font-size: 13px; color: #fff; width: 100%; }
      `}</style>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className="text-white">{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      {children}
    </div>
  );
}

// Phase 11 — Pattern auto-capture: when a trade is selected, look up the
// patterns recorded for that symbol around the entry timestamp (±5 minutes)
// and surface the highest-confidence match as an "Entry Signal" line in the
// journal. Pure read; no extra backend endpoint needed.
function PatternCaptureRow({ trade }: { trade: PaperTrade }) {
  const [match, setMatch] = useState<PatternDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    let aborted = false;
    setMatch(null);
    setScanned(false);
    setLoading(true);
    fetchLatestPatterns(trade.symbol, 100)
      .then((res) => {
        if (aborted) return;
        const entryTs = new Date(trade.entryTime).getTime();
        const list = (res?.patterns ?? []).filter((p) => {
          if (!p.detected_at) return false;
          const dt = Math.abs(new Date(p.detected_at).getTime() - entryTs);
          return dt <= 5 * 60_000; // ±5 minutes
        });
        list.sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));
        setMatch(list[0] ?? null);
        setScanned(true);
      })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [trade._id, trade.symbol, trade.entryTime]);

  if (loading) {
    return (
      <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl px-4 py-2 text-[11px] text-slate-500">
        Looking up the pattern that fired at entry…
      </div>
    );
  }
  if (!match) {
    if (!scanned) return null;
    return (
      <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl px-4 py-2 text-[11px] text-slate-500">
        No AI pattern detected for {trade.symbol} within ±5 min of entry.
      </div>
    );
  }
  const tone = match.direction === "bullish" ? "text-accent-buy"
    : match.direction === "bearish" ? "text-accent-sell" : "text-amber-400";
  const arrow = match.direction === "bullish" ? "▲" : match.direction === "bearish" ? "▼" : "●";
  const gradeBg =
    match.grade === "A+" ? "bg-emerald-500/20 text-emerald-300" :
    match.grade === "A" ? "bg-emerald-500/15 text-emerald-400" :
    match.grade === "B" ? "bg-amber-500/15 text-amber-400" :
    "bg-slate-500/15 text-slate-400";
  // First line of ai_explanation is the headline — show that, full text on expand.
  const explanation = match.ai_explanation ?? "";
  const headline = explanation.split("\n").slice(0, 2).join(" ");
  return (
    <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl px-4 py-3 text-xs space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Entry signal · pattern</span>
        <span className={clsx("ml-auto px-1.5 py-0.5 rounded text-[10px] font-bold", gradeBg)}>{match.grade ?? "—"}</span>
        <span className="font-mono text-slate-300">{match.confidence_score}%</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={tone}>{arrow}</span>
        <span className="text-white">{match.pattern_name}</span>
        <span className="text-slate-500">·</span>
        <span className="text-slate-400 font-mono text-[11px]">{match.timeframe}</span>
        {match.risk_reward != null && (
          <>
            <span className="text-slate-500">·</span>
            <span className="text-slate-400 font-mono text-[11px]">RR {match.risk_reward.toFixed(2)}</span>
          </>
        )}
      </div>
      {explanation && (
        <details className="text-[11px] text-slate-400">
          <summary className="cursor-pointer hover:text-slate-200">{headline || "View full explanation"}</summary>
          <div className="mt-2 whitespace-pre-line leading-relaxed">{explanation}</div>
        </details>
      )}
    </div>
  );
}
