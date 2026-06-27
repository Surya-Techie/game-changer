import clsx from "clsx";
import { motion } from "framer-motion";
import { Bell, ArrowUpRight, ArrowDownRight, Radio, ShieldAlert, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchPatternOhlcv } from "../lib/patternApi";

interface Props {
  symbol: string;
  price?: number;
  prevPrice?: number;
  wsStatus: string;
  onOpenNotifications?: () => void;
  unreadCount?: number;
}

export default function Topbar({ symbol, price, prevPrice, wsStatus, onOpenNotifications, unreadCount = 0 }: Props) {
  // REST fallback: when the active symbol is outside the WS mock-feed
  // universe (BSE listings like ETERNAL.BO, foreign tickers, etc), the
  // WebSocket never sends a `tick` for it, so `price` stays undefined
  // and the header reads "—". Pull last-close + prev-close from the
  // shared yfinance OHLCV endpoint so the header is always populated.
  const [fallback, setFallback] = useState<{ last?: number; prev?: number }>({});
  useEffect(() => {
    setFallback({});
    if (!symbol || price != null) return;
    let cancelled = false;
    (async () => {
      // limit=3 fails the backend's min-20 validation; we only need the
      // last two closes but the route enforces a floor. Cheap to ask for 20.
      const data = await fetchPatternOhlcv(symbol, "D1", 20);
      if (cancelled || !data?.candles?.length) return;
      const candles = data.candles;
      const last = candles[candles.length - 1]?.c;
      const prev = candles[candles.length - 2]?.c;
      if (typeof last === "number") {
        setFallback({ last, prev: typeof prev === "number" ? prev : undefined });
      }
    })();
    return () => { cancelled = true; };
  }, [symbol, price]);

  const effPrice    = price    ?? fallback.last;
  const effPrevPrice = prevPrice ?? fallback.prev;

  const delta = effPrice != null && effPrevPrice != null ? effPrice - effPrevPrice : 0;
  const pct = effPrice != null && effPrevPrice != null && effPrevPrice !== 0
    ? ((effPrice - effPrevPrice) / effPrevPrice) * 100
    : 0;
  const up = delta >= 0;

  return (
    <header className="h-16 bg-bg-panel border-b border-bg-border px-6 flex items-center justify-between backdrop-blur-glass shadow-sm z-10 select-none">
      {/* Left side info */}
      <div className="flex items-center gap-6">
        <div>
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider font-display">Symbol</div>
          <div className="text-lg font-bold text-white font-display flex items-center gap-1.5 mt-0.5">
            {symbol || "—"}
          </div>
        </div>

        {/* Divider */}
        <span className="h-8 w-px bg-bg-border/60" />

        <div>
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider font-display">Last Price</div>
          <motion.div
            key={effPrice?.toFixed(2) ?? "—"}
            initial={{ opacity: 0.6, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="text-lg font-bold font-mono tabular-nums text-white mt-0.5"
          >
            {effPrice?.toFixed(2) ?? "—"}
          </motion.div>
        </div>

        {/* Divider */}
        <span className="h-8 w-px bg-bg-border/60" />

        <div>
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider font-display">Change</div>
          <div
            className={clsx(
              "text-lg font-bold font-mono tabular-nums flex items-center gap-1 mt-0.5",
              up ? "text-accent-buy" : "text-accent-sell"
            )}
          >
            {effPrice != null && effPrevPrice != null ? (
              <>
                {up ? <ArrowUpRight className="h-4.5 w-4.5" /> : <ArrowDownRight className="h-4.5 w-4.5" />}
                <span>
                  {up ? "+" : ""}
                  {delta.toFixed(2)} ({pct.toFixed(2)}%)
                </span>
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>

      {/* Right side info */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("qti:open-palette"))}
          className="h-9 px-3 flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white bg-bg-elevated/40 border border-bg-border rounded-xl hover:bg-bg-elevated/70 transition-all font-mono"
          title="Search Stocks (⌘K)"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search (⌘K)</span>
        </button>

        {onOpenNotifications && (
          <button
            onClick={onOpenNotifications}
            className="relative h-9 w-9 flex items-center justify-center text-slate-400 hover:text-white bg-bg-elevated/40 border border-bg-border rounded-xl hover:bg-bg-elevated/70 transition-all"
            title="Open Notifications"
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center bg-accent-sell text-white text-[9px] font-extrabold rounded-full px-1 border border-bg-panel shadow-sm">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
        )}

        <div
          className={clsx(
            "inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-xl border transition-all duration-300",
            wsStatus === "open"
              ? "border-emerald-500/20 text-accent-buy bg-accent-buy/5 shadow-glow-buy"
              : "border-slate-800 text-slate-500 bg-slate-900/40"
          )}
        >
          <Radio className={clsx("h-3.5 w-3.5 shrink-0", wsStatus === "open" && "animate-pulse")} />
          <span className="capitalize">{wsStatus === "open" ? "Live Feed" : "Offline"}</span>
          <span
            className={clsx(
              "h-1.5 w-1.5 rounded-full shrink-0",
              wsStatus === "open" ? "bg-accent-buy animate-ping" : "bg-slate-600"
            )}
          />
        </div>
      </div>
    </header>
  );
}
