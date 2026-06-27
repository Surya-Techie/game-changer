import { useEffect, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api } from "../lib/api";

interface Level {
  name: string;
  kind: string;
  price: number;
  distance: number;
  distancePct: number;
  side: "support" | "resistance";
}

interface LevelsResponse {
  symbol: string;
  cmp: number;
  prevDay?: { high: number; low: number; close: number };
  classic?: Record<string, number>;
  camarilla?: Record<string, number>;
  weekly?: { high: number; low: number };
  monthly?: { high: number; low: number };
  yearly?: { high: number; low: number; bars: number };
  levels: Level[];
  error?: string;
}

export default function LevelsPanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<LevelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let aborted = false;
    api.get(`/api/analysis/levels/${symbol}`).then(({ data }) => {
      if (aborted) return;
      if (data.error) setError(data.error); else setData(data as LevelsResponse);
    }).catch((err) => { if (!aborted) setError(err?.response?.data?.error ?? "Levels failed"); });
    return () => { aborted = true; };
  }, [symbol]);

  if (error) {
    return (
      <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-5">
        <div className="text-sm uppercase tracking-wider text-slate-500 mb-2">Support / Resistance</div>
        <div className="text-sm text-slate-400">{error}</div>
      </div>
    );
  }
  if (!data) return <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-5 text-slate-400 text-sm">Loading levels…</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500">Support / Resistance</div>
          <div className="text-xs text-slate-500">Sorted by distance from CMP</div>
        </div>
        <div className="font-mono text-sm text-white">CMP {data.cmp.toFixed(2)}</div>
      </div>

      <div className="overflow-y-auto max-h-64">
        <table className="w-full text-xs font-mono">
          <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-bg-panel-solid">
            <tr>
              <th className="text-left px-2 py-1.5">Level</th>
              <th className="text-right px-2 py-1.5">Price</th>
              <th className="text-right px-2 py-1.5">Distance</th>
              <th className="text-right px-2 py-1.5">%</th>
            </tr>
          </thead>
          <tbody>
            {data.levels.map((lv, i) => {
              const tone = lv.side === "support" ? "text-accent-buy" : "text-accent-sell";
              return (
                <tr key={i} className="border-t border-bg-border/60">
                  <td className="px-2 py-1.5 text-slate-300">
                    <span className={clsx("inline-block w-1.5 h-1.5 rounded-full mr-1.5", lv.side === "support" ? "bg-accent-buy" : "bg-accent-sell")} />
                    {lv.name}
                  </td>
                  <td className="px-2 py-1.5 text-right text-white">{lv.price.toFixed(2)}</td>
                  <td className={clsx("px-2 py-1.5 text-right", tone)}>{lv.distance >= 0 ? "+" : ""}{lv.distance.toFixed(2)}</td>
                  <td className={clsx("px-2 py-1.5 text-right", tone)}>{lv.distancePct >= 0 ? "+" : ""}{lv.distancePct.toFixed(2)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.classic && (
        <div className="mt-3 pt-3 border-t border-bg-border grid grid-cols-7 gap-1 text-[10px] font-mono">
          {(["S3", "S2", "S1", "P", "R1", "R2", "R3"] as const).map((k) => (
            <div key={k} className="text-center">
              <div className="text-slate-500">{k}</div>
              <div className={clsx(
                k === "P" ? "text-white" : k.startsWith("S") ? "text-accent-buy" : "text-accent-sell"
              )}>{data.classic?.[k]?.toFixed(2) ?? "—"}</div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
