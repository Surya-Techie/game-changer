import clsx from "clsx";
import { useState } from "react";
import { paperApi, type PaperPosition } from "../../lib/paperApi";

interface Props {
  positions: PaperPosition[];
  onMutate: () => void;
  onSelectSymbol: (s: string) => void;
}

export default function PositionsTable({ positions, onMutate, onSelectSymbol }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function close(p: PaperPosition, pct?: number) {
    setBusy(true);
    try {
      const qty = pct ? Math.max(1, Math.floor(p.qty * (pct / 100))) : undefined;
      await paperApi.closePosition(p._id, qty);
      onMutate();
    } finally {
      setBusy(false);
    }
  }

  if (positions.length === 0) {
    return (
      <div className="p-6 text-center space-y-2">
        <div className="text-3xl">📈</div>
        <div className="text-sm text-slate-300">No open positions yet</div>
        <div className="text-xs text-slate-500 max-w-md mx-auto">
          Use the order terminal above to place your first paper trade. Pick a symbol, set quantity,
          choose <span className="text-white font-mono">LONG (B)</span> or <span className="text-white font-mono">SHORT (S)</span>,
          and click <span className="text-white">Place Paper Order</span>. Positions show here with live P&amp;L.
        </div>
      </div>
    );
  }
  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-[10px] uppercase text-slate-500">
        <tr>
          <Th>Symbol</Th>
          <Th>Dir</Th>
          <Th>Qty</Th>
          <Th>Entry</Th>
          <Th>LTP</Th>
          <Th>P&L</Th>
          <Th>P&L %</Th>
          <Th>SL</Th>
          <Th>TP</Th>
          <Th>Held</Th>
          <Th>Strategy</Th>
          <Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const cur = p.currentPrice ?? p.avgEntryPrice;
          const pnl = p.unrealisedPnl ?? 0;
          const pnlPct = ((cur - p.avgEntryPrice) / p.avgEntryPrice) * 100 * (p.direction === "LONG" ? 1 : -1);
          const heldMin = Math.max(0, Math.floor((Date.now() - new Date(p.openedAt).getTime()) / 60_000));
          const hh = Math.floor(heldMin / 60);
          const mm = heldMin % 60;
          return (
            <>
              <tr
                key={p._id}
                onClick={() => {
                  setOpenId(openId === p._id ? null : p._id);
                  onSelectSymbol(p.symbol);
                }}
                className="border-t border-bg-border hover:bg-bg-elevated/40 cursor-pointer"
              >
                <Td className="text-white font-semibold">{p.symbol}</Td>
                <Td className={p.direction === "LONG" ? "text-accent-buy" : "text-accent-sell"}>{p.direction}</Td>
                <Td>{p.qty}</Td>
                <Td>₹{p.avgEntryPrice.toFixed(2)}</Td>
                <Td>₹{cur.toFixed(2)}</Td>
                <Td className={pnl > 0 ? "text-accent-buy" : pnl < 0 ? "text-accent-sell" : ""}>{pnl >= 0 ? "+" : ""}₹{pnl.toFixed(0)}</Td>
                <Td className={pnl > 0 ? "text-accent-buy" : pnl < 0 ? "text-accent-sell" : ""}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%</Td>
                <Td>{p.stopLoss != null ? `₹${p.stopLoss.toFixed(2)}` : "—"}</Td>
                <Td>{p.takeProfit != null ? `₹${p.takeProfit.toFixed(2)}` : "—"}</Td>
                <Td>{hh > 0 ? `${hh}h ${mm}m` : `${mm}m`}</Td>
                <Td>{p.strategyTag || "—"}</Td>
                <Td>
                  <div className="flex gap-1">
                    <button
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); void close(p); }}
                      className="text-[10px] px-2 py-0.5 bg-rose-500/20 text-rose-300 hover:bg-rose-500/40 rounded"
                    >
                      Close
                    </button>
                  </div>
                </Td>
              </tr>
              {openId === p._id && (
                <tr className="bg-bg-elevated/30">
                  <td colSpan={12} className="p-3">
                    <div className="grid grid-cols-3 gap-4 text-[11px]">
                      <div>
                        <div className="text-slate-500">MAE / MFE</div>
                        <div className="text-white">
                          {p.maxAdverseExcursion != null ? `₹${p.maxAdverseExcursion.toFixed(2)}` : "—"} /
                          {" "}{p.maxFavorableExcursion != null ? `₹${p.maxFavorableExcursion.toFixed(2)}` : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">Product</div>
                        <div className="text-white">{p.productType}</div>
                      </div>
                      <div>
                        <div className="text-slate-500">Original Qty</div>
                        <div className="text-white">{p.originalQty}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => close(p, 25)}
                        disabled={busy}
                        className="text-[11px] bg-bg-elevated px-3 py-1 rounded border border-bg-border hover:bg-bg-elevated/80"
                      >
                        Close 25%
                      </button>
                      <button
                        onClick={() => close(p, 50)}
                        disabled={busy}
                        className="text-[11px] bg-bg-elevated px-3 py-1 rounded border border-bg-border hover:bg-bg-elevated/80"
                      >
                        Close 50%
                      </button>
                      <button
                        onClick={() => close(p, 75)}
                        disabled={busy}
                        className="text-[11px] bg-bg-elevated px-3 py-1 rounded border border-bg-border hover:bg-bg-elevated/80"
                      >
                        Close 75%
                      </button>
                      <button
                        onClick={() => close(p)}
                        disabled={busy}
                        className="text-[11px] bg-rose-500/30 text-rose-200 px-3 py-1 rounded border border-rose-500/40 hover:bg-rose-500/50"
                      >
                        Close 100%
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </>
          );
        })}
      </tbody>
    </table>
  );
}

const Th = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <th className={clsx("text-left py-2 px-2 font-normal", className)}>{children}</th>
);
const Td = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <td className={clsx("py-2 px-2", className)}>{children}</td>
);
