/**
 * Toolbar that sits directly above the candlestick chart.
 *
 * Renders 5 pill-shaped toggle chips, one per premium indicator. Each chip
 * shows the indicator's icon + name; selected chips fill with the indicator's
 * color glow. Tooltips appear after 500ms hover. Keyboard shortcut hint
 * shown in the tooltip body.
 *
 * No indicator math here — the chip simply flips the `usePremium` state.
 * The Chart's overlay manager + the right-panel cards observe that store
 * and react.
 */

import { useEffect, useState, type CSSProperties } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { PREMIUM_KEYS, PREMIUM_META, usePremium, type PremiumKey } from "../store/premium";

export default function PremiumIndicatorsToolbar() {
  const active = usePremium((s) => s.active);
  const loading = usePremium((s) => s.loading);
  const toggle = usePremium((s) => s.toggle);

  // Listen for layout-restore events from the chart drawing toolbar.
  // When the user loads a saved layout we receive the overlay keys it
  // had active and reconcile: enable any that are missing, disable any
  // that are present but shouldn't be. Keeps the chart and toolbar in
  // sync without coupling the components directly.
  useEffect(() => {
    function handler(e: Event) {
      const wanted = ((e as CustomEvent).detail as string[] | undefined) ?? [];
      const valid = new Set(PREMIUM_KEYS as readonly string[]);
      const wantedSet = new Set(wanted.filter((k) => valid.has(k)));
      // Use a fresh state snapshot to avoid stale closure on `active`.
      const cur = usePremium.getState().active;
      for (const k of PREMIUM_KEYS) {
        const shouldBeOn = wantedSet.has(k);
        const isOn = cur.has(k);
        if (shouldBeOn !== isOn) toggle(k);
      }
    }
    window.addEventListener("qti:apply-overlays", handler);
    return () => window.removeEventListener("qti:apply-overlays", handler);
  }, [toggle]);

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-bg-border bg-bg-panel-solid/70 backdrop-blur-glass">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 whitespace-nowrap">
        ⚡ Premium Indicators
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {PREMIUM_KEYS.map((k) => (
          <Chip
            key={k}
            k={k}
            on={active.has(k)}
            busy={loading.has(k)}
            onClick={() => toggle(k)}
          />
        ))}
      </div>
    </div>
  );
}

function Chip({ k, on, busy, onClick }: { k: PremiumKey; on: boolean; busy: boolean; onClick: () => void }) {
  const meta = PREMIUM_META[k];
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <motion.button
        whileTap={{ scale: 0.96 }}
        onClick={onClick}
        aria-pressed={on}
        className={clsx(
          "relative inline-flex items-center gap-1.5 rounded-full px-3 h-8 text-xs font-medium border transition-colors",
          on
            ? "border-transparent text-white shadow-[0_0_18px_-4px_var(--chip-color)]"
            : "border-bg-border text-slate-400 hover:text-slate-200",
          hovered && !on && "bg-bg-elevated/60",
          busy && "opacity-70"
        )}
        style={{
          // Custom-property lets the shadow + bg react to the indicator color.
          // CSS variables work inside Tailwind's arbitrary-value bracket above.
          "--chip-color": meta.color,
          background: on ? meta.bg : undefined,
          borderColor: on ? meta.color : undefined,
        } as CSSProperties}
      >
        <span className="text-sm leading-none">
          {busy ? <Spinner color={meta.color} /> : meta.icon}
        </span>
        <span className="leading-none">{meta.label}</span>
        {on && (
          <span
            className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 h-[2px] w-6 rounded-full"
            style={{ background: meta.color }}
          />
        )}
      </motion.button>
    </div>
  );
}

function Spinner({ color }: { color: string }) {
  return (
    <svg className="animate-spin" width="13" height="13" viewBox="0 0 13 13" aria-hidden>
      <circle cx="6.5" cy="6.5" r="5" fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M11.5 6.5a5 5 0 0 0-5-5" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
