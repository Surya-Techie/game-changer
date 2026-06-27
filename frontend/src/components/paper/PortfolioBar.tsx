import clsx from "clsx";
import type { Portfolio } from "../../lib/paperApi";

interface Props {
  portfolio: Portfolio | null;
}

function fmtINR(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export default function PortfolioBar({ portfolio }: Props) {
  if (!portfolio) {
    return <div className="text-xs text-slate-500">Loading portfolio…</div>;
  }
  const pnlColor = portfolio.dayPnl > 0 ? "text-accent-buy" : portfolio.dayPnl < 0 ? "text-accent-sell" : "text-slate-300";
  const netColor = portfolio.netPnl > 0 ? "text-accent-buy" : portfolio.netPnl < 0 ? "text-accent-sell" : "text-slate-300";
  const healthColor = clsx({
    "text-emerald-400": portfolio.health === "GOOD",
    "text-amber-400": portfolio.health === "CAUTION",
    "text-rose-400": portfolio.health === "DANGER",
  });
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm font-mono">
      <Stat label="Equity" value={fmtINR(portfolio.equity)} />
      <Stat label="Cash" value={fmtINR(portfolio.cash)} />
      <Stat label="Margin Used" value={fmtINR(portfolio.marginUsed)} />
      <Stat label="Day P&L" value={fmtINR(portfolio.dayPnl)} valueClassName={pnlColor} />
      <Stat
        label="Net P&L"
        value={`${fmtINR(portfolio.netPnl)} (${portfolio.netPnlPct >= 0 ? "+" : ""}${portfolio.netPnlPct.toFixed(2)}%)`}
        valueClassName={netColor}
      />
      <Stat label="Open" value={String(portfolio.openPositions)} />
      <Stat label="Health" value={portfolio.health} valueClassName={healthColor} />
    </div>
  );
}

function Stat({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className={clsx("text-white tabular-nums", valueClassName)}>{value}</span>
    </div>
  );
}
