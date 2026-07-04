import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api, fetchAllStocks, type StockItem } from "../lib/api";
import Sparkline from "../components/Sparkline";
import { ListPlus, Loader2, CheckCircle2, ScanLine } from "lucide-react";

interface Watchlist {
  _id: string;
  name: string;
  symbols: string[];
}

interface RowData {
  symbol: string;
  price?: number;
  changePct?: number;
  recommendation?: string;
  compositeScore?: number;
  signal?: string;
  confidence?: number;
  sparkline?: number[];
  volumeRatio?: number | null;
}

/** Full live quote from /api/market/quotes (NSE via the AI service). */
interface Quote {
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prev_close: number;
  change: number;
  pct_change: number;
  ts: number;
  source: string;
}

export default function WatchlistPage() {
  const nav = useNavigate();
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowData>>({});
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quotesAt, setQuotesAt] = useState<number | null>(null);
  const [universe, setUniverse] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [addSymbol, setAddSymbol] = useState("");
  const [newListName, setNewListName] = useState("");
  const [importText, setImportText] = useState("");

  const [allStocks, setAllStocks] = useState<StockItem[]>([]);
  const [loadingStocks, setLoadingStocks] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [exchangeFilter, setExchangeFilter] = useState("ALL");
  const [sectorFilter, setSectorFilter] = useState("ALL");
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 50;

  // "Add All" bulk-add state
  const [addAllTargetWl, setAddAllTargetWl] = useState<string>("");
  const [addingAll, setAddingAll] = useState(false);
  const [addAllResult, setAddAllResult] = useState<{ added: number; skipped: number } | null>(null);

  useEffect(() => {
    void api.get("/api/market/symbols").then(({ data }) => setUniverse(data.symbols ?? []));
    void loadLists();
    
    setLoadingStocks(true);
    fetchAllStocks()
      .then((data) => setAllStocks(data))
      .catch((err) => console.error("Error loading stocks database:", err))
      .finally(() => setLoadingStocks(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, []);

  async function loadLists() {
    const { data } = await api.get("/api/watchlist");
    const ws = (data.watchlists ?? []) as Watchlist[];
    setLists(ws);
    if (!activeId) {
      if (ws.length) setActiveId(ws[0]._id);
      else setActiveId("ALL");
    }
  }

  const active = useMemo(() => lists.find((l) => l._id === activeId) ?? null, [lists, activeId]);

  useEffect(() => {
    if (!active) return;
    let aborted = false;
    (async () => {
      const base: Record<string, RowData> = {};
      for (const sym of active.symbols) {
        const { data } = await api.get(`/api/market/candles/${sym}?limit=60`);
        const candles = data.candles ?? [];
        const closes = candles.map((c: { c: number }) => c.c);
        const first = closes[0];
        const last = closes[closes.length - 1];
        base[sym] = {
          symbol: sym,
          price: last,
          changePct: first ? ((last - first) / first) * 100 : 0,
          sparkline: closes,
        };
      }
      if (!aborted) setRows(base);
    })();
    return () => { aborted = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [activeId, active?.symbols.join("|")]);

  async function runScan() {
    if (!active) return;
    setScanning(true);
    try {
      const { data } = await api.post("/api/scanner/preset/composite_strong_buy", { universe: active.symbols });
      const merged = { ...rows };
      for (const r of data.rows ?? []) {
        merged[r.symbol] = {
          ...merged[r.symbol],
          symbol: r.symbol,
          price: r.price,
          changePct: r.changePct,
          recommendation: r.recommendation,
          compositeScore: r.compositeScore,
          signal: r.signal,
          confidence: r.signalConfidence,
          volumeRatio: r.volumeRatio,
        };
      }
      setRows(merged);
    } finally {
      setScanning(false);
    }
  }

  async function patchList(patch: { name?: string; symbols?: string[] }) {
    if (!active) return;
    const { data } = await api.patch(`/api/watchlist/${active._id}`, patch);
    setLists((curr) => curr.map((l) => (l._id === active._id ? data.watchlist : l)));
  }

  async function addSym() {
    if (!active || !addSymbol) return;
    const s = addSymbol.toUpperCase();
    if (active.symbols.includes(s)) return;
    await patchList({ symbols: [...active.symbols, s] });
    setAddSymbol("");
  }

  async function removeSym(sym: string) {
    if (!active) return;
    await patchList({ symbols: active.symbols.filter((s) => s !== sym) });
  }

  async function reorder(symbol: string, dir: -1 | 1) {
    if (!active) return;
    const idx = active.symbols.indexOf(symbol);
    if (idx < 0) return;
    const next = [...active.symbols];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    await patchList({ symbols: next });
  }

  async function importSymbols() {
    if (!active || !importText.trim()) return;
    const parts = importText
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const valid = parts.filter((s) => universe.includes(s));
    const merged = Array.from(new Set([...active.symbols, ...valid]));
    await patchList({ symbols: merged });
    setImportText("");
  }

  async function newList() {
    if (!newListName.trim()) return;
    alert("New-list creation API not exposed yet — using PATCH on existing list to manage symbols.");
    setNewListName("");
  }

  const sortedRows = useMemo(() => {
    const order = active?.symbols ?? [];
    return order.map((s) => rows[s] ?? { symbol: s });
  }, [active?.symbols, rows]);

  const filteredStocks = useMemo(() => {
    return allStocks.filter((s) => {
      const cleanQ = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !cleanQ ||
        s.base.toLowerCase().includes(cleanQ) ||
        s.name.toLowerCase().includes(cleanQ) ||
        s.symbol.toLowerCase().includes(cleanQ);

      const matchesExchange = exchangeFilter === "ALL" || s.exchange === exchangeFilter;
      const matchesSector = sectorFilter === "ALL" || s.sector === sectorFilter;

      return matchesSearch && matchesExchange && matchesSector;
    });
  }, [allStocks, searchQuery, exchangeFilter, sectorFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, exchangeFilter, sectorFilter]);

  const paginatedStocks = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredStocks.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredStocks, currentPage]);

  const totalPages = Math.ceil(filteredStocks.length / ITEMS_PER_PAGE);

  // Live quotes: poll the batch endpoint for whatever is on screen —
  // the active watchlist, or the visible page of the all-stocks browser
  // (50 rows, exactly the endpoint's batch cap). Server caches for 3 s,
  // so many tabs still mean one upstream fetch. The all-stocks tab polls
  // slower (10 s) because a 50-symbol cold batch is a heavier upstream hit.
  const quoteSymbolsKey = activeId === "ALL"
    ? paginatedStocks.map((s) => s.symbol).join(",")
    : (active?.symbols ?? []).join(",");
  useEffect(() => {
    if (!quoteSymbolsKey) {
      setQuotes({});
      setQuotesAt(null);
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const { data } = await api.get("/api/market/quotes", {
          params: { symbols: quoteSymbolsKey },
        });
        if (!stop) {
          setQuotes((prev) => ({ ...prev, ...(data.quotes ?? {}) }));
          setQuotesAt(Date.now());
        }
      } catch {
        /* transient — keep the last quotes */
      }
    };
    void load();
    const t = setInterval(load, activeId === "ALL" ? 10_000 : 5_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [quoteSymbolsKey]);

  return (
    <div className="min-h-full bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4 flex justify-between items-center">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-white transition-colors">← Dashboard</Link>
          <h1 className="text-xl font-semibold text-white">Watchlists</h1>
          <div className="text-xs text-slate-500">Manage symbols, search database, run bulk Gainz Alpha scan.</div>
        </div>
        <div className="flex items-center gap-2">
          {activeId !== "ALL" && (
            <button
              onClick={runScan}
              disabled={scanning || !active}
              className="bg-accent-info hover:bg-accent-info/90 text-white rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50 transition-colors"
            >
              {scanning ? "Scanning…" : "Bulk Gainz Alpha scan"}
            </button>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4 flex flex-wrap items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-slate-500 font-mono">List Selector</span>
          <div className="flex gap-2 flex-wrap">
            {lists.map((l) => (
              <button
                key={l._id}
                onClick={() => setActiveId(l._id)}
                className={clsx(
                  "px-3 py-1.5 rounded-md text-sm border font-medium transition-all duration-200",
                  l._id === activeId 
                    ? "border-accent-info bg-accent-info/10 text-white shadow-[0_0_12px_rgba(99,102,241,0.2)]" 
                    : "border-bg-border text-slate-400 hover:border-slate-500 hover:text-white"
                )}
              >
                {l.name} <span className="text-[10px] text-slate-500">({l.symbols.length})</span>
              </button>
            ))}
            <button
              onClick={() => setActiveId("ALL")}
              className={clsx(
                "px-3 py-1.5 rounded-md text-sm border font-medium transition-all duration-200",
                activeId === "ALL" 
                  ? "border-indigo-500 bg-indigo-500/10 text-white shadow-[0_0_12px_rgba(99,102,241,0.2)]" 
                  : "border-bg-border text-slate-400 hover:border-slate-500 hover:text-white"
              )}
            >
              All Listed Stocks <span className="text-[10px] text-slate-500">({allStocks.length})</span>
            </button>
            {lists.length === 0 && <span className="text-xs text-slate-500">No watchlists yet — register fresh to seed Default.</span>}
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <input
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              placeholder="New list (coming)"
              className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-slate-200 opacity-60"
              disabled
            />
            <button onClick={newList} className="text-slate-500 cursor-not-allowed" disabled>+ New</button>
          </div>
        </section>

        {activeId === "ALL" ? (
          <>
            <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4 flex flex-wrap gap-4 items-center justify-between">
              <div className="flex flex-wrap gap-4 items-center flex-1">
                <div className="flex-1 min-w-[240px]">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-mono">Search Tickers & Names</div>
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search e.g. Reliance, Zomato..."
                    className="w-full bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-mono">Exchange Filter</div>
                  <select
                    value={exchangeFilter}
                    onChange={(e) => setExchangeFilter(e.target.value)}
                    className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
                  >
                    <option value="ALL">All Exchanges</option>
                    <option value="NSE">NSE Only</option>
                    <option value="BSE">BSE Only</option>
                  </select>
                </div>
                
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-mono">Sector Filter</div>
                  <select
                    value={sectorFilter}
                    onChange={(e) => setSectorFilter(e.target.value)}
                    className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
                  >
                    <option value="ALL">All Sectors</option>
                    <option value="Banking">Banking</option>
                    <option value="IT">IT</option>
                    <option value="Finance">Finance</option>
                    <option value="FMCG">FMCG</option>
                    <option value="Energy">Energy</option>
                    <option value="Auto">Auto</option>
                    <option value="Telecom">Telecom</option>
                    <option value="Infrastructure">Infrastructure</option>
                    <option value="Pharma">Pharma</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              {/* ── Add All Filtered Button ── */}
              <div className="flex items-end gap-2 flex-shrink-0">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-mono">Add All Filtered</div>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={addAllTargetWl}
                      onChange={(e) => {
                        setAddAllTargetWl(e.target.value);
                        setAddAllResult(null);
                      }}
                      className="bg-bg-elevated border border-bg-border rounded px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer min-w-[140px]"
                    >
                      <option value="">Select Watchlist</option>
                      {lists.map(l => (
                        <option key={l._id} value={l._id}>{l.name} ({l.symbols.length})</option>
                      ))}
                    </select>
                    <button
                      disabled={!addAllTargetWl || addingAll || filteredStocks.length === 0}
                      onClick={async () => {
                        if (!addAllTargetWl) return;
                        const targetWl = lists.find(l => l._id === addAllTargetWl);
                        if (!targetWl) return;
                        const newSymbols = filteredStocks
                          .map(s => s.symbol)
                          .filter(sym => !targetWl.symbols.includes(sym));
                        if (newSymbols.length === 0) {
                          setAddAllResult({ added: 0, skipped: filteredStocks.length });
                          return;
                        }
                        setAddingAll(true);
                        setAddAllResult(null);
                        try {
                          const merged = Array.from(new Set([...targetWl.symbols, ...newSymbols]));
                          const { data } = await api.patch(`/api/watchlist/${addAllTargetWl}`, { symbols: merged });
                          setLists(curr => curr.map(l => l._id === addAllTargetWl ? data.watchlist : l));
                          setAddAllResult({ added: newSymbols.length, skipped: filteredStocks.length - newSymbols.length });
                        } catch (err) {
                          console.error("Bulk add failed:", err);
                        } finally {
                          setAddingAll(false);
                        }
                      }}
                      className={clsx(
                        "flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold border transition-all duration-200",
                        addAllTargetWl && !addingAll && filteredStocks.length > 0
                          ? "bg-indigo-600 hover:bg-indigo-500 border-indigo-500/50 text-white shadow-[0_0_16px_rgba(99,102,241,0.15)] hover:shadow-[0_0_24px_rgba(99,102,241,0.25)]"
                          : "bg-bg-elevated border-bg-border text-slate-500 cursor-not-allowed"
                      )}
                    >
                      {addingAll ? (
                        <><Loader2 size={13} className="animate-spin" /> Adding...</>
                      ) : (
                        <><ListPlus size={13} /> Add All ({filteredStocks.length})</>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Add-All Result Banner ── */}
            {addAllResult && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium bg-emerald-950/30 border-emerald-500/20 text-emerald-400"
              >
                <CheckCircle2 size={16} />
                <span>
                  {addAllResult.added > 0
                    ? `Successfully added ${addAllResult.added} stock${addAllResult.added > 1 ? "s" : ""} to watchlist.`
                    : "All stocks are already in the watchlist."}
                  {addAllResult.skipped > 0 && addAllResult.added > 0 && (
                    <span className="text-slate-500 ml-1">({addAllResult.skipped} already existed)</span>
                  )}
                </span>
                <button
                  onClick={() => setAddAllResult(null)}
                  className="ml-auto text-slate-500 hover:text-white transition-colors text-xs"
                >
                  Dismiss
                </button>
              </motion.div>
            )}

            <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
              {loadingStocks ? (
                <div className="px-6 py-12 text-sm text-slate-400 text-center font-mono animate-pulse">Loading stock database...</div>
              ) : (
                <>
                  <div className="px-4 py-2 border-b border-bg-border flex items-center justify-between bg-black/10">
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-mono">Live quotes for this page</span>
                    <span className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500">
                      {quotesAt ? (
                        <>
                          <span className="h-1.5 w-1.5 rounded-full bg-accent-buy animate-pulse" />
                          live · refreshes every 10s
                        </>
                      ) : (
                        "loading quotes…"
                      )}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-bg-border bg-black/10">
                      <tr>
                        <th className="text-left px-4 py-3 font-mono">Symbol</th>
                        <th className="text-left px-3 py-3">Company Name</th>
                        <th className="text-right px-3 py-3 font-mono">LTP</th>
                        <th className="text-right px-3 py-3 font-mono">Chg ₹</th>
                        <th className="text-right px-3 py-3 font-mono">Chg %</th>
                        <th className="text-right px-3 py-3 font-mono">Open</th>
                        <th className="text-right px-3 py-3 font-mono">High</th>
                        <th className="text-right px-3 py-3 font-mono">Low</th>
                        <th className="text-right px-3 py-3 font-mono">Prev Close</th>
                        <th className="text-center px-3 py-3 font-mono">Exch</th>
                        <th className="text-center px-3 py-3">Sector</th>
                        <th className="text-right px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-bg-border">
                      {paginatedStocks.map((s) => {
                        const q = quotes[s.symbol];
                        const qUp = (q?.pct_change ?? 0) >= 0;
                        return (
                        <tr key={s.symbol} className="hover:bg-white/[0.01] transition-colors">
                          <td className="px-4 py-3 font-mono font-medium">
                            <button onClick={() => nav(`/?symbol=${s.symbol}`)} className="text-indigo-400 hover:text-indigo-300 font-semibold transition-colors">{s.base}</button>
                          </td>
                          <td className="px-3 py-3 text-slate-200 font-sans max-w-[200px] truncate">{s.name}</td>
                          <td className={clsx("px-3 py-3 text-right font-mono font-semibold", q ? (qUp ? "text-accent-buy" : "text-accent-sell") : "text-slate-500")}>
                            {q?.ltp != null ? q.ltp.toFixed(2) : "—"}
                          </td>
                          <td className={clsx("px-3 py-3 text-right font-mono", q ? (qUp ? "text-accent-buy" : "text-accent-sell") : "text-slate-500")}>
                            {q?.change != null ? `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)}` : "—"}
                          </td>
                          <td className={clsx("px-3 py-3 text-right font-mono", q ? (qUp ? "text-accent-buy" : "text-accent-sell") : "text-slate-500")}>
                            {q?.pct_change != null ? `${qUp ? "+" : ""}${q.pct_change.toFixed(2)}%` : "—"}
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-slate-300">{q?.open ? q.open.toFixed(2) : "—"}</td>
                          <td className="px-3 py-3 text-right font-mono text-slate-300">{q?.high ? q.high.toFixed(2) : "—"}</td>
                          <td className="px-3 py-3 text-right font-mono text-slate-300">{q?.low ? q.low.toFixed(2) : "—"}</td>
                          <td className="px-3 py-3 text-right font-mono text-slate-400">{q?.prev_close ? q.prev_close.toFixed(2) : "—"}</td>
                          <td className="px-3 py-3 text-center">
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded font-mono border ${
                              s.exchange === "NSE"
                                ? "bg-indigo-950/40 text-indigo-400 border-indigo-500/20"
                                : "bg-amber-950/40 text-amber-400 border-amber-500/20"
                            }`}>{s.exchange}</span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className="text-[10px] px-2.5 py-0.5 rounded bg-slate-800/60 text-slate-300 border border-slate-700/30">{s.sector}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-2">
                              {lists.length > 0 ? (
                                <select
                                  onChange={async (e) => {
                                    const wlId = e.target.value;
                                    if (!wlId) return;
                                    const targetWl = lists.find(l => l._id === wlId);
                                    if (targetWl) {
                                      if (targetWl.symbols.includes(s.symbol)) {
                                        alert("Stock is already in that watchlist!");
                                        e.target.value = "";
                                        return;
                                      }
                                      const updatedSymbols = [...targetWl.symbols, s.symbol];
                                      const { data } = await api.patch(`/api/watchlist/${wlId}`, { symbols: updatedSymbols });
                                      setLists(curr => curr.map(l => l._id === wlId ? data.watchlist : l));
                                      alert(`Added ${s.symbol} to ${targetWl.name}!`);
                                    }
                                    e.target.value = "";
                                  }}
                                  className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-xs text-slate-300 hover:border-slate-500 focus:outline-none transition-colors cursor-pointer"
                                >
                                  <option value="">+ Add to Watchlist</option>
                                  {lists.map(l => (
                                    <option key={l._id} value={l._id}>{l.name}</option>
                                  ))}
                                </select>
                              ) : (
                                <span className="text-xs text-slate-500 mr-2 py-1">No lists</span>
                              )}
                              <button onClick={() => nav(`/patterns/analytics?symbol=${s.symbol}`)} className="text-xs border border-purple-500/20 bg-purple-950/20 rounded px-2.5 py-1 text-purple-400 hover:bg-purple-900/30 hover:text-purple-300 transition-colors flex items-center gap-1">
                                <ScanLine size={11} />
                                Patterns
                              </button>
                              <button onClick={() => nav(`/?symbol=${s.symbol}`)} className="text-xs border border-bg-border rounded px-2.5 py-1 text-slate-300 hover:bg-slate-800 transition-colors">
                                View Chart
                              </button>
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>

                  {totalPages > 1 && (
                    <div className="border-t border-bg-border px-4 py-3 flex items-center justify-between text-xs text-slate-400 font-mono bg-black/10">
                      <div>
                        Showing {Math.min(filteredStocks.length, (currentPage - 1) * ITEMS_PER_PAGE + 1)}–
                        {Math.min(filteredStocks.length, currentPage * ITEMS_PER_PAGE)} of {filteredStocks.length} stocks
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => setCurrentPage(c => Math.max(1, c - 1))}
                          disabled={currentPage === 1}
                          className="px-2.5 py-1 rounded bg-bg-elevated border border-bg-border hover:bg-slate-850 disabled:opacity-30 transition-all cursor-pointer"
                        >
                          Previous
                        </button>
                        <span className="px-3 py-1 bg-bg-elevated border border-bg-border rounded">Page {currentPage} of {totalPages}</span>
                        <button
                          onClick={() => setCurrentPage(c => Math.min(totalPages, c + 1))}
                          disabled={currentPage === totalPages}
                          className="px-2.5 py-1 rounded bg-bg-elevated border border-bg-border hover:bg-slate-850 disabled:opacity-30 transition-all cursor-pointer"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}

                  {filteredStocks.length === 0 && (
                    <div className="px-6 py-12 text-sm text-slate-400 text-center font-mono">No stocks match the selected filters.</div>
                  )}
                </>
              )}
            </section>
          </>
        ) : (
          active && (
            <>
              <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4 flex flex-wrap gap-3 items-end">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-mono">Add symbol</div>
                  <div className="flex gap-2">
                    <input
                      list="universe-symbols"
                      value={addSymbol}
                      onChange={(e) => setAddSymbol(e.target.value)}
                      placeholder="RELIANCE"
                      className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-slate-200 w-44"
                    />
                    <datalist id="universe-symbols">
                      {universe.filter((u) => !active.symbols.includes(u)).map((u) => <option key={u} value={u} />)}
                    </datalist>
                    <button onClick={addSym} className="border border-bg-border rounded px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 transition-colors">Add</button>
                  </div>
                </div>
                <div className="flex-1 min-w-[260px]">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 font-mono">Import (comma-separated)</div>
                  <div className="flex gap-2">
                    <input
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      placeholder="TCS, INFY, HDFCBANK"
                      className="flex-1 bg-bg-elevated border border-bg-border rounded px-2 py-1 text-slate-200"
                    />
                    <button onClick={importSymbols} className="border border-bg-border rounded px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 transition-colors">Import</button>
                  </div>
                </div>
              </section>

              <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-bg-border flex items-center justify-between bg-black/10">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500 font-mono">Live quote board</span>
                  <span className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500">
                    {quotesAt ? (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-accent-buy animate-pulse" />
                        live · refreshes every 5s
                      </>
                    ) : (
                      "loading quotes…"
                    )}
                  </span>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-wider text-slate-500 bg-black/10">
                    <tr>
                      <th className="text-left px-4 py-3 font-mono">Symbol</th>
                      <th className="text-right px-3 py-3 font-mono">LTP</th>
                      <th className="text-right px-3 py-3 font-mono">Chg ₹</th>
                      <th className="text-right px-3 py-3 font-mono">Chg %</th>
                      <th className="text-right px-3 py-3 font-mono">Open</th>
                      <th className="text-right px-3 py-3 font-mono">High</th>
                      <th className="text-right px-3 py-3 font-mono">Low</th>
                      <th className="text-right px-3 py-3 font-mono">Prev Close</th>
                      <th className="px-3 py-3">Sparkline</th>
                      <th className="text-center px-3 py-3 font-mono">Signal</th>
                      <th className="text-right px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-bg-border">
                    {sortedRows.map((r, i) => {
                      const q = quotes[r.symbol];
                      const ltp = q?.ltp ?? r.price;
                      const chg = q?.change;
                      const chgPct = q?.pct_change ?? r.changePct;
                      const up = (chgPct ?? 0) >= 0;
                      const tone = r.recommendation?.includes("BUY") ? "border-l-accent-buy/50 bg-accent-buy/5" : r.recommendation?.includes("SELL") ? "border-l-accent-sell/50 bg-accent-sell/5" : "border-l-transparent";
                      return (
                        <motion.tr
                          key={r.symbol}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className={clsx("border-l-4 hover:bg-white/[0.005] transition-colors", tone)}
                        >
                          <td className="px-4 py-2">
                            <button onClick={() => nav(`/?symbol=${r.symbol}`)} className="text-white font-semibold hover:text-indigo-300 transition-colors">{r.symbol}</button>
                          </td>
                          <td className={clsx("px-3 py-2 text-right font-mono font-semibold", up ? "text-accent-buy" : "text-accent-sell")}>
                            {ltp != null ? ltp.toFixed(2) : "—"}
                          </td>
                          <td className={clsx("px-3 py-2 text-right font-mono", up ? "text-accent-buy" : "text-accent-sell")}>
                            {chg != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}` : "—"}
                          </td>
                          <td className={clsx("px-3 py-2 text-right font-mono", up ? "text-accent-buy" : "text-accent-sell")}>
                            {chgPct != null ? `${up ? "+" : ""}${chgPct.toFixed(2)}%` : "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-300">{q?.open ? q.open.toFixed(2) : "—"}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-300">{q?.high ? q.high.toFixed(2) : "—"}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-300">{q?.low ? q.low.toFixed(2) : "—"}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-400">{q?.prev_close ? q.prev_close.toFixed(2) : "—"}</td>
                          <td className="px-3 py-2"><Sparkline points={r.sparkline ?? []} /></td>
                          <td className="px-3 py-2 text-center">
                            {r.signal ? (
                              <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold",
                                r.signal === "BUY" ? "bg-accent-buy/15 text-accent-buy" : r.signal === "SELL" ? "bg-accent-sell/15 text-accent-sell" : "bg-slate-500/15 text-slate-400")}>
                                {r.signal}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="px-4 py-2 text-right text-[11px] whitespace-nowrap">
                            <button onClick={() => reorder(r.symbol, -1)} disabled={i === 0} className="text-slate-500 hover:text-white px-1 disabled:opacity-30 transition-colors font-mono">↑</button>
                            <button onClick={() => reorder(r.symbol, 1)} disabled={i === sortedRows.length - 1} className="text-slate-500 hover:text-white px-1 disabled:opacity-30 transition-colors font-mono">↓</button>
                            <button onClick={() => removeSym(r.symbol)} className="text-slate-500 hover:text-accent-sell px-2 transition-colors">×</button>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
                {sortedRows.length === 0 && (
                  <div className="px-6 py-8 text-sm text-slate-400 text-center font-mono">List is empty — add symbols above.</div>
                )}
              </section>
            </>
          )
        )}
      </main>
    </div>
  );
}
