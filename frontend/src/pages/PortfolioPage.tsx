import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api } from "../lib/api";
import TagAnalyticsPanel from "../components/TagAnalyticsPanel";
import WeeklyReviewPanel from "../components/WeeklyReviewPanel";

interface OpenPos {
  _id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  lastPrice?: number;
  unrealisedPnl?: number;
}

interface Totals {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  avgRPct: number;
  maxDrawdown: number;
}

interface Analytics {
  capital: number;
  equity: number;
  realisedPnl: number;
  unrealisedPnl: number;
  dailyPnl: number;
  openPositions: OpenPos[];
  totals: Totals;
  dailySeries: Array<{ date: string; pnl: number }>;
  equityCurve: Array<{ t: number; pnl: number }>;
  pnlBySymbol: Array<{ symbol: string; pnl: number; trades: number; winRate: number }>;
  pnlByHour: Array<{ hour: number; pnl: number; trades: number }>;
}

interface Trade {
  _id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  entryAt: string;
  exitAt: string;
  note?: string;
  tags?: string[];
  screenshots?: string[];
}

const fmtINR = (n: number, signed = false) => `${signed && n > 0 ? "+" : ""}₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SUGGESTED_TAGS = [
  "setup:trend", "setup:breakout", "setup:reversion", "setup:sentiment",
  "emotion:calm", "emotion:fomo", "emotion:revenge", "emotion:disciplined",
  "quality:A+", "quality:A", "quality:B", "quality:C",
  "mistake:overtrade", "mistake:nostop",
];

export default function PortfolioPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftShots, setDraftShots] = useState<string[]>([]);
  const [shotPreview, setShotPreview] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      void api.get("/api/portfolio-analytics").then(({ data }) => setData(data as Analytics));
      void api.get("/api/trades").then(({ data }) => setTrades((data.trades ?? []) as Trade[]));
    };
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  async function saveJournal(id: string) {
    const tags = draftTags.split(",").map((t) => t.trim()).filter(Boolean);
    await api.patch(`/api/portfolio-analytics/trades/${id}`, {
      note: draftNote,
      tags,
      screenshots: draftShots,
    });
    setTrades((curr) => curr.map((t) => (t._id === id ? { ...t, note: draftNote, tags, screenshots: draftShots } : t)));
    setEditing(null);
    setDraftShots([]);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (!blob) continue;
        if (blob.size > 1_000_000) {
          alert("Screenshot too large (>1 MB). Crop/compress first.");
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const url = reader.result as string;
          setDraftShots((curr) => (curr.length < 4 ? [...curr, url] : curr));
        };
        reader.readAsDataURL(blob);
      }
    }
  }

  if (!data) return <div className="min-h-screen flex items-center justify-center bg-app-radial text-slate-400">Loading portfolio…</div>;

  const dayUp = data.dailyPnl >= 0;

  return (
    <div className="min-h-screen bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4">
        <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
        <h1 className="text-xl font-semibold text-white">Portfolio &amp; P&amp;L</h1>
        <div className="text-xs text-slate-500">Open positions, trade journal, performance analytics.</div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <section className="grid grid-cols-2 md:grid-cols-7 gap-3">
          <Card label="Capital" value={fmtINR(data.capital)} />
          <Card label="Equity" value={fmtINR(data.equity)} />
          <Card label="Day P&L" value={fmtINR(data.dailyPnl, true)} tone={dayUp ? "buy" : "sell"} />
          <Card label="Realised" value={fmtINR(data.realisedPnl, true)} tone={data.realisedPnl >= 0 ? "buy" : "sell"} />
          <Card label="Unrealised" value={fmtINR(data.unrealisedPnl, true)} tone={data.unrealisedPnl >= 0 ? "buy" : "sell"} />
          <Card label="Win rate" value={`${(data.totals.winRate * 100).toFixed(1)}%`} />
          <Card label="Max DD" value={fmtINR(data.totals.maxDrawdown)} tone="sell" />
        </section>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card label="Trades" value={data.totals.trades} />
          <Card label="Profit factor" value={data.totals.profitFactor != null ? data.totals.profitFactor.toFixed(2) : "∞"} tone={(data.totals.profitFactor ?? 0) >= 1 ? "buy" : "sell"} />
          <Card label="Expectancy" value={fmtINR(data.totals.expectancy, true)} tone={data.totals.expectancy >= 0 ? "buy" : "sell"} />
          <Card label="Avg R %" value={`${data.totals.avgRPct.toFixed(3)}%`} />
        </section>

        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4">
          <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Open positions ({data.openPositions.length})</div>
          {data.openPositions.length === 0 ? (
            <div className="text-sm text-slate-400">No open positions.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-left px-3 py-2">Side</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">Entry</th>
                  <th className="text-right px-3 py-2">CMP</th>
                  <th className="text-right px-3 py-2">Unrealised</th>
                  <th className="text-right px-3 py-2">Stop / Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {data.openPositions.map((p) => {
                  const up = (p.unrealisedPnl ?? 0) >= 0;
                  return (
                    <tr key={p._id}>
                      <td className="px-3 py-2 text-white">{p.symbol}</td>
                      <td className={clsx("px-3 py-2", p.side === "LONG" ? "text-accent-buy" : "text-accent-sell")}>{p.side}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.qty}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.entryPrice.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.lastPrice?.toFixed(2) ?? "—"}</td>
                      <td className={clsx("px-3 py-2 text-right font-mono", up ? "text-accent-buy" : "text-accent-sell")}>{fmtINR(p.unrealisedPnl ?? 0, true)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400 text-xs">
                        <span className="text-accent-sell">{p.stopPrice?.toFixed(2) ?? "—"}</span> / <span className="text-accent-buy">{p.targetPrice?.toFixed(2) ?? "—"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Daily P&L (last 30 days)">
            <DailyPnlBars data={data.dailySeries} />
          </Panel>
          <Panel title="Cumulative equity">
            <EquityCurve data={data.equityCurve} />
          </Panel>
          <Panel title="P&L by symbol">
            <PnlBySymbol rows={data.pnlBySymbol} />
          </Panel>
          <Panel title="P&L by hour (UTC)">
            <PnlByHour data={data.pnlByHour} />
          </Panel>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TagAnalyticsPanel />
          <WeeklyReviewPanel />
        </section>

        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
          <div className="px-5 pt-4 pb-2 text-sm uppercase tracking-wider text-slate-500">Trade journal</div>
          {trades.length === 0 ? (
            <div className="px-6 py-6 text-sm text-slate-400">No closed trades yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">Date</th>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">Entry</th>
                  <th className="text-right px-3 py-2">Exit</th>
                  <th className="text-right px-3 py-2">P&L</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">Tags</th>
                  <th className="px-3 py-2">Note</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {trades.map((t) => {
                  const win = t.pnl > 0;
                  const isEditing = editing === t._id;
                  return (
                    <Fragment key={t._id}>
                    <tr className={clsx(isEditing && "bg-bg-elevated/40")}>
                      <td className="px-4 py-2 text-slate-400 font-mono text-xs">{new Date(t.exitAt).toLocaleString()}</td>
                      <td className="px-3 py-2 text-white">{t.symbol}</td>
                      <td className={clsx("px-3 py-2", t.side === "LONG" ? "text-accent-buy" : "text-accent-sell")}>{t.side}</td>
                      <td className="px-3 py-2 text-right font-mono">{t.qty}</td>
                      <td className="px-3 py-2 text-right font-mono">{t.entryPrice.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono">{t.exitPrice.toFixed(2)}</td>
                      <td className={clsx("px-3 py-2 text-right font-mono", win ? "text-accent-buy" : "text-accent-sell")}>{fmtINR(t.pnl, true)}</td>
                      <td className="px-3 py-2 text-slate-400 text-xs">{t.exitReason}</td>
                      <td className="px-3 py-2">
                        {isEditing ? (
                          <input
                            value={draftTags}
                            onChange={(e) => setDraftTags(e.target.value)}
                            placeholder="trend, FOMO, A+"
                            className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-xs w-44"
                          />
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {(t.tags ?? []).map((tag) => <span key={tag} className="bg-accent-info/10 text-accent-info text-[10px] px-1.5 py-0.5 rounded">{tag}</span>)}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-400 max-w-xs">
                        {isEditing ? (
                          <input
                            value={draftNote}
                            onChange={(e) => setDraftNote(e.target.value)}
                            placeholder="note…"
                            className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-xs w-full"
                          />
                        ) : (
                          <span className="truncate inline-block max-w-xs">{t.note ?? ""}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isEditing ? (
                          <div className="flex gap-1">
                            <button onClick={() => saveJournal(t._id)} className="text-xs text-accent-buy">Save</button>
                            <button onClick={() => { setEditing(null); setDraftShots([]); }} className="text-xs text-slate-500">×</button>
                          </div>
                        ) : (
                          <button onClick={() => {
                            setEditing(t._id);
                            setDraftNote(t.note ?? "");
                            setDraftTags((t.tags ?? []).join(", "));
                            setDraftShots(t.screenshots ?? []);
                          }} className="text-xs text-slate-500 hover:text-white">Edit</button>
                        )}
                      </td>
                    </tr>
                    {isEditing && (
                      <tr className="bg-bg-elevated/40">
                        <td colSpan={11} className="px-4 py-3" onPaste={handlePaste}>
                          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Quick tags (click to toggle)</div>
                          <div className="flex flex-wrap gap-1 mb-3">
                            {SUGGESTED_TAGS.map((tag) => {
                              const current = draftTags.split(",").map((s) => s.trim()).filter(Boolean);
                              const on = current.includes(tag);
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => {
                                    const next = on ? current.filter((c) => c !== tag) : [...current, tag];
                                    setDraftTags(next.join(", "));
                                  }}
                                  className={clsx("text-[10px] px-1.5 py-0.5 rounded border",
                                    on ? "border-accent-info bg-accent-info/10 text-accent-info" : "border-bg-border text-slate-400 hover:text-white"
                                  )}
                                >{tag}</button>
                              );
                            })}
                          </div>
                          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Screenshots</div>
                          <div className="flex flex-wrap gap-2 mb-2">
                            {draftShots.map((src, i) => (
                              <div key={i} className="relative group">
                                <img src={src} alt={`shot ${i}`} className="h-16 rounded border border-bg-border cursor-pointer" onClick={() => setShotPreview(src)} />
                                <button onClick={() => setDraftShots(draftShots.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 bg-accent-sell rounded-full w-4 h-4 text-[10px] text-white opacity-0 group-hover:opacity-100">×</button>
                              </div>
                            ))}
                            {draftShots.length < 4 && (
                              <div className="h-16 w-32 rounded border border-dashed border-bg-border flex items-center justify-center text-[10px] text-slate-500 px-2 text-center">
                                Paste image here<br />(⌘V / Ctrl+V)
                              </div>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-500">Click an image to enlarge. Max 4, ~1 MB each.</div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </main>

      {shotPreview && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8" onClick={() => setShotPreview(null)}>
          <img src={shotPreview} alt="screenshot" className="max-w-full max-h-full rounded shadow-2xl" />
        </div>
      )}
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string | number; tone?: "buy" | "sell" }) {
  const cls = tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-white";
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("text-lg font-mono tabular-nums", cls)}>{value}</div>
    </motion.div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">{title}</div>
      {children}
    </div>
  );
}

function DailyPnlBars({ data }: { data: Array<{ date: string; pnl: number }> }) {
  if (!data.length) return <div className="text-sm text-slate-500">No trades.</div>;
  const max = Math.max(...data.map((d) => Math.abs(d.pnl)), 1);
  return (
    <div className="flex items-end h-40 gap-0.5">
      {data.map((d) => {
        const h = (Math.abs(d.pnl) / max) * 100;
        const up = d.pnl >= 0;
        return (
          <div key={d.date} className="flex-1 flex flex-col items-center justify-end" title={`${d.date}: ${fmtINR(d.pnl, true)}`}>
            <div
              className={clsx("w-full rounded-t", up ? "bg-accent-buy/60" : "bg-accent-sell/60")}
              style={{ height: `${h}%`, minHeight: d.pnl !== 0 ? "2px" : "0" }}
            />
          </div>
        );
      })}
    </div>
  );
}

function EquityCurve({ data }: { data: Array<{ t: number; pnl: number }> }) {
  if (data.length < 2) return <div className="text-sm text-slate-500">Need ≥ 2 trades.</div>;
  const w = 400;
  const h = 160;
  const minP = Math.min(...data.map((p) => p.pnl), 0);
  const maxP = Math.max(...data.map((p) => p.pnl), 0);
  const span = (maxP - minP) || 1;
  const path = data
    .map((p, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((p.pnl - minP) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = data[data.length - 1]!.pnl;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-40">
        <line x1={0} x2={w} y1={h - ((0 - minP) / span) * h} y2={h - ((0 - minP) / span) * h} stroke="#1f2a3d" strokeDasharray="2 2" />
        <path d={path} fill="none" stroke={last >= 0 ? "#16c784" : "#ea3943"} strokeWidth={1.5} />
      </svg>
      <div className="text-xs font-mono text-slate-400 mt-1">end: {fmtINR(last, true)}</div>
    </div>
  );
}

function PnlBySymbol({ rows }: { rows: Array<{ symbol: string; pnl: number; trades: number; winRate: number }> }) {
  if (!rows.length) return <div className="text-sm text-slate-500">No data.</div>;
  const max = Math.max(...rows.map((r) => Math.abs(r.pnl)), 1);
  return (
    <div className="space-y-1.5 max-h-40 overflow-y-auto">
      {rows.map((r) => {
        const up = r.pnl >= 0;
        const width = (Math.abs(r.pnl) / max) * 100;
        return (
          <div key={r.symbol} className="flex items-center gap-2 text-xs">
            <span className="w-20 text-slate-300">{r.symbol}</span>
            <div className="flex-1 h-3 bg-bg-elevated rounded overflow-hidden relative">
              <div className={clsx("h-full", up ? "bg-accent-buy/50" : "bg-accent-sell/50")} style={{ width: `${width}%` }} />
            </div>
            <span className={clsx("font-mono w-24 text-right", up ? "text-accent-buy" : "text-accent-sell")}>{fmtINR(r.pnl, true)}</span>
            <span className="text-slate-500 w-14 text-right font-mono">{r.trades}t</span>
          </div>
        );
      })}
    </div>
  );
}

function PnlByHour({ data }: { data: Array<{ hour: number; pnl: number; trades: number }> }) {
  const max = Math.max(...data.map((d) => Math.abs(d.pnl)), 1);
  return (
    <div className="grid grid-cols-12 gap-1">
      {data.map((d) => {
        const intensity = Math.min(1, Math.abs(d.pnl) / max);
        const up = d.pnl >= 0;
        const bg = up
          ? `rgba(22,199,132,${0.1 + intensity * 0.5})`
          : `rgba(234,57,67,${0.1 + intensity * 0.5})`;
        return (
          <div key={d.hour} className="rounded p-1 text-center" style={{ background: bg }} title={`${d.hour}:00 — ${fmtINR(d.pnl, true)} (${d.trades} trades)`}>
            <div className="text-[9px] text-slate-300">{d.hour}</div>
            <div className={clsx("text-[10px] font-mono", up ? "text-accent-buy" : "text-accent-sell")}>{d.trades || ""}</div>
          </div>
        );
      })}
    </div>
  );
}
