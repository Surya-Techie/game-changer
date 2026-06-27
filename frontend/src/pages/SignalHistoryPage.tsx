import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { api } from "../lib/api";

interface SignalRow {
  _id: string;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  price: number;
  reason?: string;
  indicators?: Record<string, number | string>;
  suggestedEntry?: number;
  suggestedStop?: number;
  suggestedTarget?: number;
  createdAt: string;
}

const PAGE_SIZE = 50;
const SYMBOLS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL"];

export default function SignalHistoryPage() {
  const [all, setAll] = useState<SignalRow[]>([]);
  const [symbolFilter, setSymbolFilter] = useState<string>("ALL");
  const [actionFilter, setActionFilter] = useState<"ALL" | "BUY" | "SELL" | "HOLD">("ALL");
  const [minConf, setMinConf] = useState(0);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void api.get("/api/signals").then(({ data }) => setAll((data.signals ?? []) as SignalRow[]));
    const id = setInterval(() => {
      void api.get("/api/signals").then(({ data }) => setAll((data.signals ?? []) as SignalRow[]));
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    return all.filter((s) => {
      if (symbolFilter !== "ALL" && s.symbol !== symbolFilter) return false;
      if (actionFilter !== "ALL" && s.action !== actionFilter) return false;
      if (s.confidence < minConf) return false;
      return true;
    });
  }, [all, symbolFilter, actionFilter, minConf]);

  const stats = useMemo(() => {
    const total = filtered.length;
    const buys = filtered.filter((s) => s.action === "BUY").length;
    const sells = filtered.filter((s) => s.action === "SELL").length;
    const holds = filtered.filter((s) => s.action === "HOLD").length;
    const avgConf = total ? filtered.reduce((sum, s) => sum + s.confidence, 0) / total : 0;
    return { total, buys, sells, holds, avgConf };
  }, [filtered]);

  const start = page * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  function exportCsv() {
    const header = ["timestamp", "symbol", "action", "confidence", "price", "entry", "stop", "target", "reason"];
    const rows = filtered.map((s) => [
      s.createdAt,
      s.symbol,
      s.action,
      s.confidence,
      s.price,
      s.suggestedEntry ?? "",
      s.suggestedStop ?? "",
      s.suggestedTarget ?? "",
      (s.reason ?? "").replace(/"/g, '""'),
    ]);
    const csv = [header.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qti-signals-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4 flex justify-between items-center">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
          <h1 className="text-xl font-semibold text-white">Signal History</h1>
          <div className="text-xs text-slate-500">All AI signals — filter, paginate, export.</div>
        </div>
        <button onClick={exportCsv} className="border border-bg-border rounded-md px-3 py-1.5 text-sm text-slate-300 hover:text-white">Export CSV</button>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-4">
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Total signals" value={stats.total} />
          <Stat label="BUY" value={stats.buys} tone="buy" />
          <Stat label="SELL" value={stats.sells} tone="sell" />
          <Stat label="HOLD" value={stats.holds} tone="muted" />
          <Stat label="Avg confidence" value={`${(stats.avgConf * 100).toFixed(0)}%`} />
        </section>

        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-3 flex flex-wrap gap-3 items-center text-xs">
          <select value={symbolFilter} onChange={(e) => { setSymbolFilter(e.target.value); setPage(0); }} className="bg-bg-elevated border border-bg-border rounded px-2 py-1">
            <option value="ALL">All symbols</option>
            {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={actionFilter} onChange={(e) => { setActionFilter(e.target.value as any); setPage(0); }} className="bg-bg-elevated border border-bg-border rounded px-2 py-1">
            <option value="ALL">All actions</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
            <option value="HOLD">HOLD</option>
          </select>
          <label className="flex items-center gap-2 text-slate-400">
            Min confidence
            <input type="range" min={0} max={1} step={0.05} value={minConf} onChange={(e) => { setMinConf(Number(e.target.value)); setPage(0); }} className="accent-accent-info" />
            <span className="font-mono w-12">{(minConf * 100).toFixed(0)}%</span>
          </label>
          <div className="ml-auto text-slate-500">
            Page {page + 1} / {totalPages} · {filtered.length} rows
          </div>
        </section>

        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-4 py-2">Time</th>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Action</th>
                <th className="text-right px-3 py-2">Confidence</th>
                <th className="text-right px-3 py-2">Price</th>
                <th className="text-right px-3 py-2">Entry / Stop / Target</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {pageRows.map((s) => {
                const isOpen = expanded === s._id;
                return (
                  <Fragment key={s._id}>
                    <tr className={clsx("hover:bg-bg-elevated/30", isOpen && "bg-bg-elevated/40")}>
                      <td className="px-4 py-2 text-slate-400 font-mono text-xs">{new Date(s.createdAt).toLocaleString()}</td>
                      <td className="px-3 py-2 text-white">{s.symbol}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold",
                          s.action === "BUY" ? "bg-accent-buy/15 text-accent-buy" :
                          s.action === "SELL" ? "bg-accent-sell/15 text-accent-sell" :
                          "bg-slate-500/15 text-slate-400")}>{s.action}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{(s.confidence * 100).toFixed(0)}%</td>
                      <td className="px-3 py-2 text-right font-mono">{s.price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400 text-xs">
                        {s.suggestedEntry?.toFixed(2) ?? "—"} / <span className="text-accent-sell">{s.suggestedStop?.toFixed(2) ?? "—"}</span> / <span className="text-accent-buy">{s.suggestedTarget?.toFixed(2) ?? "—"}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-400 text-xs max-w-md truncate">{s.reason ?? ""}</td>
                      <td className="px-3 py-2">
                        <button onClick={() => setExpanded(isOpen ? null : s._id)} className="text-slate-400 hover:text-white text-xs">{isOpen ? "▼" : "▶"}</button>
                      </td>
                    </tr>
                    {isOpen && s.indicators && (
                      <tr className="bg-bg-elevated/20">
                        <td colSpan={8} className="px-4 py-3">
                          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Indicator snapshot at signal time</div>
                          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-xs font-mono">
                            {Object.entries(s.indicators).map(([k, v]) => (
                              <div key={k} className="flex justify-between bg-bg-panel-solid/60 rounded px-2 py-1">
                                <span className="text-slate-500">{k}</span>
                                <span className="text-slate-200">{typeof v === "number" ? v.toFixed(2) : String(v)}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {pageRows.length === 0 && (
            <div className="px-6 py-8 text-sm text-slate-400 text-center">No signals match these filters.</div>
          )}
        </section>

        {totalPages > 1 && (
          <div className="flex justify-center gap-2">
            <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="border border-bg-border rounded px-3 py-1.5 text-sm text-slate-300 disabled:opacity-30">Prev</button>
            <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="border border-bg-border rounded px-3 py-1.5 text-sm text-slate-300 disabled:opacity-30">Next</button>
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "buy" | "sell" | "muted" }) {
  const cls = tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : tone === "muted" ? "text-slate-400" : "text-white";
  return (
    <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("text-xl font-mono tabular-nums", cls)}>{value}</div>
    </div>
  );
}
