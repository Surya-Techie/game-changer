import { useEffect, useState } from "react";
import clsx from "clsx";
import { api } from "../lib/api";

interface Row {
  tag: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number | null;
}

export default function TagAnalyticsPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    const load = () => api.get("/api/portfolio-analytics/tag-stats").then(({ data }) => setRows(data.rows ?? []));
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Tag analytics</div>
      <div className="text-[10px] text-slate-500 mb-3">
        Win rate + P&amp;L bucketed per tag. Suggested tags:
        <span className="text-slate-400"> setup:trend</span>,
        <span className="text-slate-400"> setup:breakout</span>,
        <span className="text-slate-400"> emotion:calm</span>,
        <span className="text-slate-400"> emotion:fomo</span>,
        <span className="text-slate-400"> quality:A+</span>,
        <span className="text-slate-400"> mistake:overtrade</span>
      </div>
      {!rows && <div className="text-sm text-slate-400">Loading…</div>}
      {rows && rows.length === 0 && (
        <div className="text-sm text-slate-400">No tags yet — edit a closed trade and add tags like <span className="text-slate-200">setup:trend, emotion:calm, quality:A+</span> to see analytics here.</div>
      )}
      {rows && rows.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-2 py-1">Tag</th>
              <th className="text-right px-2 py-1">Trades</th>
              <th className="text-right px-2 py-1">Win rate</th>
              <th className="text-right px-2 py-1">Total P&amp;L</th>
              <th className="text-right px-2 py-1">PF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-bg-border">
            {rows.map((r) => (
              <tr key={r.tag}>
                <td className="px-2 py-1.5">
                  <span className="bg-accent-info/10 text-accent-info text-[10px] px-1.5 py-0.5 rounded font-mono">{r.tag}</span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-slate-300">{r.trades}</td>
                <td className={clsx("px-2 py-1.5 text-right font-mono", r.winRate >= 0.5 ? "text-accent-buy" : "text-accent-sell")}>
                  {(r.winRate * 100).toFixed(0)}%
                </td>
                <td className={clsx("px-2 py-1.5 text-right font-mono", r.totalPnl >= 0 ? "text-accent-buy" : "text-accent-sell")}>
                  {r.totalPnl >= 0 ? "+" : ""}₹{r.totalPnl.toFixed(2)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-slate-300">{r.profitFactor != null ? r.profitFactor.toFixed(2) : "∞"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
