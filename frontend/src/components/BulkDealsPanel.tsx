import { useEffect, useState } from "react";
import clsx from "clsx";
import { api } from "../lib/api";

interface Deal {
  date: string;
  symbol: string;
  clientName: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  source: "nse" | "mock";
}

interface Response {
  ts: number;
  fromNse: boolean;
  note?: string;
  rows: Deal[];
  watchlistMatches: string[];
}

export default function BulkDealsPanel() {
  const [data, setData] = useState<Response | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const load = () => api.get("/api/bulk-deals").then(({ data }) => setData(data as Response));
    void load();
    const id = setInterval(load, 4 * 60 * 60 * 1000); // 4h
    return () => clearInterval(id);
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const { data } = await api.get("/api/bulk-deals?force=true");
      setData(data as Response);
    } finally {
      setRefreshing(false);
    }
  }

  if (!data) return <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4 text-sm text-slate-400">Loading bulk deals…</div>;

  const watched = new Set(data.watchlistMatches);

  return (
    <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500">Bulk Deals</div>
          <div className="text-[10px] text-slate-500 flex items-center gap-2">
            <span className={clsx("px-1.5 rounded text-[9px] font-bold", data.fromNse ? "bg-accent-buy/15 text-accent-buy" : "bg-slate-500/15 text-slate-400")}>
              {data.fromNse ? "NSE LIVE" : "MOCK"}
            </span>
            {data.note}
          </div>
        </div>
        <button onClick={refresh} disabled={refreshing} className="text-xs border border-bg-border rounded-md px-2 py-1 text-slate-300 hover:text-white disabled:opacity-50">
          {refreshing ? "…" : "Refresh"}
        </button>
      </div>

      {data.rows.length === 0 ? (
        <div className="text-sm text-slate-400">No bulk deals available for today.</div>
      ) : (
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-bg-panel-solid">
              <tr>
                <th className="text-left px-2 py-1.5">Symbol</th>
                <th className="text-left px-2 py-1.5">Client</th>
                <th className="text-center px-2 py-1.5">Side</th>
                <th className="text-right px-2 py-1.5">Qty</th>
                <th className="text-right px-2 py-1.5">Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {data.rows.map((d, i) => (
                <tr key={i} className={clsx(watched.has(d.symbol.toUpperCase()) && "bg-accent-info/5")}>
                  <td className="px-2 py-1.5">
                    <span className="text-white font-mono">{d.symbol}</span>
                    {watched.has(d.symbol.toUpperCase()) && (
                      <span className="ml-1.5 bg-accent-info/20 text-accent-info text-[9px] px-1 py-0.5 rounded font-bold">★ WL</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-slate-400 text-[11px] truncate max-w-[180px]" title={d.clientName}>{d.clientName}</td>
                  <td className={clsx("px-2 py-1.5 text-center font-bold", d.side === "BUY" ? "text-accent-buy" : "text-accent-sell")}>{d.side}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-300">{d.qty.toLocaleString("en-IN")}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-300">₹{d.price.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.watchlistMatches.length > 0 && (
        <div className="mt-3 text-[11px] text-accent-info">
          <span className="font-bold">★</span> Your watchlist symbols in today's deals: <span className="font-mono text-white">{data.watchlistMatches.join(", ")}</span>
        </div>
      )}
    </div>
  );
}
