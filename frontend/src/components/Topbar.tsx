import clsx from "clsx";
import { motion } from "framer-motion";
import { Bell, ArrowUpRight, ArrowDownRight, Radio, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchPatternOhlcv } from "../lib/patternApi";

export interface TickerData {
  symbols: string[];
  prices: Record<string, number>;
  prev: Record<string, number>;
}

interface Props {
  symbol: string;
  price?: number;
  prevPrice?: number;
  wsStatus: string;
  onOpenNotifications?: () => void;
  unreadCount?: number;
  /** Optional scrolling price tape rendered under the header row. */
  ticker?: TickerData;
  onSelectSymbol?: (s: string) => void;
}

export default function Topbar({ symbol, price, prevPrice, wsStatus, onOpenNotifications, unreadCount = 0, ticker, onSelectSymbol }: Props) {
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
    <header className="bg-bg-panel border-b border-bg-border backdrop-blur-glass shadow-sm z-10 select-none">
      <div className="h-16 px-6 flex items-center justify-between">
        {/* Left side info */}
        <div className="flex items-center gap-6">
          <div>
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider font-display">Symbol</div>
            <div className="text-lg font-extrabold font-display flex items-center gap-1.5 mt-0.5 text-brand-gradient">
              {symbol || "—"}
            </div>
          </div>

          {/* Divider */}
          <span className="h-8 w-px bg-gradient-to-b from-transparent via-bg-border to-transparent" />

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
          <span className="h-8 w-px bg-gradient-to-b from-transparent via-bg-border to-transparent" />

          <div>
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider font-display">Change</div>
            <div
              className={clsx(
                "text-lg font-bold font-mono tabular-nums flex items-center gap-1 mt-0.5",
                up ? "text-accent-buy value-glow-buy" : "text-accent-sell value-glow-sell"
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
            className="h-9 px-3 flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white bg-bg-elevated/40 border border-bg-border rounded-xl hover:bg-bg-elevated/70 hover:border-accent-info/30 transition-all font-mono shine"
            title="Search Stocks (⌘K)"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Search (⌘K)</span>
          </button>

          {onOpenNotifications && (
            <button
              onClick={onOpenNotifications}
              className="relative h-9 w-9 flex items-center justify-center text-slate-400 hover:text-white bg-bg-elevated/40 border border-bg-border rounded-xl hover:bg-bg-elevated/70 hover:border-accent-info/30 transition-all"
              title="Open Notifications"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center bg-accent-sell text-white text-[9px] font-extrabold rounded-full px-1 border border-bg-panel shadow-glow-sell">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>
          )}

          <div
            className={clsx(
              "inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-xl border transition-all duration-300",
              wsStatus === "open"
                ? "border-emerald-500/25 text-accent-buy bg-accent-buy/5 shadow-glow-buy"
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
      </div>

      {/* Scrolling price tape — rendered only when the page supplies data. */}
      {ticker && ticker.symbols.length > 0 && (
        <div className="relative h-7 border-t border-bg-border/60 overflow-hidden bg-bg-panel-solid/40">
          {/* Edge fades so items appear to emerge from the frame. */}
          <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-bg to-transparent z-10" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-bg to-transparent z-10" />
          <div className="ticker-track h-full items-center">
            {[0, 1].map((copy) => (
              <div key={copy} className="flex items-center shrink-0" aria-hidden={copy === 1}>
                {ticker.symbols.map((s) => {
                  const p = ticker.prices[s];
                  const pv = ticker.prev[s];
                  const d = p != null && pv != null ? p - pv : 0;
                  const rising = d > 0;
                  const flat = d === 0;
                  return (
                    <button
                      key={`${copy}-${s}`}
                      onClick={() => onSelectSymbol?.(s)}
                      className="flex items-center gap-1.5 px-4 h-full text-[11px] font-mono tabular-nums text-slate-400 hover:text-white hover:bg-bg-elevated/40 transition-colors whitespace-nowrap"
                      tabIndex={copy === 1 ? -1 : 0}
                    >
                      <span className="font-semibold text-slate-300">{s}</span>
                      <span className={clsx(flat ? "text-slate-400" : rising ? "text-accent-buy" : "text-accent-sell")}>
                        {p != null ? p.toFixed(2) : "—"}
                      </span>
                      {!flat && p != null && pv != null && (
                        <span className={clsx("text-[10px]", rising ? "text-accent-buy/70" : "text-accent-sell/70")}>
                          {rising ? "▲" : "▼"} {Math.abs((d / pv) * 100).toFixed(2)}%
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
