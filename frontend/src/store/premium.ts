/**
 * Premium indicators state.
 *
 * Tracks which of the 5 premium indicators are active, per-indicator
 * settings, and (later) anchor bars for VWAP. Persisted to localStorage
 * immediately; will sync to backend in a later step.
 */

import { create } from "zustand";

export type PremiumKey = "vwap" | "orderflow" | "profile" | "ichimoku" | "smc";

export const PREMIUM_META: Record<
  PremiumKey,
  { label: string; icon: string; color: string; bg: string; tooltip: string; shortcut: string }
> = {
  vwap: {
    label: "VWAP+Bands",
    icon: "📊",
    color: "#3b82f6",
    bg: "rgba(59,130,246,0.15)",
    tooltip: "Institutional price benchmark with volatility bands",
    shortcut: "Alt+1",
  },
  orderflow: {
    label: "Order Flow",
    icon: "🌊",
    color: "#8b5cf6",
    bg: "rgba(139,92,246,0.15)",
    tooltip: "Buy vs sell pressure — who's really in control",
    shortcut: "Alt+2",
  },
  profile: {
    label: "Market Profile",
    icon: "🏛️",
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.15)",
    tooltip: "Where price spent the most time — value area",
    shortcut: "Alt+3",
  },
  ichimoku: {
    label: "Ichimoku",
    icon: "☁️",
    color: "#14b8a6",
    bg: "rgba(20,184,166,0.15)",
    tooltip: "All-in-one Japanese trend system used by bank traders",
    shortcut: "Alt+4",
  },
  smc: {
    label: "SMC / ICT",
    icon: "🧠",
    color: "#f97316",
    bg: "rgba(249,115,22,0.15)",
    tooltip: "Smart money order blocks, FVGs, liquidity — see the trap",
    shortcut: "Alt+5",
  },
};

export const PREMIUM_KEYS: PremiumKey[] = ["vwap", "orderflow", "profile", "ichimoku", "smc"];

export type LoadState = "idle" | "loading" | "ready" | "error";

interface PremiumState {
  active: Set<PremiumKey>;
  loading: Set<PremiumKey>;
  loadState: Record<PremiumKey, LoadState>;
  errors: Partial<Record<PremiumKey, string>>;
  /** Order in which cards render in the right panel (drag-to-reorder later). */
  order: PremiumKey[];
  /** Which cards are collapsed (header only). */
  collapsed: Set<PremiumKey>;
  /** Per-symbol VWAP anchor bar indices (Step 2 will use). */
  anchorBars: Record<string, number[]>;

  toggle: (k: PremiumKey) => void;
  setActive: (k: PremiumKey, on: boolean) => void;
  setLoadState: (k: PremiumKey, s: LoadState, error?: string) => void;
  toggleCollapsed: (k: PremiumKey) => void;
  collapseAll: () => void;
  expandAll: () => void;
  reorder: (newOrder: PremiumKey[]) => void;
  addAnchor: (symbol: string, bar: number) => void;
  removeAnchor: (symbol: string, bar: number) => void;
  clearAnchors: (symbol: string) => void;
}

const STORAGE_KEY = "qti.premium";

function loadPersisted() {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      active?: PremiumKey[];
      order?: PremiumKey[];
      collapsed?: PremiumKey[];
      anchorBars?: Record<string, number[]>;
    };
    return parsed;
  } catch {
    return null;
  }
}

function persist(state: PremiumState) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        active: [...state.active],
        order: state.order,
        collapsed: [...state.collapsed],
        anchorBars: state.anchorBars,
      })
    );
  } catch {
    /* quota etc. */
  }
}

const persisted = loadPersisted();

export const usePremium = create<PremiumState>((set, get) => ({
  active: new Set<PremiumKey>(persisted?.active ?? []),
  loading: new Set<PremiumKey>(),
  loadState: { vwap: "idle", orderflow: "idle", profile: "idle", ichimoku: "idle", smc: "idle" },
  errors: {},
  order: persisted?.order ?? PREMIUM_KEYS,
  collapsed: new Set<PremiumKey>(persisted?.collapsed ?? []),
  anchorBars: persisted?.anchorBars ?? {},

  toggle: (k) => {
    const active = new Set(get().active);
    if (active.has(k)) active.delete(k);
    else active.add(k);
    set({ active });
    persist({ ...get(), active });
  },

  setActive: (k, on) => {
    const active = new Set(get().active);
    if (on) active.add(k);
    else active.delete(k);
    set({ active });
    persist({ ...get(), active });
  },

  setLoadState: (k, s, error) => {
    const loadState = { ...get().loadState, [k]: s };
    const loading = new Set(get().loading);
    if (s === "loading") loading.add(k);
    else loading.delete(k);
    const errors = { ...get().errors };
    if (s === "error" && error) errors[k] = error;
    else delete errors[k];
    set({ loadState, loading, errors });
  },

  toggleCollapsed: (k) => {
    const collapsed = new Set(get().collapsed);
    if (collapsed.has(k)) collapsed.delete(k);
    else collapsed.add(k);
    set({ collapsed });
    persist({ ...get(), collapsed });
  },

  collapseAll: () => {
    const collapsed = new Set(PREMIUM_KEYS);
    set({ collapsed });
    persist({ ...get(), collapsed });
  },

  expandAll: () => {
    set({ collapsed: new Set() });
    persist({ ...get(), collapsed: new Set() });
  },

  reorder: (newOrder) => {
    set({ order: newOrder });
    persist({ ...get(), order: newOrder });
  },

  addAnchor: (symbol, bar) => {
    const existing = get().anchorBars[symbol] ?? [];
    if (existing.includes(bar) || existing.length >= 3) return;
    const anchorBars = { ...get().anchorBars, [symbol]: [...existing, bar] };
    set({ anchorBars });
    persist({ ...get(), anchorBars });
  },

  removeAnchor: (symbol, bar) => {
    const existing = get().anchorBars[symbol] ?? [];
    const anchorBars = { ...get().anchorBars, [symbol]: existing.filter((b) => b !== bar) };
    set({ anchorBars });
    persist({ ...get(), anchorBars });
  },

  clearAnchors: (symbol) => {
    const anchorBars = { ...get().anchorBars };
    delete anchorBars[symbol];
    set({ anchorBars });
    persist({ ...get(), anchorBars });
  },
}));
