import clsx from "clsx";

export interface Trade {
  _id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  exitReason: "SL" | "TP" | "MANUAL" | "FLIP";
  exitAt: string;
}

export interface TradeStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

interface Props {
  trades: Trade[];
  stats?: TradeStats;
}

export default function TradesPanel({ trades, stats }: Props) {
  return (
    <div className="bg-bg-panel border border-bg-border rounded-xl overflow-hidden">
      <div className="px-5 pt-5 pb-3 flex justify-between items-end">
        <div className="text-sm uppercase tracking-wider text-slate-500">Recent Trades</div>
        {stats && (
          <div className="text-xs font-mono text-slate-400">
            {stats.wins}W / {stats.losses}L · {(stats.winRate * 100).toFixed(1)}%
          </div>
        )}
      </div>
      {trades.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-slate-400">No closed trades yet.</div>
      ) : (
        <div className="divide-y divide-bg-border max-h-64 overflow-y-auto">
          {trades.map((t) => {
            const up = t.pnl >= 0;
            return (
              <div key={t._id} className="px-5 py-2 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">{t.symbol}</span>
                  <span
                    className={clsx(
                      "px-1.5 py-0.5 rounded text-[10px] font-bold",
                      t.side === "LONG" ? "bg-accent-buy/15 text-accent-buy" : "bg-accent-sell/15 text-accent-sell"
                    )}
                  >
                    {t.side}
                  </span>
                  <span className="text-slate-500">{t.exitReason}</span>
                </div>
                <div className={clsx("font-mono tabular-nums", up ? "text-accent-buy" : "text-accent-sell")}>
                  {up ? "+" : ""}₹{t.pnl.toFixed(2)} ({t.pnlPct.toFixed(2)}%)
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
