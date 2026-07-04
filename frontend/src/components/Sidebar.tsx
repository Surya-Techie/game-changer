import clsx from "clsx";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../store/auth";
import {
  LayoutDashboard,
  Eye,
  ScanLine,
  Layers,
  History,
  Bell,
  Briefcase,
  FileSpreadsheet,
  Calendar,
  PlayCircle,
  TrendingUp,
  Settings,
  Shield,
  User,
  Activity,
  Search
} from "lucide-react";

interface Props {
  symbols: string[];
  prices: Record<string, number>;
  prevPrices: Record<string, number>;
  active: string;
  onSelect: (s: string) => void;
}

export default function Sidebar({ symbols, prices, prevPrices, active, onSelect }: Props) {
  const user = useAuth((s) => s.user);
  const loc = useLocation();

  return (
    <aside className="w-64 shrink-0 bg-bg-panel border-r border-bg-border flex flex-col backdrop-blur-glass shadow-xl select-none z-20">
      {/* Brand Header — spinning aurora ring around the mark */}
      <div className="px-6 py-5 border-b border-bg-border flex items-center gap-3">
        <div className="relative h-10 w-10 shrink-0">
          <div className="brand-ring absolute inset-0 rounded-xl opacity-80" />
          <div className="absolute inset-[2px] rounded-[10px] bg-bg-panel-solid flex items-center justify-center shadow-glow-brand">
            <Activity className="h-5 w-5 text-accent-cyan" />
          </div>
        </div>
        <div>
          <div className="text-base font-extrabold tracking-tight font-display flex items-center gap-1.5 text-brand-gradient">
            QTI <span className="h-1.5 w-1.5 rounded-full bg-accent-buy animate-pulse" />
          </div>
          <div className="text-[10px] font-medium tracking-wider text-slate-500 uppercase">
            Quick Trade Insights
          </div>
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
        <NavLink
          to="/"
          icon={<LayoutDashboard className="h-4 w-4" />}
          label="Dashboard"
          active={loc.pathname === "/"}
        />
        <NavLink
          to="/watchlist"
          icon={<Eye className="h-4 w-4" />}
          label="Watchlist"
          active={loc.pathname === "/watchlist"}
        />
        <NavLink
          to="/scanner"
          icon={<ScanLine className="h-4 w-4" />}
          label="Scanner"
          active={loc.pathname === "/scanner"}
        />
        <NavLink
          to="/options"
          icon={<Layers className="h-4 w-4" />}
          label="Options Chain"
          active={loc.pathname.startsWith("/options")}
        />
        <NavLink
          to="/signals"
          icon={<History className="h-4 w-4" />}
          label="Signal History"
          active={loc.pathname === "/signals"}
        />
        <NavLink
          to="/alerts"
          icon={<Bell className="h-4 w-4" />}
          label="Alerts"
          active={loc.pathname === "/alerts"}
        />
        <NavLink
          to="/portfolio"
          icon={<Briefcase className="h-4 w-4" />}
          label="Portfolio"
          active={loc.pathname === "/portfolio"}
        />
        <NavLink
          to="/paper"
          icon={<FileSpreadsheet className="h-4 w-4" />}
          label={
            <span className="flex items-center justify-between w-full">
              <span>Paper Trade</span>
              <span className="text-[8px] tracking-wide font-extrabold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded-full uppercase">
                PAPER
              </span>
            </span>
          }
          active={loc.pathname.startsWith("/paper")}
        />
        <NavLink
          to="/calendar"
          icon={<Calendar className="h-4 w-4" />}
          label="Calendar"
          active={loc.pathname === "/calendar"}
        />
        <NavLink
          to="/backtest"
          icon={<PlayCircle className="h-4 w-4" />}
          label="Backtest"
          active={loc.pathname === "/backtest"}
        />
        <NavLink
          to="/patterns/analytics"
          icon={<TrendingUp className="h-4 w-4" />}
          label={
            <span className="flex items-center justify-between w-full">
              <span>Pattern Analytics</span>
              <span className="text-[8px] tracking-wide font-extrabold bg-accent-info/10 text-accent-info border border-accent-info/20 px-1.5 py-0.5 rounded-full uppercase">
                AI
              </span>
            </span>
          }
          active={loc.pathname.startsWith("/patterns/analytics")}
        />
        <NavLink
          to="/patterns/pps"
          icon={<TrendingUp className="h-4 w-4" />}
          label={
            <span className="flex items-center justify-between w-full">
              <span>PPS Signals</span>
              <span className="text-[8px] tracking-wide font-extrabold bg-accent-buy/10 text-accent-buy border border-accent-buy/20 px-1.5 py-0.5 rounded-full uppercase">
                NEW
              </span>
            </span>
          }
          active={loc.pathname.startsWith("/patterns/pps")}
        />
        <NavLink
          to="/settings"
          icon={<Settings className="h-4 w-4" />}
          label="Settings"
          active={loc.pathname === "/settings"}
        />
        <NavLink
          to="/admin"
          icon={<Shield className="h-4 w-4" />}
          label="Admin"
          active={loc.pathname === "/admin"}
        />

        {/* Watchlist Section */}
        <div className="pt-4 border-t border-bg-border/60 mt-4">
          <div className="px-3 flex justify-between items-center mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Universe Watchlist
            </span>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("qti:open-palette"))}
              className="p-1 rounded text-slate-500 hover:text-white hover:bg-bg-elevated/40 transition-all"
              title="Search Stocks (⌘K)"
            >
              <Search className="h-3 w-3" />
            </button>
          </div>
          <ul className="space-y-0.5">
            {symbols.map((s) => {
              const price = prices[s];
              const prev = prevPrices[s];
              const delta = price && prev ? price - prev : 0;
              const up = delta > 0;
              const isSelected = active === s;
              return (
                <li key={s}>
                  <button
                    onClick={() => onSelect(s)}
                    className={clsx(
                      "w-full text-left px-3 py-2 rounded-lg flex items-center justify-between text-sm transition-all duration-200 border",
                      isSelected
                        ? "card-aurora text-white shadow-sm"
                        : "border-transparent hover:bg-bg-elevated/45 text-slate-400 hover:text-slate-200"
                    )}
                  >
                    <span className={clsx("font-medium flex items-center gap-2", isSelected ? "text-white" : "text-slate-300")}>
                      {isSelected && <span className="h-1 w-1 rounded-full bg-accent-cyan shadow-glow-cyan" />}
                      {s}
                    </span>
                    <span
                      className={clsx(
                        "tabular-nums font-mono font-semibold px-1.5 py-0.5 rounded-md text-[13px]",
                        !price
                          ? "text-slate-500"
                          : up
                          ? "text-accent-buy bg-accent-buy/5"
                          : delta < 0
                          ? "text-accent-sell bg-accent-sell/5"
                          : "text-slate-300"
                      )}
                    >
                      {price?.toFixed(2) ?? "—"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      {/* User profile drawer footer */}
      <div className="p-4 border-t border-bg-border bg-bg-panel-solid/30 flex items-center gap-3">
        <div className="h-9 w-9 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-accent-info shrink-0">
          <User className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-white truncate font-display">
            {user?.name || "Trader"}
          </div>
          <div className="text-[10px] text-slate-500 truncate">{user?.email}</div>
        </div>
      </div>
    </aside>
  );
}

interface NavLinkProps {
  to: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  active: boolean;
}

function NavLink({ to, icon, label, active }: NavLinkProps) {
  return (
    <Link
      to={to}
      className={clsx(
        "relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-200 group border border-transparent",
        active
          ? "bg-active-gradient text-white border-bg-border/60 shadow-sm"
          : "text-slate-400 hover:text-slate-200 hover:bg-bg-elevated/20 hover:translate-x-0.5"
      )}
    >
      {/* Active Left Indicator Bar — aurora gradient */}
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-gradient-to-b from-accent-info via-accent-cyan to-accent-buy shadow-glow-indigo" />
      )}
      <span className={clsx("transition-transform duration-200 shrink-0", active ? "text-accent-cyan scale-110" : "text-slate-500 group-hover:text-slate-300 group-hover:scale-105")}>
        {icon}
      </span>
      <span className="font-medium truncate flex-1">{label}</span>
    </Link>
  );
}
