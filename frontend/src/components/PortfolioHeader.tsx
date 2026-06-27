import clsx from "clsx";
import AnimatedNumber from "./AnimatedNumber";
import { ArrowUpRight, ArrowDownRight, Power, ShieldAlert, Cpu } from "lucide-react";

export interface Portfolio {
  capital: number;
  equity: number;
  realisedPnl: number;
  unrealisedPnl: number;
  dailyPnl: number;
  openPositions: number;
  autoTradeMode: "OFF" | "SEMI" | "AUTO";
  killSwitch: boolean;
}

interface Props {
  portfolio?: Portfolio;
  onChangeMode: (mode: "OFF" | "SEMI" | "AUTO") => void;
  onToggleKillSwitch: () => void;
}

const fmtMoney = (n: number, sign = false) => {
  const prefix = sign && n > 0 ? "+" : "";
  return `${prefix}₹${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function PortfolioHeader({ portfolio, onChangeMode, onToggleKillSwitch }: Props) {
  const totalPnl = (portfolio?.realisedPnl ?? 0) + (portfolio?.unrealisedPnl ?? 0);
  const dailyUp = (portfolio?.dailyPnl ?? 0) >= 0;
  const totalUp = totalPnl >= 0;
  const isKillSwitchOn = portfolio?.killSwitch ?? false;

  return (
    <div className="px-6 py-4 border-b border-bg-border bg-bg-panel/40 backdrop-blur-glass flex items-center justify-between flex-wrap gap-4 select-none">
      {/* Stats Cards Row */}
      <div className="flex items-center gap-3 flex-wrap">
        <StatCard label="Equity" tooltip="Total current portfolio value">
          <AnimatedNumber
            value={portfolio?.equity ?? 0}
            format={(v) => fmtMoney(v)}
            className="text-base font-bold font-mono tabular-nums text-white"
          />
        </StatCard>

        <StatCard label="Day P&L" tooltip="Realised + unrealised P&L today">
          <div className="flex items-center gap-1">
            {portfolio?.dailyPnl !== 0 && (
              dailyUp ? (
                <ArrowUpRight className="h-4 w-4 text-accent-buy shrink-0" />
              ) : (
                <ArrowDownRight className="h-4 w-4 text-accent-sell shrink-0" />
              )
            )}
            <AnimatedNumber
              value={portfolio?.dailyPnl ?? 0}
              format={(v) => fmtMoney(v, true)}
              className={clsx(
                "text-base font-bold font-mono tabular-nums",
                dailyUp ? "text-accent-buy" : "text-accent-sell"
              )}
            />
          </div>
        </StatCard>

        <StatCard label="Total P&L" tooltip="Accumulated session P&L">
          <div className="flex items-center gap-1">
            {totalPnl !== 0 && (
              totalUp ? (
                <ArrowUpRight className="h-4 w-4 text-accent-buy shrink-0" />
              ) : (
                <ArrowDownRight className="h-4 w-4 text-accent-sell shrink-0" />
              )
            )}
            <AnimatedNumber
              value={totalPnl}
              format={(v) => fmtMoney(v, true)}
              className={clsx(
                "text-base font-bold font-mono tabular-nums",
                totalUp ? "text-accent-buy" : "text-accent-sell"
              )}
            />
          </div>
        </StatCard>

        <StatCard label="Realised P&L" tooltip="Booked profits/losses">
          <AnimatedNumber
            value={portfolio?.realisedPnl ?? 0}
            format={(v) => fmtMoney(v, true)}
            className={clsx(
              "text-base font-bold font-mono tabular-nums",
              (portfolio?.realisedPnl ?? 0) >= 0 ? "text-slate-200" : "text-accent-sell"
            )}
          />
        </StatCard>

        <StatCard label="Unrealised P&L" tooltip="Floating profits/losses">
          <AnimatedNumber
            value={portfolio?.unrealisedPnl ?? 0}
            format={(v) => fmtMoney(v, true)}
            className={clsx(
              "text-base font-bold font-mono tabular-nums",
              (portfolio?.unrealisedPnl ?? 0) >= 0 ? "text-slate-200" : "text-accent-sell"
            )}
          />
        </StatCard>

        <StatCard label="Open Positions" tooltip="Total active long/short positions">
          <span className="text-base font-bold font-mono tabular-nums text-white">
            {portfolio?.openPositions ?? 0}
          </span>
        </StatCard>
      </div>

      {/* Control Actions */}
      <div className="flex items-center gap-3.5 ml-auto">
        {/* Mode Selector */}
        <div className="flex items-center gap-2 bg-bg-elevated/40 border border-bg-border rounded-xl px-3 py-1.5 hover:border-bg-border/80 transition-all duration-200">
          <Cpu className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide font-display">Auto-Trade</span>
          <select
            value={portfolio?.autoTradeMode ?? "OFF"}
            onChange={(e) => onChangeMode(e.target.value as "OFF" | "SEMI" | "AUTO")}
            className="bg-transparent border-none text-xs font-bold text-white focus:outline-none cursor-pointer pr-1"
          >
            <option value="OFF" className="bg-bg-panel-solid text-slate-300">Off</option>
            <option value="SEMI" className="bg-bg-panel-solid text-slate-300">Semi</option>
            <option value="AUTO" className="bg-bg-panel-solid text-slate-300">Auto</option>
          </select>
        </div>

        {/* Kill Switch */}
        <button
          onClick={onToggleKillSwitch}
          className={clsx(
            "h-[34px] px-4 text-xs font-bold rounded-xl border flex items-center gap-2 transition-all duration-300",
            isKillSwitchOn
              ? "bg-accent-sell/15 border-accent-sell text-accent-sell animate-pulse-slow shadow-glow-sell"
              : "border-bg-border/60 text-slate-400 hover:text-accent-sell hover:border-accent-sell/40 hover:bg-accent-sell/5"
          )}
          title={isKillSwitchOn ? "Kill switch is active. Click to disarm." : "Emergency stop new trade entries"}
        >
          <Power className="h-3.5 w-3.5 shrink-0" />
          <span>{isKillSwitchOn ? "Kill Switch: Armed" : "Kill Switch"}</span>
        </button>
      </div>
    </div>
  );
}

interface StatCardProps {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}

function StatCard({ label, tooltip, children }: StatCardProps) {
  return (
    <div
      className="bg-bg-elevated/30 border border-bg-border/60 hover:border-bg-border/80 hover:bg-bg-elevated/40 px-4 py-2 rounded-xl transition-all duration-200"
      title={tooltip}
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 font-display mb-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}
