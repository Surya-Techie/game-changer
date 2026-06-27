import { useEffect, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api } from "../lib/api";

interface TfRow {
  bars: number;
  trend: "UP" | "DOWN" | "FLAT";
  rsi: number | null;
  macd: "bull" | "bear" | "neutral";
  supertrend: number;
  signal: "BULL" | "BEAR" | "NEUTRAL";
  bullVotes: number;
  bearVotes: number;
}

interface MtfResponse {
  symbol: string;
  timeframes: Record<string, TfRow>;
  alignment: { score: number; outOf: number; direction: "BULL" | "BEAR" | "NEUTRAL" };
}

const TF_ORDER = ["1m", "5m", "15m", "1h", "1D"];

export default function MTFPanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<MtfResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let aborted = false;
    const load = async () => {
      setLoading(true);
      try {
        const { data } = await api.get(`/api/analysis/mtf/${symbol}`);
        if (!aborted) {
          if (data.error) setError(data.error);
          else { setData(data as MtfResponse); setError(null); }
        }
      } catch (err: any) {
        if (!aborted) setError(err?.response?.data?.error ?? "MTF failed");
      } finally {
        if (!aborted) setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => { aborted = true; clearInterval(id); };
  }, [symbol]);

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500">Multi-Timeframe</div>
          <div className="text-xs text-slate-500">1m → 1D agreement</div>
        </div>
        {data && (
          <AlignmentBadge alignment={data.alignment} />
        )}
      </div>
      {loading && !data && <div className="text-sm text-slate-400">Aggregating timeframes…</div>}
      {error && !data && <div className="text-sm text-accent-sell">{error}</div>}
      {data && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left py-1.5 pr-2">TF</th>
                <th className="py-1.5 px-2">Trend</th>
                <th className="py-1.5 px-2">RSI</th>
                <th className="py-1.5 px-2">MACD</th>
                <th className="py-1.5 px-2">ST</th>
                <th className="py-1.5 px-2">Signal</th>
              </tr>
            </thead>
            <tbody>
              {TF_ORDER.map((tf) => {
                const row = data.timeframes[tf];
                if (!row) return null;
                return (
                  <tr key={tf} className="border-t border-bg-border/60">
                    <td className="py-1.5 pr-2 font-mono text-slate-300">{tf}</td>
                    <td className="py-1.5 px-2 text-center">{trendIcon(row.trend)}</td>
                    <td className="py-1.5 px-2 text-center font-mono text-slate-300">{row.rsi != null ? row.rsi.toFixed(0) : "—"}</td>
                    <td className="py-1.5 px-2 text-center">{cellBadge(row.macd === "bull" ? "BULL" : row.macd === "bear" ? "BEAR" : "FLAT")}</td>
                    <td className="py-1.5 px-2 text-center">{stIcon(row.supertrend)}</td>
                    <td className="py-1.5 px-2 text-center">{cellBadge(row.signal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}

function AlignmentBadge({ alignment }: { alignment: MtfResponse["alignment"] }) {
  const pct = (alignment.score / alignment.outOf) * 100;
  const conviction = pct >= 80 ? "very high" : pct >= 60 ? "high" : pct >= 40 ? "mixed" : "low";
  const tone = alignment.direction === "BULL" ? "buy" : alignment.direction === "BEAR" ? "sell" : "neutral";
  return (
    <div className="text-right">
      <div className={clsx("text-base font-bold", tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-slate-300")}>
        {alignment.score}/{alignment.outOf} {alignment.direction}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{conviction} conviction</div>
    </div>
  );
}

function trendIcon(t: "UP" | "DOWN" | "FLAT") {
  if (t === "UP") return <span className="text-accent-buy">↑</span>;
  if (t === "DOWN") return <span className="text-accent-sell">↓</span>;
  return <span className="text-slate-500">→</span>;
}

function stIcon(d: number) {
  if (d > 0) return <span className="text-accent-buy font-mono">+1</span>;
  if (d < 0) return <span className="text-accent-sell font-mono">-1</span>;
  return <span className="text-slate-500 font-mono">0</span>;
}

function cellBadge(label: string) {
  const tone =
    label === "BULL" ? "bg-accent-buy/15 text-accent-buy" :
    label === "BEAR" ? "bg-accent-sell/15 text-accent-sell" :
    "bg-slate-500/15 text-slate-400";
  return <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold", tone)}>{label}</span>;
}
