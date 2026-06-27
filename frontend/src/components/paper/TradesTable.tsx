import clsx from "clsx";
import type { PaperTrade } from "../../lib/paperApi";

interface Props {
  trades: PaperTrade[];
  showTotals?: boolean;
}

export default function TradesTable({ trades, showTotals }: Props) {
  if (trades.length === 0) {
    return (
      <div className="p-6 text-center space-y-2">
        <div className="text-3xl">📒</div>
        <div className="text-sm text-slate-300">No closed trades yet</div>
        <div className="text-xs text-slate-500 max-w-md mx-auto">
          Close any open position (manually or via SL/TP) and the trade record will appear here
          with entry, exit, P&amp;L, hold duration, and exit reason.
        </div>
      </div>
    );
  }
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const total = trades.reduce((a, t) => a + t.netPnl, 0);
  return (
    <div className="overflow-auto">
      <table className="w-full text-xs font-mono">
        <thead className="text-[10px] uppercase text-slate-500">
          <tr>
            <Th>Time</Th>
            <Th>Symbol</Th>
            <Th>Dir</Th>
            <Th>Qty</Th>
            <Th>Entry</Th>
            <Th>Exit</Th>
            <Th>Net P&L</Th>
            <Th>P&L %</Th>
            <Th>Held</Th>
            <Th>Exit</Th>
            <Th>Strategy</Th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t._id} className="border-t border-bg-border hover:bg-bg-elevated/40">
              <Td>{new Date(t.exitTime).toLocaleString("en-IN", { hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</Td>
              <Td className="text-white font-semibold">{t.symbol}</Td>
              <Td className={t.direction === "LONG" ? "text-accent-buy" : "text-accent-sell"}>{t.direction}</Td>
              <Td>{t.qty}</Td>
              <Td>₹{t.entryPrice.toFixed(2)}</Td>
              <Td>₹{t.exitPrice.toFixed(2)}</Td>
              <Td className={t.netPnl > 0 ? "text-accent-buy" : t.netPnl < 0 ? "text-accent-sell" : ""}>
                {t.netPnl >= 0 ? "+" : ""}₹{t.netPnl.toFixed(0)}
              </Td>
              <Td className={t.netPnl > 0 ? "text-accent-buy" : t.netPnl < 0 ? "text-accent-sell" : ""}>
                {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
              </Td>
              <Td>{fmtDuration(t.holdDurationMins)}</Td>
              <Td>{t.exitReason}</Td>
              <Td>{t.strategyTag || "—"}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      {showTotals && (
        <div className="text-xs text-slate-400 font-mono px-2 py-2 border-t border-bg-border flex gap-4">
          <span>{trades.length} trades</span>
          <span>{wins} wins</span>
          <span>Win rate: {((wins / trades.length) * 100).toFixed(1)}%</span>
          <span className={total > 0 ? "text-accent-buy" : "text-accent-sell"}>
            Total: {total >= 0 ? "+" : ""}₹{total.toFixed(0)}
          </span>
        </div>
      )}
    </div>
  );
}

function fmtDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left py-2 px-2 font-normal">{children}</th>
);
const Td = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <td className={clsx("py-2 px-2", className)}>{children}</td>
);
