import { useState } from "react";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";

export interface TabDef {
  id: string;
  label: string;
  /** Optional unread count / mini-badge shown next to the label. */
  badge?: string | number;
  content: React.ReactNode;
}

interface Props {
  tabs: TabDef[];
  defaultId?: string;
  /** Where to put extra controls (collapse-all etc.) on the tab row. */
  rightAdornment?: React.ReactNode;
  /** Override active tab from parent (controlled). */
  activeId?: string;
  onChange?: (id: string) => void;
  /** Reduce vertical padding for tight contexts. */
  compact?: boolean;
}

/**
 * Tab strip with motion-animated pill slider and panel swap.
 */
export default function Tabs({ tabs, defaultId, rightAdornment, activeId, onChange, compact }: Props) {
  const [internal, setInternal] = useState(defaultId ?? tabs[0]?.id ?? "");
  const current = activeId ?? internal;
  const setCurrent = (id: string) => {
    if (activeId == null) setInternal(id);
    onChange?.(id);
  };
  const active = tabs.find((t) => t.id === current) ?? tabs[0];

  return (
    <div className="rounded-2xl border border-bg-border bg-bg-panel backdrop-blur-glass overflow-hidden shadow-sm">
      {/* Header bar */}
      <div className={clsx("flex items-center border-b border-bg-border/60 bg-bg-panel-solid/10", compact ? "px-1.5 py-1.5" : "px-3 py-2.5")}>
        <div className="flex gap-1.5">
          {tabs.map((t) => {
            const isActive = t.id === current;
            return (
              <button
                key={t.id}
                onClick={() => setCurrent(t.id)}
                className={clsx(
                  "relative px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider transition-all duration-200 rounded-lg select-none z-10",
                  isActive ? "text-white" : "text-slate-500 hover:text-slate-300"
                )}
              >
                <span className="relative z-10">{t.label}</span>
                {t.badge != null && (
                  <span className="relative z-10 ml-1.5 text-[9px] font-mono font-bold bg-bg-panel-solid/50 rounded-full px-1.5 py-0.5 text-slate-300 border border-bg-border/40">
                    {t.badge}
                  </span>
                )}
                {isActive && (
                  <motion.span
                    layoutId="active-pill"
                    className="absolute inset-0 bg-accent-info/10 border border-accent-info/20 rounded-lg shadow-sm"
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
              </button>
            );
          })}
        </div>
        {rightAdornment && <div className="ml-auto pr-1">{rightAdornment}</div>}
      </div>
      
      {/* Content panel */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={active?.id}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
          className={compact ? "p-3" : "p-3"}
        >
          {active?.content}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
