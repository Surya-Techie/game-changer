import clsx from "clsx";
import { useState } from "react";
import { paperApi, type PaperOrder } from "../../lib/paperApi";

interface Props {
  orders: PaperOrder[];
  onMutate: () => void;
}

export default function PendingOrdersTable({ orders, onMutate }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  async function cancel(id: string) {
    setBusy(id);
    try {
      await paperApi.cancelOrder(id);
      onMutate();
    } finally {
      setBusy(null);
    }
  }

  if (orders.length === 0) {
    return (
      <div className="p-6 text-center space-y-2">
        <div className="text-3xl">⏳</div>
        <div className="text-sm text-slate-300">No pending orders</div>
        <div className="text-xs text-slate-500 max-w-md mx-auto">
          LIMIT, SL-MARKET and SL-LIMIT orders waiting for a trigger appear here.
          MARKET orders fill immediately and don't sit in this queue (they go straight to Open Positions).
        </div>
      </div>
    );
  }
  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-[10px] uppercase text-slate-500">
        <tr>
          <Th>Symbol</Th>
          <Th>Side</Th>
          <Th>Type</Th>
          <Th>Qty</Th>
          <Th>Trigger</Th>
          <Th>Limit</Th>
          <Th>Status</Th>
          <Th>Validity</Th>
          <Th>Placed</Th>
          <Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o._id} className="border-t border-bg-border hover:bg-bg-elevated/40">
            <Td className="text-white font-semibold">{o.symbol}</Td>
            <Td className={o.side === "BUY" ? "text-accent-buy" : "text-accent-sell"}>{o.side}</Td>
            <Td>{o.orderType.replace("_", "-")}</Td>
            <Td>{o.qty}</Td>
            <Td>{o.triggerPrice != null ? `₹${o.triggerPrice.toFixed(2)}` : "—"}</Td>
            <Td>{o.limitPrice != null ? `₹${o.limitPrice.toFixed(2)}` : "—"}</Td>
            <Td>
              <span className={clsx("px-1.5 py-0.5 rounded text-[10px]", {
                "bg-blue-500/20 text-blue-300": o.status === "PENDING",
                "bg-amber-500/20 text-amber-300": o.status === "QUEUED",
              })}>
                {o.status}
              </span>
            </Td>
            <Td>{o.validity}</Td>
            <Td>{new Date(o.createdAt).toLocaleTimeString("en-IN", { hour12: false })}</Td>
            <Td>
              <button
                disabled={busy === o._id}
                onClick={() => cancel(o._id)}
                className="text-[10px] px-2 py-0.5 bg-rose-500/20 text-rose-300 hover:bg-rose-500/40 rounded"
              >
                Cancel
              </button>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left py-2 px-2 font-normal">{children}</th>
);
const Td = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <td className={clsx("py-2 px-2", className)}>{children}</td>
);
