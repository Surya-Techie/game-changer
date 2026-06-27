import clsx from "clsx";

export interface Position {
  _id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  status: "OPEN" | "CLOSED";
}

interface Props {
  positions: Position[];
  prices: Record<string, number>;
  onClose: (id: string) => void;
  onSelect: (symbol: string) => void;
}

export default function PositionsPanel({ positions, prices, onClose, onSelect }: Props) {
  if (positions.length === 0) {
    return (
      <div className="bg-bg-panel border border-bg-border rounded-xl p-5">
        <div className="text-sm uppercase tracking-wider text-slate-500 mb-2">Open Positions</div>
        <div className="text-slate-400 text-sm">No open positions. The auto-trader will open one when an AI signal clears your confidence threshold.</div>
      </div>
    );
  }

  return (
    <div className="bg-bg-panel border border-bg-border rounded-xl overflow-hidden">
      <div className="px-5 pt-5 pb-3 text-sm uppercase tracking-wider text-slate-500 flex justify-between items-center">
        <span>Open Positions</span>
        <span className="text-xs font-mono text-slate-400">{positions.length}</span>
      </div>
      <div className="divide-y divide-bg-border">
        {positions.map((p) => {
          const last = prices[p.symbol] ?? p.entryPrice;
          const pnl = p.side === "LONG" ? (last - p.entryPrice) * p.qty : (p.entryPrice - last) * p.qty;
          const pnlPct = (((last - p.entryPrice) / p.entryPrice) * 100) * (p.side === "LONG" ? 1 : -1);
          const up = pnl >= 0;
          return (
            <div key={p._id} className="px-5 py-3 hover:bg-bg-elevated/40">
              <div className="flex items-center justify-between mb-2">
                <button onClick={() => onSelect(p.symbol)} className="flex items-center gap-2 text-left">
                  <span className="font-semibold text-white">{p.symbol}</span>
                  <span
                    className={clsx(
                      "px-1.5 py-0.5 rounded text-[10px] font-bold",
                      p.side === "LONG"
                        ? "bg-accent-buy/20 text-accent-buy"
                        : "bg-accent-sell/20 text-accent-sell"
                    )}
                  >
                    {p.side}
                  </span>
                  <span className="text-xs text-slate-500">×{p.qty}</span>
                </button>
                <button
                  onClick={() => onClose(p._id)}
                  className="text-xs text-slate-500 hover:text-accent-sell"
                >
                  Close
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs font-mono">
                <Field label="Entry" value={p.entryPrice.toFixed(2)} />
                <Field label="Last" value={last.toFixed(2)} />
                <Field label="Stop" value={p.stopPrice?.toFixed(2) ?? "—"} tone="sell" />
                <Field label="Target" value={p.targetPrice?.toFixed(2) ?? "—"} tone="buy" />
              </div>
              <div className="mt-2 flex justify-between items-center">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">MTM</span>
                <span className={clsx("font-mono tabular-nums text-sm", up ? "text-accent-buy" : "text-accent-sell")}>
                  {up ? "+" : ""}₹{pnl.toFixed(2)} ({pnlPct.toFixed(2)}%)
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: "buy" | "sell" }) {
  return (
    <div>
      <div className="text-slate-500">{label}</div>
      <div className={tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-slate-200"}>
        {value}
      </div>
    </div>
  );
}
