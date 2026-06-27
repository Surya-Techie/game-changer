import { create } from "zustand";

export type Theme = "dark" | "light";

interface PrefsState {
  theme: Theme;
  autoRefreshSec: number;
  setTheme: (t: Theme) => void;
  setAutoRefreshSec: (s: number) => void;
  hydrate: (patch: Partial<PrefsState>) => void;
}

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem("qti.theme") as Theme) ?? "dark";
}

function readInitialRefresh(): number {
  if (typeof window === "undefined") return 60;
  const s = localStorage.getItem("qti.autoRefreshSec");
  return s ? Number(s) : 60;
}

export const usePrefs = create<PrefsState>((set) => ({
  theme: readInitialTheme(),
  autoRefreshSec: readInitialRefresh(),
  setTheme: (t) => {
    localStorage.setItem("qti.theme", t);
    applyTheme(t);
    set({ theme: t });
  },
  setAutoRefreshSec: (s) => {
    localStorage.setItem("qti.autoRefreshSec", String(s));
    set({ autoRefreshSec: s });
  },
  hydrate: (patch) => set(patch as PrefsState),
}));

export function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", t);
  document.body.classList.toggle("qti-light", t === "light");
}

// Apply once on import so the very first render is correct.
if (typeof window !== "undefined") applyTheme(readInitialTheme());
