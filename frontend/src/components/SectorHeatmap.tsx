import clsx from "clsx";
import { motion } from "framer-motion";

interface Props {
  symbols: string[];
  prices: Record<string, number>;
  references: Record<string, number>; // baseline price (e.g., entry-of-session)
  onSelect: (s: string) => void;
}

export default function SectorHeatmap({ symbols, prices, references, onSelect }: Props) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {symbols.map((s, i) => {
        const last = prices[s];
        const ref = references[s] ?? last;
        const pct = last && ref ? ((last - ref) / ref) * 100 : 0;
        const bg = bgFor(pct);
        return (
          <motion.button
            key={s}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, delay: i * 0.02 }}
            onClick={() => onSelect(s)}
            className={clsx(
              "rounded-lg p-3 text-left border border-bg-border/50 transition-transform",
              "hover:scale-[1.03] hover:border-bg-border"
            )}
            style={{ background: bg }}
          >
            <div className="text-[11px] font-semibold text-white/95 leading-tight">{s}</div>
            <div className="text-base font-mono text-white">{last?.toFixed(2) ?? "—"}</div>
            <div className={clsx("text-xs font-mono", pct >= 0 ? "text-white/95" : "text-white/95")}>
              {pct >= 0 ? "+" : ""}
              {pct.toFixed(2)}%
            </div>
          </motion.button>
        );
      })}
    </div>
  );
}

function bgFor(pct: number) {
  const clamped = Math.max(-3, Math.min(3, pct));
  if (clamped >= 0) {
    const a = clamped / 3;
    return `linear-gradient(135deg, rgba(22,199,132,${0.15 + a * 0.5}), rgba(22,199,132,${0.05 + a * 0.4}))`;
  }
  const a = -clamped / 3;
  return `linear-gradient(135deg, rgba(234,57,67,${0.15 + a * 0.5}), rgba(234,57,67,${0.05 + a * 0.4}))`;
}
