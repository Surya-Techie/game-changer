import clsx from "clsx";
import { PATTERN_SHORT, type PpsSignal, type PpsBar } from "../lib/ppsApi";

/**
 * Scrollable signal history table. The Result column is resolved against
 * the OHLCV bars AFTER the signal: walk forward, see whether price hit the
 * target (Win) or stop (Loss) first; otherwise the trade is still Open.
 */

interface Props {
  signals: PpsSignal[];
  bars: PpsBar[];
}

type Outcome = "win" | "loss" | "open";

/**
 * Given a signal at bar_index, scan bars[bar_index+1 ..] and return win
 * (target hit first), loss (stop hit first) or open (neither). Pure helper
 * exported for testing. Uses high/low — fills at whichever boundary the bar
 * crosses, never both inside one bar (conservative for ambiguous cases).
 */
export function resolveOutcome(signal: PpsSignal, bars: PpsBar[]): Outcome {
  if (signal.signal === "HOLD") return "open";
  if (signal.entry_price == null || signal.stop_loss == null || signal.target_price == null) return "open";
  const isBuy = signal.signal === "BUY";
  const stop = signal.stop_loss;
  const target = signal.target_price;
  for (let i = signal.bar_index + 1; i < bars.length; i++) {
    const b = bars[i];
    if (isBuy) {
      const hitStop = b.low <= stop;
      const hitTgt = b.high >= target;
      if (hitStop && hitTgt) return "loss";  // ambiguous bar → conservative
      if (hitStop) return "loss";
      if (hitTgt) return "win";
    } else {
      const hitStop = b.high >= stop;
      const hitTgt = b.low <= target;
      if (hitStop && hitTgt) return "loss";
      if (hitStop) return "loss";
      if (hitTgt) return "win";
    }
  }
  return "open";
}

const outcomeBadge: Record<Outcome, { label: string; cls: string }> = {
  win: { label: "✅ Win", cls: "text-accent-buy" },
  loss: { label: "❌ Loss", cls: "text-accent-sell" },
  open: { label: "⏳ Open", cls: "text-slate-400" },
};

export default function PpsSignalTable({ signals, bars }: Props) {
  if (signals.length === 0) {
    return (
      <div className="bg-bg-panel border border-bg-border rounded-xl p-6 text-center text-sm text-slate-400">
        No actionable signals matching the current filters.
      </div>
    );
  }
  // Newest first.
  const ordered = [...signals].sort((a, b) => b.bar_index - a.bar_index);
  return (
    <div className="bg-bg-panel border border-bg-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bg-border flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-slate-400">Signal history</h3>
        <span className="text-xs text-slate-500">{ordered.length} signals</span>
      </div>
      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-bg-bg/60 sticky top-0">
            <tr className="text-slate-500 uppercase tracking-wider">
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-left font-medium">Signal</th>
              <th className="px-3 py-2 text-left font-medium">Pattern</th>
              <th className="px-3 py-2 text-right font-medium">Entry</th>
              <th className="px-3 py-2 text-right font-medium">Stop</th>
              <th className="px-3 py-2 text-right font-medium">Target</th>
              <th className="px-3 py-2 text-right font-medium">R:R</th>
              <th className="px-3 py-2 text-right font-medium">Conf</th>
              <th className="px-3 py-2 text-right font-medium">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-bg-border/60">
            {ordered.map((s) => {
              const out = resolveOutcome(s, bars);
              const o = outcomeBadge[out];
              const isBuy = s.signal === "BUY";
              return (
                <tr key={`${s.bar_index}-${s.date}`} className="hover:bg-bg-bg/30">
                  <td className="px-3 py-2 font-mono text-slate-300">{s.date}</td>
                  <td className="px-3 py-2">
                    <span
                      className={clsx(
                        "px-1.5 py-0.5 rounded font-medium",
                        isBuy ? "bg-accent-buy/15 text-accent-buy" : "bg-accent-sell/15 text-accent-sell"
                      )}
                    >
                      {s.signal}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-300">{s.pattern ? PATTERN_SHORT[s.pattern] : "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-200">{s.entry_price?.toFixed(2) ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-accent-sell">{s.stop_loss?.toFixed(2) ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-accent-buy">{s.target_price?.toFixed(2) ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{s.risk_reward?.toFixed(2) ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{(s.confidence * 100).toFixed(0)}%</td>
                  <td className={clsx("px-3 py-2 text-right whitespace-nowrap", o.cls)}>{o.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
