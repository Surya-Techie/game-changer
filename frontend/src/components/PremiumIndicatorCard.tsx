/**
 * Generic collapsible card used by every premium indicator on the right rail.
 *
 * Header row:
 *   • color dot (indicator color)
 *   • indicator name
 *   • optional signal badge
 *   • timestamp ("12s ago")
 *   • collapse toggle ▼/▶
 *
 * Body:
 *   • whatever the indicator passes in as children
 *   • shows skeleton when loadState === "loading"
 *   • shows empty-state copy when state === "idle"
 *   • shows error with Retry when state === "error"
 *
 * Right-click on the header opens a small action menu (placeholder for the
 * "pin to top / copy / add to Gainz Alpha / details" actions in later steps).
 */

import { useEffect, useState } from "react";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { PREMIUM_META, usePremium, type PremiumKey, type LoadState } from "../store/premium";

interface Props {
  k: PremiumKey;
  state: LoadState;
  error?: string;
  /** Optional last-updated epoch ms — drives "12s ago" label. */
  updatedAt?: number;
  /** Optional signal badge like "BUY" / "NEUTRAL". */
  signal?: { label: string; tone?: "buy" | "sell" | "hold" | "info" };
  onRefresh?: () => void;
  children?: React.ReactNode;
}

export default function PremiumIndicatorCard({ k, state, error, updatedAt, signal, onRefresh, children }: Props) {
  const meta = PREMIUM_META[k];
  const collapsed = usePremium((s) => s.collapsed.has(k));
  const toggleCollapsed = usePremium((s) => s.toggleCollapsed);
  const setActive = usePremium((s) => s.setActive);
  const [menuOpen, setMenuOpen] = useState(false);

  const ago = useTimeAgo(updatedAt);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      className="rounded-xl border bg-bg-panel-solid/70 backdrop-blur-glass overflow-hidden"
      style={{ borderColor: `${meta.color}40` }}
    >
      {/* Header */}
      <div
        className="px-4 py-2.5 flex items-center gap-2 cursor-pointer select-none"
        onClick={() => toggleCollapsed(k)}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen((v) => !v); }}
      >
        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: meta.color }} />
        <span className="text-xs font-semibold text-white tracking-wide">
          {meta.icon} {meta.label}
        </span>
        {signal && (
          <span
            className={clsx(
              "ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold",
              signal.tone === "buy" && "bg-accent-buy/15 text-accent-buy",
              signal.tone === "sell" && "bg-accent-sell/15 text-accent-sell",
              signal.tone === "hold" && "bg-accent-hold/15 text-accent-hold",
              (!signal.tone || signal.tone === "info") && "bg-slate-500/15 text-slate-300"
            )}
          >
            {signal.label}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 text-[10px] text-slate-500 font-mono">
          {ago && <span>{ago}</span>}
          {onRefresh && (
            <button
              className="hover:text-white"
              title="Refresh"
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
            >
              ⟳
            </button>
          )}
          <button
            className="hover:text-accent-sell"
            title="Disable indicator"
            onClick={(e) => { e.stopPropagation(); setActive(k, false); }}
          >
            ✕
          </button>
          <span className="text-slate-500">{collapsed ? "▶" : "▼"}</span>
        </div>
      </div>

      {/* Right-click action menu (placeholder until later steps) */}
      {menuOpen && (
        <div className="px-4 pb-2 text-[11px] text-slate-400 border-t border-bg-border bg-bg-elevated/40">
          <div className="py-1 hover:text-white cursor-pointer" onClick={() => setMenuOpen(false)}>Pin to top — coming next step</div>
          <div className="py-1 hover:text-white cursor-pointer" onClick={() => setMenuOpen(false)}>Copy signal text — coming next step</div>
          <div className="py-1 hover:text-white cursor-pointer" onClick={() => setMenuOpen(false)}>Add to Gainz Alpha — Step 7</div>
          <div className="py-1 hover:text-white cursor-pointer" onClick={() => setMenuOpen(false)}>View calculation details — Step 9</div>
        </div>
      )}

      {/* Body */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="border-t border-bg-border"
          >
            <div className="px-4 py-3">
              {state === "loading" && <Skeleton color={meta.color} />}
              {state === "error" && (
                <div className="text-xs text-accent-sell">
                  {error ?? "Failed to load"}
                  {onRefresh && (
                    <button onClick={onRefresh} className="ml-2 underline hover:text-white">Retry</button>
                  )}
                </div>
              )}
              {state === "idle" && (
                <div className="text-xs text-slate-500">
                  Activated — calculation pending in next step.
                </div>
              )}
              {state === "ready" && children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Skeleton({ color }: { color: string }) {
  return (
    <div className="space-y-2">
      {[80, 60, 90].map((w, i) => (
        <div
          key={i}
          className="h-2 rounded animate-pulse"
          style={{ width: `${w}%`, background: `${color}20` }}
        />
      ))}
    </div>
  );
}

function useTimeAgo(ms?: number): string | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, [ms]);
  if (ms == null) return null;
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  // touch tick so eslint doesn't drop the dep — also forces re-render.
  void tick;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
