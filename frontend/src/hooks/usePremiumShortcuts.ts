/**
 * Alt + 1..5 → toggle the corresponding premium indicator.
 *
 * Mounted once in DashboardPage. Skips when focus is in an input/textarea
 * so a user typing "Alt+5" into a notes field doesn't break their flow.
 */

import { useEffect } from "react";
import { PREMIUM_KEYS, usePremium } from "../store/premium";

export function usePremiumShortcuts() {
  const toggle = usePremium((s) => s.toggle);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= PREMIUM_KEYS.length) {
        e.preventDefault();
        toggle(PREMIUM_KEYS[idx - 1]!);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle]);
}
