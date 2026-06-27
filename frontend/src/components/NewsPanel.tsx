import { useEffect, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api } from "../lib/api";

interface Item {
  id: string;
  symbol: string;
  text: string;
  ts: number;
  label?: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  score?: number;
}

export default function NewsPanel({ symbol }: { symbol?: string }) {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    let aborted = false;
    api.get("/api/news").then(({ data }) => {
      if (aborted) return;
      setItems(data.news as Item[]);
    });
    return () => {
      aborted = true;
    };
  }, []);

  const filtered = symbol ? items.filter((i) => i.symbol === symbol).concat(items.filter((i) => i.symbol !== symbol)) : items;
  const visible = filtered.slice(0, 8);

  return (
    <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5">
      <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">News + Sentiment</div>
      <div className="space-y-2">
        {visible.map((i, idx) => (
          <motion.div
            key={i.id}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.03 }}
            className="flex items-start gap-3"
          >
            <span
              className={clsx(
                "mt-1.5 h-2 w-2 rounded-full shrink-0",
                i.label === "POSITIVE"
                  ? "bg-accent-buy"
                  : i.label === "NEGATIVE"
                  ? "bg-accent-sell"
                  : "bg-slate-500"
              )}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-200 leading-snug">{i.text}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                {i.symbol} · {new Date(i.ts).toLocaleTimeString()} · score {(i.score ?? 0).toFixed(2)}
              </div>
            </div>
          </motion.div>
        ))}
        {visible.length === 0 && <div className="text-sm text-slate-400">No headlines yet.</div>}
      </div>
      <div className="mt-3 text-[10px] text-slate-500">Synthetic feed (demo). Swap with NewsAPI / Finnhub when keys are configured.</div>
    </div>
  );
}
