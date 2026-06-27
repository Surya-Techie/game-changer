import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { paperSounds } from "../lib/paperSounds";
import type { WsPatternPayload, WsPatternSignalPayload } from "../lib/socket";

/**
 * Pattern toast — Phase 6.
 *
 * Bottom-right animated toast for high-confidence pattern events (≥80%).
 * Auto-dismiss after 8s, clickable to navigate to the symbol (via the
 * existing `qti:pick-symbol` window event).
 */

interface ToastItem {
  id: string;
  ts: number;
  payload: WsPatternPayload | WsPatternSignalPayload;
}

const DEFAULT_TTL_MS = 8_000;
const MIN_CONF_TO_SHOW = 80;

export function usePatternToasts() {
  const [items, setItems] = useState<ToastItem[]>([]);

  function push(payload: WsPatternPayload | WsPatternSignalPayload): void {
    if (payload.confidence < MIN_CONF_TO_SHOW) return;
    const id = `${payload.symbol}:${payload.pattern_name}:${payload.detected_at}`;
    const item: ToastItem = { id, ts: Date.now(), payload };
    setItems((prev) => {
      if (prev.find((p) => p.id === id)) return prev; // dedupe rapid repeats
      paperSounds.pattern();
      return [...prev, item].slice(-4); // cap at 4 visible
    });
    window.setTimeout(() => {
      setItems((prev) => prev.filter((p) => p.id !== id));
    }, DEFAULT_TTL_MS);
  }

  function dismiss(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }

  return { items, push, dismiss };
}

export function PatternToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <PatternToastItem key={item.id} item={item} onDismiss={() => onDismiss(item.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function PatternToastItem({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [progress, setProgress] = useState(1);
  const { payload } = item;
  const dir = payload.direction;
  const isSignal = (payload as WsPatternSignalPayload).signal_action != null;

  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.max(0, 1 - elapsed / DEFAULT_TTL_MS);
      setProgress(pct);
      if (pct <= 0) window.clearInterval(id);
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  const tone =
    dir === "bullish"
      ? { border: "border-accent-buy/40", bg: "bg-accent-buy/10", emoji: "🟢" }
      : dir === "bearish"
      ? { border: "border-accent-sell/40", bg: "bg-accent-sell/10", emoji: "🔴" }
      : { border: "border-amber-500/40", bg: "bg-amber-500/10", emoji: "🟡" };

  const action = isSignal ? (payload as WsPatternSignalPayload).signal_action : null;

  function onClick() {
    window.dispatchEvent(new CustomEvent<string>("qti:pick-symbol", { detail: payload.symbol }));
    window.dispatchEvent(new CustomEvent("qti:pattern-focus", { detail: payload }));
    onDismiss();
  }

  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 20, opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      className={clsx(
        "cursor-pointer text-sm text-white border rounded-lg shadow-glass overflow-hidden",
        tone.border, tone.bg
      )}
    >
      <div className="px-3 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">{tone.emoji}</span>
          <div className="min-w-0">
            <div className="truncate">
              <span className="font-medium">{payload.pattern_name}</span>
              <span className="text-slate-300"> on </span>
              <span className="font-mono">{payload.symbol}</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-2">
              <span>{payload.confidence}% · {payload.grade}</span>
              <span className="text-slate-600">·</span>
              <span>{payload.timeframe}</span>
              {action && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className="font-bold text-amber-400">{action}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          className="text-slate-500 hover:text-white px-1"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      {/* TTL progress strip — visual countdown so the user knows it's leaving. */}
      <div className="h-0.5 bg-bg-border/40">
        <div className={clsx("h-full transition-all", dir === "bullish" ? "bg-accent-buy" : dir === "bearish" ? "bg-accent-sell" : "bg-amber-500")} style={{ width: `${progress * 100}%` }} />
      </div>
    </motion.div>
  );
}
