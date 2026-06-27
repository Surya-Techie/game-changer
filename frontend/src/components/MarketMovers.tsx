import clsx from "clsx";
import { motion } from "framer-motion";

interface Props {
  symbols: string[];
  prices: Record<string, number>;
  references: Record<string, number>;
  onSelect: (s: string) => void;
}

export default function MarketMovers({ symbols, prices, references, onSelect }: Props) {
  const rows = symbols
    .map((s) => {
      const last = prices[s];
      const ref = references[s] ?? last;
      const pct = last && ref ? ((last - ref) / ref) * 100 : 0;
      return { s, last, pct };
    })
    .filter((r) => r.last != null)
    .sort((a, b) => b.pct - a.pct);

  const gainers = rows.slice(0, 3);
  const losers = rows.slice(-3).reverse();

  return (
    <div className="grid grid-cols-2 gap-4 text-sm">
      <Column title="Top gainers" rows={gainers} positive onSelect={onSelect} />
      <Column title="Top losers" rows={losers} positive={false} onSelect={onSelect} />
    </div>
  );
}

function Column({
  title,
  rows,
  positive,
  onSelect,
}: {
  title: string;
  rows: Array<{ s: string; last?: number; pct: number }>;
  positive: boolean;
  onSelect: (s: string) => void;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">{title}</div>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <motion.button
            key={r.s}
            onClick={() => onSelect(r.s)}
            initial={{ opacity: 0, x: positive ? -8 : 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2, delay: i * 0.04 }}
            className="w-full flex justify-between items-center px-3 py-1.5 rounded-md bg-bg-elevated/60 hover:bg-bg-elevated"
          >
            <span className="font-medium text-white">{r.s}</span>
            <span className="font-mono text-slate-300">{r.last?.toFixed(2)}</span>
            <span className={clsx("font-mono", positive ? "text-accent-buy" : "text-accent-sell")}>
              {r.pct >= 0 ? "+" : ""}
              {r.pct.toFixed(2)}%
            </span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
