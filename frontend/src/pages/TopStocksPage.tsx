import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { api } from "../lib/api";
import TopStockCard, { type TopStockRow } from "../components/TopStockCard";

type SortKey = "composite" | "change" | "ml" | "ai";
type FilterKey = "all" | "buy" | "sell" | "neutral";

export default function TopStocksPage() {
  const [rows, setRows] = useState<TopStockRow[]>([]);
  const [ts, setTs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("composite");
  const [filter, setFilter] = useState<FilterKey>("all");

  async function load(force = false) {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/api/top-stocks${force ? "?force=true" : ""}`);
      setRows(data.rows ?? []);
      setTs(data.ts ?? Date.now());
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err.message ?? "Failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const sorted = [...rows].sort((a, b) => {
    switch (sort) {
      case "composite": return (b.compositeScore ?? -1) - (a.compositeScore ?? -1);
      case "change":    return (b.changePct ?? -999) - (a.changePct ?? -999);
      case "ml":        return (b.mlReturnPct ?? -999) - (a.mlReturnPct ?? -999);
      case "ai":        return (b.aiConfidence ?? -1) - (a.aiConfidence ?? -1);
    }
  });
  const filtered = sorted.filter((r) => {
    if (filter === "all") return true;
    if (filter === "buy") return r.recommendation === "BUY" || r.recommendation === "STRONG BUY";
    if (filter === "sell") return r.recommendation === "SELL" || r.recommendation === "STRONG SELL";
    if (filter === "neutral") return r.recommendation === "NEUTRAL";
    return true;
  });

  // Bucket counts for filter chips.
  const counts = {
    all: rows.length,
    buy: rows.filter((r) => r.recommendation?.includes("BUY")).length,
    sell: rows.filter((r) => r.recommendation?.includes("SELL")).length,
    neutral: rows.filter((r) => r.recommendation === "NEUTRAL").length,
  };

  return (
    <div className="min-h-screen bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4 flex flex-wrap items-center gap-4">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
          <h1 className="text-xl font-semibold text-white">Top 20 Stocks — AI Ranked</h1>
          <div className="text-xs text-slate-500">
            Composite score combines 5-strategy ensemble · AI signal · pattern detection · ML prediction
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="border border-bg-border hover:border-accent-info text-slate-300 hover:text-white rounded-md px-3 py-1.5 font-semibold disabled:opacity-50"
          >
            {loading ? "Recalculating…" : "Refresh"}
          </button>
          {ts && <span className="text-slate-500 font-mono">last: {new Date(ts).toLocaleTimeString()}</span>}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-4">
        {/* ----- toolbar ----- */}
        <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl px-4 py-3 flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">Filter</span>
            {(["all", "buy", "neutral", "sell"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={clsx(
                  "px-2.5 py-1 rounded-md border",
                  filter === f
                    ? f === "buy" ? "border-accent-buy bg-accent-buy/10 text-accent-buy"
                    : f === "sell" ? "border-accent-sell bg-accent-sell/10 text-accent-sell"
                    : f === "neutral" ? "border-slate-500 text-slate-200"
                    : "border-accent-info bg-accent-info/10 text-white"
                    : "border-bg-border text-slate-400 hover:text-white"
                )}
              >
                {f.toUpperCase()} <span className="ml-1 font-mono text-slate-500">{counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-4">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="bg-bg-elevated border border-bg-border rounded-md px-2 py-1 text-slate-200"
            >
              <option value="composite">Composite score</option>
              <option value="change">% change today</option>
              <option value="ml">ML expected return</option>
              <option value="ai">AI confidence</option>
            </select>
          </div>
          <div className="ml-auto text-slate-500 font-mono">
            Showing {filtered.length} of {rows.length}
          </div>
        </div>

        {error && (
          <div className="bg-accent-sell/10 border border-accent-sell/40 text-accent-sell rounded-xl p-3 text-sm">
            {error}
          </div>
        )}

        {loading && rows.length === 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-44 rounded-xl bg-bg-elevated/40 animate-pulse" />
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && rows.length > 0 && (
          <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-6 text-center text-sm text-slate-400">
            No stocks match this filter right now.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3">
          {filtered.map((row, idx) => (
            <TopStockCard key={row.symbol} rank={idx + 1} row={row} />
          ))}
        </div>

        <div className="text-[11px] text-slate-500 mt-4 leading-relaxed">
          <span className="text-slate-300 font-semibold">How it ranks:</span> each stock runs the 5-layer Gainz Alpha composite (Trend / Reversion / Breakout / Pairs / Sentiment), the rule-based AI signal, candlestick pattern detection, and the ML next-bar predictor. Composite score 0–100 → bands: 0–25 STRONG SELL · 25–40 SELL · 40–60 NEUTRAL · 60–75 BUY · 75–100 STRONG BUY. Click any card to load that symbol on the main dashboard.
        </div>
      </main>
    </div>
  );
}
