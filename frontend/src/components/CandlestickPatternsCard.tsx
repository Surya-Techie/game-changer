import { useEffect, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api } from "../lib/api";

interface CandlePattern {
  name: string;
  bias: "BULL" | "BEAR" | "NEUTRAL";
  index: number;
  t: number;
  reliability: number;
  notes: string;
}

export default function CandlestickPatternsCard({ symbol }: { symbol: string }) {
  const [patterns, setPatterns] = useState<CandlePattern[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) return;
    let aborted = false;
    const load = async () => {
      setLoading(true);
      try {
        const { data } = await api.get(`/api/analysis/candlestick/${symbol}?lookback=50`);
        if (!aborted) setPatterns((data?.patterns ?? []) as CandlePattern[]);
      } catch { /* ignore */ }
      finally { if (!aborted) setLoading(false); }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => { aborted = true; clearInterval(id); };
  }, [symbol]);

  const top = patterns.slice(0, 5);
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5">
      <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Candlestick Patterns</div>
      {loading && patterns.length === 0 && <div className="text-sm text-slate-400">Scanning candles…</div>}
      {!loading && patterns.length === 0 && (
        <div className="text-sm text-slate-400">No notable candlestick patterns in recent bars.</div>
      )}
      <div className="space-y-2">
        {top.map((p, i) => {
          const tone = p.bias === "BULL" ? "buy" : p.bias === "BEAR" ? "sell" : "neutral";
          return (
            <div key={i} className="bg-bg-elevated/40 border border-bg-border rounded-lg px-3 py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={clsx("w-1.5 h-1.5 rounded-full", tone === "buy" ? "bg-accent-buy" : tone === "sell" ? "bg-accent-sell" : "bg-slate-500")} />
                  <span className="text-sm text-white">{p.name}</span>
                  <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold",
                    tone === "buy" ? "bg-accent-buy/15 text-accent-buy" : tone === "sell" ? "bg-accent-sell/15 text-accent-sell" : "bg-slate-500/15 text-slate-400"
                  )}>{p.bias}</span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">{(p.reliability * 100).toFixed(0)}%</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">{p.notes}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{new Date(p.t).toLocaleTimeString()}</div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
