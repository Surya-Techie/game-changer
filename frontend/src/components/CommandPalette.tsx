import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { fetchAllStocks, type StockItem } from "../lib/api";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  symbols: string[];
  onPickSymbol: (s: string) => void;
}

export default function CommandPalette({ open, onClose, symbols, onPickSymbol }: Props) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [allStocks, setAllStocks] = useState<StockItem[]>([]);
  const [, setLoadingStocks] = useState(false);

  useEffect(() => {
    if (!open) {
      setQ("");
      return;
    }
  }, [open]);

  // Load the comprehensive database of NSE and BSE stocks on mount
  useEffect(() => {
    let active = true;
    setLoadingStocks(true);
    fetchAllStocks()
      .then((data) => {
        if (active) setAllStocks(data);
      })
      .catch((err) => {
        console.error("Failed to load Indian stocks master list:", err);
      })
      .finally(() => {
        if (active) setLoadingStocks(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const commands: Cmd[] = useMemo(() => [
    { id: "go-dash", label: "Go: Dashboard", hint: "/", run: () => nav("/") },
    { id: "go-watch", label: "Go: Watchlist", hint: "/watchlist", run: () => nav("/watchlist") },
    { id: "go-scanner", label: "Go: Scanner", hint: "/scanner", run: () => nav("/scanner") },
    { id: "go-options", label: "Go: Options Chain", hint: "/options", run: () => nav("/options") },
    { id: "go-signals", label: "Go: Signal History", hint: "/signals", run: () => nav("/signals") },
    { id: "go-portfolio", label: "Go: Portfolio", hint: "/portfolio", run: () => nav("/portfolio") },
    { id: "go-paper", label: "Go: Paper Trade", hint: "/paper", run: () => nav("/paper") },
    { id: "go-paper-analytics", label: "Go: Paper Analytics", hint: "/paper/analytics", run: () => nav("/paper/analytics") },
    { id: "go-paper-journal", label: "Go: Paper Journal", hint: "/paper/journal", run: () => nav("/paper/journal") },
    { id: "go-backtest", label: "Go: Backtest", hint: "/backtest", run: () => nav("/backtest") },
    { id: "go-alerts", label: "Go: Alerts", hint: "/alerts", run: () => nav("/alerts") },
    { id: "go-calendar", label: "Go: Calendar", hint: "/calendar", run: () => nav("/calendar") },
    { id: "go-settings", label: "Go: Settings", hint: "/settings", run: () => nav("/settings") },
    { id: "go-admin", label: "Go: Admin", hint: "/admin", run: () => nav("/admin") },
  ], [nav]);

  const filteredCmds = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  // Filter 22,000+ symbols by query
  const filteredSyms = useMemo(() => {
    if (allStocks.length === 0) {
      if (!q) return symbols.slice(0, 10).map(s => ({ symbol: s, name: "Popular Stock", base: s, exchange: "NSE" }));
      return symbols
        .filter((s) => s.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 10)
        .map(s => ({ symbol: s, name: "Popular Stock", base: s, exchange: "NSE" }));
    }

    if (!q) {
      return allStocks.filter(s => symbols.includes(s.base) && s.exchange === "NSE").slice(0, 10);
    }

    const cleanQ = q.toLowerCase().trim();
    const startsWithBase = allStocks.filter(s => s.base.toLowerCase().startsWith(cleanQ));
    const includesName = allStocks.filter(s => 
      !s.base.toLowerCase().startsWith(cleanQ) && 
      (s.name.toLowerCase().includes(cleanQ) || s.symbol.toLowerCase().includes(cleanQ))
    );
    
    return [...startsWithBase, ...includesName].slice(0, 15);
  }, [q, allStocks, symbols]);

  const exactMatch = useMemo(() => {
    if (!q) return true;
    const cleanQ = q.toLowerCase().trim();
    return allStocks.some(s => s.symbol.toLowerCase() === cleanQ || s.base.toLowerCase() === cleanQ);
  }, [q, allStocks]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-24 left-1/2 -translate-x-1/2 w-full max-w-xl z-50 bg-bg-panel-solid border border-bg-border rounded-xl shadow-2xl overflow-hidden"
          >
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search 22,000+ NSE/BSE stocks or type command…"
              className="w-full px-4 py-3 bg-transparent border-b border-bg-border text-white outline-none placeholder-slate-500 font-sans"
              onKeyDown={(e) => e.key === "Escape" && onClose()}
            />
            <div className="max-h-96 overflow-y-auto">
              {filteredCmds.length > 0 && (
                <div className="py-1">
                  <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-slate-500 font-mono">Pages</div>
                  {filteredCmds.map((c) => (
                    <button key={c.id} onClick={() => { c.run(); onClose(); }} className="w-full text-left px-4 py-2 hover:bg-bg-elevated/60 flex items-center justify-between">
                      <span className="text-slate-200 text-sm">{c.label}</span>
                      <span className="text-[10px] font-mono text-slate-500">{c.hint}</span>
                    </button>
                  ))}
                </div>
              )}
              {filteredSyms.length > 0 && (
                <div className="py-1 border-t border-bg-border">
                  <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-slate-500 font-mono">Stocks</div>
                  {filteredSyms.map((s) => (
                    <button key={s.symbol} onClick={() => { onPickSymbol(s.symbol); onClose(); }} className="w-full text-left px-4 py-2 hover:bg-bg-elevated/60 flex items-center justify-between border-b border-white/[0.02]">
                      <div className="flex flex-col">
                        <span className="text-slate-200 text-sm font-mono font-medium">{s.symbol}</span>
                        <span className="text-[10px] text-slate-400 font-sans line-clamp-1">{s.name}</span>
                      </div>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded font-mono border ${
                        s.exchange === "NSE" 
                          ? "bg-indigo-950/40 text-indigo-400 border-indigo-500/20" 
                          : "bg-amber-950/40 text-amber-400 border-amber-500/20"
                      }`}>{s.exchange}</span>
                    </button>
                  ))}
                </div>
              )}
              {q.length > 0 && !exactMatch && (
                <div className="py-1 border-t border-bg-border">
                  <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-slate-500 font-mono">Custom Ticker</div>
                  <button 
                    onClick={() => { onPickSymbol(q.toUpperCase()); onClose(); }} 
                    className="w-full text-left px-4 py-2 hover:bg-bg-elevated/60 flex items-center justify-between"
                  >
                    <span className="text-slate-200 text-sm font-mono">Load raw ticker "{q.toUpperCase()}"</span>
                    <span className="text-[10px] text-slate-500 font-mono">yfinance code</span>
                  </button>
                </div>
              )}
              {filteredCmds.length === 0 && filteredSyms.length === 0 && (
                <div className="px-4 py-6 text-sm text-slate-400 text-center">No matches.</div>
              )}
            </div>
            <div className="border-t border-bg-border px-4 py-2 text-[10px] text-slate-500 font-mono flex justify-between">
              <span>↑/↓ to scroll · Enter to run</span>
              <span>⌘K / Ctrl+K</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
