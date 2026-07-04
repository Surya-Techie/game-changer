import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Search } from "lucide-react";
import { fetchAllStocks, type StockItem } from "../lib/api";

/**
 * Commit-only symbol picker: owns its own text state and calls `onSelect`
 * only when the user picks a suggestion or presses Enter — never per
 * keystroke. Drop-in replacement for the old universe-limited `<select>`s
 * (order terminal, options, backtest, alerts, PPS) with the full 22k-stock
 * search behind it.
 */
export function SymbolPicker({ value, onSelect, className, placeholder }: {
  value: string;
  onSelect: (symbol: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <SymbolSearchInput
      value={text}
      onChange={setText}
      onCommit={(s) => {
        setText(s);
        onSelect(s);
      }}
      placeholder={placeholder ?? "Search symbol…"}
      className={className}
    />
  );
}

// Module-level cache — the 22k-stock DB is fetched once per session and
// shared by every SymbolSearchInput on the page.
let stocksCache: StockItem[] | null = null;
let stocksPromise: Promise<StockItem[]> | null = null;
async function loadStocks(): Promise<StockItem[]> {
  if (stocksCache) return stocksCache;
  if (!stocksPromise) {
    stocksPromise = fetchAllStocks()
      .then((s) => (stocksCache = s))
      .catch(() => (stocksCache = []));
  }
  return stocksPromise;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Fired when the user picks a suggestion (full, valid symbol). */
  onPick?: (symbol: string) => void;
  /** Fired on Enter — with the picked suggestion's symbol when the
   *  dropdown is open, else the raw (uppercased) input. Use this to run
   *  the actual work: nothing should fire while the user is typing. */
  onCommit?: (symbol: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Symbol input with typeahead over the full NSE+BSE stock database.
 * Type a ticker or company name ("zomato", "eternal", "reliance") and pick
 * from the dropdown — picking emits the exact tradable symbol.
 */
export default function SymbolSearchInput({ value, onChange, onPick, onCommit, placeholder, className }: Props) {
  const [open, setOpen] = useState(false);
  const [stocks, setStocks] = useState<StockItem[]>(stocksCache ?? []);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadStocks().then(setStocks);
  }, []);

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = value.split(",").pop()?.trim().toLowerCase() ?? "";
  const matches = useMemo(() => {
    if (!q || q.length < 2 || stocks.length === 0) return [];
    const starts: StockItem[] = [];
    const contains: StockItem[] = [];
    for (const s of stocks) {
      const base = s.base.toLowerCase();
      const name = s.name.toLowerCase();
      if (base.startsWith(q)) starts.push(s);
      else if (base.includes(q) || name.includes(q)) contains.push(s);
      if (starts.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 8);
  }, [q, stocks]);

  function pick(s: StockItem) {
    // Replace the last comma-segment with the picked symbol (supports the
    // comma-separated multi-symbol filter fields).
    const parts = value.split(",");
    parts[parts.length - 1] = s.symbol;
    const next = parts.map((p) => p.trim()).filter(Boolean).join(", ");
    onChange(next);
    onPick?.(s.symbol);
    onCommit?.(s.symbol);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className={clsx("relative", className)}>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 pointer-events-none" />
        <input
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={(e) => {
            setOpen(true);
            // Select the existing text so typing replaces the old symbol —
            // standard combobox behavior; prevents "RELIANCtata…" mashups.
            e.target.select();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (open && matches.length > 0) {
                pick(matches[highlight] ?? matches[0]);
                return;
              }
              // No open dropdown — only commit text that resolves to a real
              // listing. Committing arbitrary keystrokes ("RELIANCETATA…")
              // would fire junk symbols at every downstream API.
              const raw = value.split(",").pop()?.trim().toUpperCase() ?? "";
              if (raw) {
                const exact = stocks.find((s) => s.base.toUpperCase() === raw || s.symbol.toUpperCase() === raw);
                const resolved = exact?.symbol ?? matches[0]?.symbol;
                if (resolved) {
                  const parts = value.split(",");
                  parts[parts.length - 1] = resolved;
                  onChange(parts.map((p) => p.trim()).filter(Boolean).join(", "));
                  onCommit?.(resolved);
                }
              }
              setOpen(false);
              return;
            }
            if (!open || matches.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, matches.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
            else if (e.key === "Escape") setOpen(false);
          }}
          placeholder={placeholder ?? "Search symbol or company…"}
          className="w-full bg-bg-elevated border border-bg-border rounded pl-8 pr-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-accent-info transition-colors"
        />
      </div>
      {open && matches.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto card-aurora rounded-lg shadow-glass">
          {matches.map((s, i) => (
            <button
              key={s.symbol}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => pick(s)}
              className={clsx(
                "w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors",
                i === highlight ? "bg-accent-info/15 text-white" : "text-slate-300"
              )}
            >
              <span className="font-mono font-semibold text-white">{s.base}</span>
              <span className="text-xs text-slate-400 truncate flex-1">{s.name}</span>
              <span className={clsx(
                "text-[9px] font-bold px-1.5 py-0.5 rounded font-mono border",
                s.exchange === "NSE"
                  ? "bg-indigo-950/40 text-indigo-400 border-indigo-500/20"
                  : "bg-amber-950/40 text-amber-400 border-amber-500/20"
              )}>{s.exchange}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
