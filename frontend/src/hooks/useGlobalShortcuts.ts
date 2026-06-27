import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Args {
  onOpenPalette: () => void;
  onOpenHelp: () => void;
  onCloseAll: () => void;
  onPickIndex?: (i: number) => void;
}

/**
 * Global keyboard listener.
 *
 * Bindings:
 *   • Ctrl/Cmd + K → command palette
 *   • ?           → shortcut help
 *   • Esc         → close modals
 *   • 1..9        → onPickIndex(i)
 *   • G <key>     → go to page (D dashboard, W watchlist, S scanner,
 *                   H history, P portfolio, B backtest, A alerts,
 *                   , settings)
 */
export function useGlobalShortcuts({ onOpenPalette, onOpenHelp, onCloseAll, onPickIndex }: Args) {
  const nav = useNavigate();
  const [chord, setChord] = useState<null | "G">(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when focused in an input/textarea/contenteditable.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        if (e.key === "Escape") onCloseAll();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenPalette();
        return;
      }
      if (e.key === "Escape") {
        onCloseAll();
        setChord(null);
        return;
      }
      if (e.key === "?") {
        onOpenHelp();
        return;
      }

      // Number → symbol index
      if (/^[1-9]$/.test(e.key) && !chord) {
        onPickIndex?.(parseInt(e.key, 10) - 1);
        return;
      }

      // Chord: G then <letter>
      if (e.key.toLowerCase() === "g" && !chord) {
        setChord("G");
        setTimeout(() => setChord((c) => (c === "G" ? null : c)), 1500);
        return;
      }
      if (chord === "G") {
        const k = e.key.toLowerCase();
        const map: Record<string, string> = {
          d: "/", w: "/watchlist", s: "/scanner", h: "/signals",
          p: "/portfolio", b: "/backtest", a: "/alerts", ",": "/settings",
        };
        if (k in map) {
          nav(map[k]!);
          setChord(null);
          return;
        }
        setChord(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [chord, onOpenPalette, onOpenHelp, onCloseAll, onPickIndex, nav]);

  return { chord };
}
