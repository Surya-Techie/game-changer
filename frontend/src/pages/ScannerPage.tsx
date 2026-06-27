import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { useMarketSocket, type WsEvent, type WsPatternPayload } from "../lib/socket";
import { scanPatterns, type PatternTimeframe } from "../lib/patternApi";
import { apiErrorMessage } from "../lib/errors";

interface ScanRow {
  symbol: string;
  price: number;
  changePct: number;
  rsi14: number | null;
  macdHist: number | null;
  supertrendDir: number | null;
  adx14: number | null;
  volumeRatio: number | null;
  compositeScore?: number;
  recommendation?: string;
  signal?: string;
  signalConfidence?: number;
  matched: boolean;
}

interface Condition { field: string; operator: "<" | "<=" | ">" | ">=" | "==" | "!="; value: number }

interface Preset { id: string; label: string; conditions: Condition[] }

const FIELDS = [
  { v: "rsi14", label: "RSI(14)" },
  { v: "macdHist", label: "MACD histogram" },
  { v: "supertrendDir", label: "Supertrend dir" },
  { v: "adx14", label: "ADX(14)" },
  { v: "volume_ratio", label: "Volume × 20-avg" },
  { v: "composite_score", label: "Composite score" },
  { v: "change_pct", label: "% change" },
  { v: "signal_confidence", label: "Signal confidence" },
];

export default function ScannerPage() {
  const nav = useNavigate();
  const [tab, setTab] = useState<"signal" | "pattern">("signal");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conditions, setConditions] = useState<Condition[]>([{ field: "rsi14", operator: "<", value: 30 }]);
  const [combinator, setCombinator] = useState<"AND" | "OR">("AND");
  const [includeComposite, setIncludeComposite] = useState(false);
  const [sortKey, setSortKey] = useState<keyof ScanRow>("compositeScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    void api.get("/api/scanner/presets").then(({ data }) => setPresets(data.presets ?? []));
  }, []);

  async function runPreset(id: string) {
    setRunning(true);
    setError(null);
    try {
      const { data } = await api.post(`/api/scanner/preset/${id}`, {});
      setRows((data.rows ?? []) as ScanRow[]);
    } catch (err) {
      setError(apiErrorMessage(err, "Scan failed"));
    } finally {
      setRunning(false);
    }
  }

  async function runCustom() {
    setRunning(true);
    setError(null);
    try {
      const { data } = await api.post("/api/scanner/run", { conditions, combinator, includeComposite });
      setRows((data.rows ?? []) as ScanRow[]);
    } catch (err) {
      setError(apiErrorMessage(err, "Scan failed"));
    } finally {
      setRunning(false);
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const av = (a[sortKey] as number | undefined) ?? Number.NEGATIVE_INFINITY;
    const bv = (b[sortKey] as number | undefined) ?? Number.NEGATIVE_INFINITY;
    return sortDir === "asc" ? av - bv : bv - av;
  });

  function header(label: string, key: keyof ScanRow) {
    const active = sortKey === key;
    return (
      <th
        className="px-3 py-2 cursor-pointer select-none hover:text-white"
        onClick={() => {
          if (active) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
          else { setSortKey(key); setSortDir("desc"); }
        }}
      >
        {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
      </th>
    );
  }

  return (
    <div className="min-h-screen bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4">
        <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
        <h1 className="text-xl font-semibold text-white">Market Scanner</h1>
        <div className="text-xs text-slate-500">Pre-built or custom conditions over the universe.</div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <nav className="flex gap-2 text-sm">
          {(["signal", "pattern"] as const).map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx(
                "px-4 py-2 rounded-lg border",
                tab === id
                  ? "bg-accent-info/10 border-accent-info/40 text-white"
                  : "bg-bg-panel-solid/60 border-bg-border text-slate-400 hover:text-slate-200"
              )}
            >
              {id === "signal" ? "Signal Scan" : "Pattern Scan"}
            </button>
          ))}
        </nav>

        {tab === "pattern" && <PatternScanTab />}

        {tab === "signal" && <>
        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-5">
          <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Pre-built scans</div>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => runPreset(p.id)}
                disabled={running}
                className="border border-bg-border hover:border-accent-info hover:text-white text-sm rounded-md px-3 py-1.5 text-slate-300 disabled:opacity-50"
              >
                {p.label}
              </button>
            ))}
          </div>
        </section>

        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-5 space-y-3">
          <div className="text-sm uppercase tracking-wider text-slate-500 mb-1">Custom scan</div>
          {conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={c.field}
                onChange={(e) => updateCondition(i, { ...c, field: e.target.value })}
                className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-slate-200"
              >
                {FIELDS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
              </select>
              <select
                value={c.operator}
                onChange={(e) => updateCondition(i, { ...c, operator: e.target.value as Condition["operator"] })}
                className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-slate-200"
              >
                {(["<", "<=", ">", ">=", "==", "!="] as const).map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              <input
                type="number"
                value={c.value}
                onChange={(e) => updateCondition(i, { ...c, value: Number(e.target.value) })}
                step={0.1}
                className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-slate-200 w-24 font-mono"
              />
              {conditions.length > 1 && (
                <button onClick={() => setConditions(conditions.filter((_, j) => j !== i))} className="text-slate-500 hover:text-accent-sell">×</button>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setConditions([...conditions, { field: "rsi14", operator: ">", value: 50 }])}
              className="text-xs text-accent-info hover:text-white"
            >+ Add condition</button>
            <label className="text-xs text-slate-400 flex items-center gap-2">
              Combinator
              <select value={combinator} onChange={(e) => setCombinator(e.target.value as "AND" | "OR")} className="bg-bg-elevated border border-bg-border rounded px-2 py-1">
                <option value="AND">AND</option>
                <option value="OR">OR</option>
              </select>
            </label>
            <label className="text-xs text-slate-400 flex items-center gap-2">
              <input type="checkbox" checked={includeComposite} onChange={(e) => setIncludeComposite(e.target.checked)} />
              Compute composite score (slower)
            </label>
            <button
              onClick={runCustom}
              disabled={running}
              className="bg-accent-info text-white rounded-md px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
            >
              {running ? "Running…" : "Run custom scan"}
            </button>
            {error && <span className="text-xs text-accent-sell">{error}</span>}
          </div>
        </section>

        {tab === "signal" && rows.length > 0 && (
          <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
            <div className="px-5 pt-4 pb-2 text-xs text-slate-500">{rows.filter((r) => r.matched).length} matched of {rows.length} scanned</div>
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">Symbol</th>
                  {header("LTP", "price")}
                  {header("Chg %", "changePct")}
                  {header("RSI", "rsi14")}
                  {header("MACD H", "macdHist")}
                  {header("ST dir", "supertrendDir")}
                  {header("ADX", "adx14")}
                  {header("Vol×", "volumeRatio")}
                  {header("Composite", "compositeScore")}
                  <th className="px-3 py-2">Signal</th>
                  <th className="px-3 py-2">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {sorted.map((r) => {
                  const up = r.changePct >= 0;
                  return (
                    <tr key={r.symbol} className={clsx(r.matched ? "bg-accent-info/5" : "")}>
                      <td className="px-4 py-1.5">
                        <button onClick={() => nav(`/?symbol=${r.symbol}`)} className="text-white">{r.symbol}</button>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.price.toFixed(2)}</td>
                      <td className={clsx("px-3 py-1.5 text-right font-mono", up ? "text-accent-buy" : "text-accent-sell")}>
                        {up ? "+" : ""}{r.changePct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.rsi14?.toFixed(1) ?? "—"}</td>
                      <td className={clsx("px-3 py-1.5 text-right font-mono", (r.macdHist ?? 0) >= 0 ? "text-accent-buy" : "text-accent-sell")}>{r.macdHist?.toFixed(3) ?? "—"}</td>
                      <td className="px-3 py-1.5 text-center font-mono">{r.supertrendDir ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.adx14?.toFixed(1) ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.volumeRatio?.toFixed(2) ?? "—"}</td>
                      <td className={clsx("px-3 py-1.5 text-right font-mono",
                        (r.compositeScore ?? 0) >= 65 ? "text-accent-buy" : (r.compositeScore ?? 0) <= 35 ? "text-accent-sell" : "text-slate-300"
                      )}>{r.compositeScore?.toFixed(0) ?? "—"}</td>
                      <td className="px-3 py-1.5 text-center">
                        {r.signal ? <span className={clsx("text-[10px] font-bold", r.signal === "BUY" ? "text-accent-buy" : r.signal === "SELL" ? "text-accent-sell" : "text-slate-400")}>{r.signal}</span> : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-center">{r.matched ? <span className="text-accent-buy font-bold">✓</span> : <span className="text-slate-600">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
        </>}
      </main>
    </div>
  );

  function updateCondition(idx: number, c: Condition) {
    setConditions((curr) => curr.map((x, i) => (i === idx ? c : x)));
  }
}

// ─── Pattern Scan tab — Phase 8 ─────────────────────────────────────────

const UNIVERSES: Record<string, string[]> = {
  Watchlist: [], // populated at runtime from /api/watchlist
  Nifty50: [
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "HINDUNILVR", "ITC",
    "SBIN", "BHARTIARTL", "KOTAKBANK", "LT", "HCLTECH", "AXISBANK", "WIPRO",
    "ASIANPAINT", "MARUTI", "TITAN", "SUNPHARMA", "ULTRACEMCO", "BAJFINANCE",
    "NESTLEIND", "ONGC", "POWERGRID", "NTPC", "BAJAJFINSV", "M&M", "TECHM",
    "ADANIPORTS", "JSWSTEEL", "TATASTEEL", "GRASIM", "INDUSINDBK", "DIVISLAB",
    "DRREDDY", "CIPLA", "HEROMOTOCO", "BPCL", "IOC", "EICHERMOT", "COALINDIA",
    "SHREECEM", "BRITANNIA", "HINDALCO", "TATACONSUM", "UPL", "SBILIFE",
    "HDFCLIFE", "BAJAJ-AUTO", "APOLLOHOSP", "TATAMOTORS",
  ],
  Nifty100: [
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "HINDUNILVR", "ITC",
    "SBIN", "BHARTIARTL", "KOTAKBANK", "LT", "HCLTECH", "AXISBANK", "WIPRO",
    "ASIANPAINT", "MARUTI", "TITAN", "SUNPHARMA", "ULTRACEMCO", "BAJFINANCE",
    "NESTLEIND", "ONGC", "POWERGRID", "NTPC", "BAJAJFINSV", "M&M", "TECHM",
    "ADANIPORTS", "JSWSTEEL", "TATASTEEL", "GRASIM", "INDUSINDBK", "DIVISLAB",
    "DRREDDY", "CIPLA", "HEROMOTOCO", "BPCL", "IOC", "EICHERMOT", "COALINDIA",
    "SHREECEM", "BRITANNIA", "HINDALCO", "TATACONSUM", "UPL", "SBILIFE",
    "HDFCLIFE", "BAJAJ-AUTO", "APOLLOHOSP", "TATAMOTORS",
    "AMBUJACEM", "ADANIENT", "ADANIGREEN", "ADANIPOWER", "BAJAJHLDNG",
    "BANKBARODA", "BERGEPAINT", "BIOCON", "BOSCHLTD", "CANBK",
    "CHOLAFIN", "COLPAL", "DABUR", "DLF", "GAIL",
    "GODREJCP", "HAL", "HAVELLS", "HDFCAMC", "ICICIGI",
    "ICICIPRULI", "INDIGO", "INDUSTOWER", "IRCTC", "JINDALSTEL",
    "LICHSGFIN", "LUPIN", "MARICO", "MFSL", "MPHASIS",
    "MUTHOOTFIN", "NAUKRI", "NMDC", "PEL", "PIDILITIND",
    "PIIND", "PNB", "POWERFINCORP", "RECLTD", "SAIL",
    "SBICARD", "SHRIRAMFIN", "SIEMENS", "SRF", "TATAPOWER",
    "TORNTPHARM", "TRENT", "TVSMOTOR", "VEDL", "ZEEL",
  ],
  BankNifty: [
    "HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "INDUSINDBK",
    "BANKBARODA", "PNB", "FEDERALBNK", "AUBANK", "IDFCFIRSTB", "BANDHANBNK",
  ],
  NiftyIT: ["TCS", "INFY", "WIPRO", "HCLTECH", "TECHM", "MPHASIS", "LTIM", "PERSISTENT", "COFORGE", "OFSS"],
  MidCap50: [
    "ABCAPITAL", "ABFRL", "ALKEM", "APOLLOTYRE", "AUROPHARMA", "BALKRISIND",
    "BANDHANBNK", "BHARATFORG", "CGPOWER", "CONCOR", "CUMMINSIND", "DALBHARAT",
    "DEEPAKNTR", "ESCORTS", "EXIDEIND", "FEDERALBNK", "GMRINFRA", "GODREJPROP",
    "GUJGASLTD", "IDFCFIRSTB", "INDHOTEL", "JUBLFOOD", "L&TFH", "LICHSGFIN",
    "LUPIN", "MANAPPURAM", "MAXHEALTH", "MFSL", "MRF", "MUTHOOTFIN",
    "NAUKRI", "NMDC", "OBEROIRLTY", "OFSS", "PERSISTENT", "PIIND",
    "POLYCAB", "PRESTIGE", "RAMCOCEM", "SBICARD", "SHRIRAMFIN", "SUNTV",
    "SYNGENE", "TATACHEM", "TATACOMM", "TIINDIA", "TORNTPOWER", "TVSMOTOR",
    "VOLTAS", "ZEEL",
  ],
};

interface PatternScanRow {
  symbol: string;
  timeframe: string;
  pattern_name: string;
  direction: "bullish" | "bearish" | "continuation" | "neutral";
  confidence_score: number;
  grade: string;
  risk_reward?: number;
  entry_price?: number;
  target_price?: number;
  stop_price?: number;
  served_at_ms?: number;
  detected_at?: string;
  patternId?: string;
}

type SortKey = "confidence" | "rr" | "age" | "symbol";

function PatternScanTab() {
  const nav = useNavigate();
  const token = useAuth((s) => s.token);
  const [universe, setUniverse] = useState<keyof typeof UNIVERSES>("Nifty50");
  const [timeframe, setTimeframe] = useState<PatternTimeframe>("M15");
  const [direction, setDirection] = useState<"all" | "bullish" | "bearish" | "continuation">("all");
  const [minConfidence, setMinConfidence] = useState(70);
  const [running, setRunning] = useState(false);
  const [autoScan, setAutoScan] = useState(false);
  const [rows, setRows] = useState<PatternScanRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("confidence");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [watchlistSymbols, setWatchlistSymbols] = useState<string[]>([]);

  // Load the user's watchlist once.
  useEffect(() => {
    let aborted = false;
    api.get("/api/watchlist")
      .then((r) => {
        if (aborted) return;
        const all = (r.data?.watchlists ?? []) as Array<{ symbols: string[] }>;
        const syms = Array.from(new Set(all.flatMap((w) => w.symbols ?? []).map((s) => s.toUpperCase())));
        setWatchlistSymbols(syms);
      })
      .catch(() => {});
    return () => { aborted = true; };
  }, []);

  const currentUniverse: string[] = useMemo(() => {
    if (universe === "Watchlist") return watchlistSymbols;
    return UNIVERSES[universe];
  }, [universe, watchlistSymbols]);

  async function runScan() {
    if (currentUniverse.length === 0) {
      setError("Universe is empty — add symbols to your watchlist or pick another universe.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      // The AI service caps a single /patterns/scan call at 50 symbols. Chunk
      // the universe and merge so the user can scan Nifty100 / MidCap50 too.
      const chunks: string[][] = [];
      for (let i = 0; i < currentUniverse.length; i += 50) {
        chunks.push(currentUniverse.slice(i, i + 50));
      }
      const merged: PatternScanRow[] = [];
      const results = await Promise.allSettled(
        chunks.map((c) => scanPatterns(c, timeframe, minConfidence))
      );
      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value) continue;
        for (const p of r.value.patterns) {
          merged.push({
            symbol: (p as { symbol?: string }).symbol ?? "",
            timeframe: (p as { timeframe?: string }).timeframe ?? timeframe,
            pattern_name: p.pattern_name,
            direction: p.direction,
            confidence_score: p.confidence_score,
            grade: p.grade,
            risk_reward: p.risk_reward,
            entry_price: p.entry_price,
            target_price: p.target_price,
            stop_price: p.stop_price,
            detected_at: p.detected_at,
            patternId: p._id,
            served_at_ms: Date.now(),
          });
        }
      }
      setRows(merged);
      setLastScanAt(Date.now());
    } catch (err) {
      setError(apiErrorMessage(err, "Scan failed"));
    } finally {
      setRunning(false);
    }
  }

  // Auto-scan every 5 minutes.
  const autoTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (autoTimerRef.current) window.clearInterval(autoTimerRef.current);
    autoTimerRef.current = undefined;
    if (!autoScan) return;
    autoTimerRef.current = window.setInterval(() => { void runScan(); }, 5 * 60 * 1000);
    return () => { if (autoTimerRef.current) window.clearInterval(autoTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScan, universe, timeframe, minConfidence, watchlistSymbols.join(",")]);

  // Live WS updates — prepend incoming pattern events that match the filter.
  useMarketSocket({
    token,
    symbols: currentUniverse,
    onEvent: (ev: WsEvent) => {
      if (ev.type !== "pattern" && ev.type !== "pattern_signal") return;
      const p = ev.pattern as WsPatternPayload;
      // Filter: timeframe + min_confidence + direction + universe.
      if (p.timeframe !== timeframe) return;
      if (p.confidence < minConfidence) return;
      if (direction !== "all" && p.direction !== direction) return;
      if (currentUniverse.length > 0 && !currentUniverse.includes(p.symbol.toUpperCase())) return;
      setRows((prev) => {
        // Dedupe by patternId or composite key.
        const key = p.patternId ?? `${p.symbol}:${p.pattern_name}:${p.detected_at}`;
        const exists = prev.find((r) => (r.patternId ?? `${r.symbol}:${r.pattern_name}:${r.detected_at}`) === key);
        if (exists) return prev;
        return [
          {
            symbol: p.symbol,
            timeframe: p.timeframe,
            pattern_name: p.pattern_name,
            direction: p.direction,
            confidence_score: p.confidence,
            grade: p.grade,
            risk_reward: p.rr,
            entry_price: p.entry,
            target_price: p.target,
            stop_price: p.stop,
            detected_at: new Date(p.detected_at).toISOString(),
            patternId: p.patternId,
            served_at_ms: Date.now(),
          },
          ...prev,
        ].slice(0, 200);
      });
    },
  });

  const filtered = useMemo(() => {
    return rows.filter((r) =>
      (direction === "all" || r.direction === direction) &&
      r.confidence_score >= minConfidence
    );
  }, [rows, direction, minConfidence]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      if (sortKey === "confidence") { av = a.confidence_score; bv = b.confidence_score; }
      else if (sortKey === "rr") { av = a.risk_reward ?? 0; bv = b.risk_reward ?? 0; }
      else if (sortKey === "age") { av = Date.parse(a.detected_at ?? "0"); bv = Date.parse(b.detected_at ?? "0"); }
      else if (sortKey === "symbol") { av = a.symbol; bv = b.symbol; }
      const cmp = typeof av === "string" ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  function clickHeader(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function ageString(detected_at?: string): string {
    if (!detected_at) return "—";
    const ts = Date.parse(detected_at);
    if (Number.isNaN(ts)) return "—";
    const sec = Math.max(0, (Date.now() - ts) / 1000);
    if (sec < 60) return `${sec.toFixed(0)}s ago`;
    if (sec < 3600) return `${(sec / 60).toFixed(0)}m ago`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)}h ago`;
    return `${(sec / 86400).toFixed(1)}d ago`;
  }

  function openChart(r: PatternScanRow) {
    nav(`/?symbol=${r.symbol}`);
  }

  function openPaperTrade(r: PatternScanRow) {
    const params = new URLSearchParams();
    params.set("symbol", r.symbol);
    params.set("action", r.direction === "bullish" ? "BUY" : r.direction === "bearish" ? "SELL" : "BUY");
    if (r.entry_price != null) params.set("entry", String(r.entry_price));
    if (r.target_price != null) params.set("target", String(r.target_price));
    if (r.stop_price != null) params.set("stop", String(r.stop_price));
    params.set("patternId", r.patternId ?? "");
    nav(`/paper?${params.toString()}`);
  }

  return (
    <div className="space-y-6">
      <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-5">
        <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Pattern scan filters</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 items-end">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-slate-500 mb-1 inline-block">Universe</span>
            <select value={universe} onChange={(e) => setUniverse(e.target.value as keyof typeof UNIVERSES)} className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm text-slate-200">
              {Object.keys(UNIVERSES).map((k) => (
                <option key={k} value={k}>{k}{k === "Watchlist" ? ` (${watchlistSymbols.length})` : ` (${UNIVERSES[k].length})`}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-slate-500 mb-1 inline-block">Timeframe</span>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as PatternTimeframe)} className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm text-slate-200">
              <option value="M5">M5</option>
              <option value="M15">M15</option>
              <option value="H1">H1</option>
              <option value="D1">D1</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-slate-500 mb-1 inline-block">Direction</span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as "all" | "bullish" | "bearish" | "continuation")} className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm text-slate-200">
              <option value="all">All</option>
              <option value="bullish">Bullish only</option>
              <option value="bearish">Bearish only</option>
              <option value="continuation">Continuation</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-slate-500 mb-1 inline-block">Min confidence · {minConfidence}%</span>
            <input type="range" min={50} max={95} value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))} className="w-full" />
          </label>
          <div className="flex flex-col gap-2">
            <button
              onClick={runScan}
              disabled={running}
              className="bg-accent-info text-white rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {running ? "Scanning…" : "Scan now"}
            </button>
            <label className="text-[11px] text-slate-400 flex items-center gap-2">
              <input type="checkbox" checked={autoScan} onChange={(e) => setAutoScan(e.target.checked)} />
              Auto-scan every 5 min
            </label>
          </div>
        </div>
        <div className="mt-3 text-[11px] text-slate-500 flex items-center justify-between">
          <span>
            Scanning {currentUniverse.length} symbols × {timeframe}
            {lastScanAt && <> · Last scan {new Date(lastScanAt).toLocaleTimeString()}</>}
          </span>
          {error && <span className="text-accent-sell">{error}</span>}
        </div>
      </section>

      <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            {sorted.length} match{sorted.length === 1 ? "" : "es"} above {minConfidence}% on {timeframe}
          </div>
          <div className="text-[11px] text-slate-500 font-mono">
            {sorted.length > 0 && <>Showing {sorted.length} of {rows.length} scanned</>}
          </div>
        </div>
        {sorted.length === 0 ? (
          <ScanRadar running={running} hasScanned={lastScanAt != null} />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-4 py-2 cursor-pointer hover:text-white" onClick={() => clickHeader("symbol")}>Symbol{sortKey === "symbol" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</th>
                <th className="text-left px-3 py-2">Pattern</th>
                <th className="text-left px-3 py-2">Dir</th>
                <th className="px-3 py-2 cursor-pointer hover:text-white text-right" onClick={() => clickHeader("confidence")}>Conf{sortKey === "confidence" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</th>
                <th className="text-center px-3 py-2">Grade</th>
                <th className="text-right px-3 py-2 cursor-pointer hover:text-white" onClick={() => clickHeader("rr")}>RR{sortKey === "rr" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</th>
                <th className="text-right px-3 py-2">Entry</th>
                <th className="text-right px-3 py-2">Target</th>
                <th className="text-right px-3 py-2">Stop</th>
                <th className="text-right px-3 py-2 cursor-pointer hover:text-white" onClick={() => clickHeader("age")}>Age{sortKey === "age" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</th>
                <th className="px-3 py-2 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              <AnimatePresence initial={false}>
                {sorted.map((r) => {
                  const dirBadge = r.direction === "bullish" ? { tone: "bg-accent-buy/15 text-accent-buy", emoji: "🟢" }
                    : r.direction === "bearish" ? { tone: "bg-accent-sell/15 text-accent-sell", emoji: "🔴" }
                    : { tone: "bg-amber-500/15 text-amber-400", emoji: "🟡" };
                  const barCls = r.confidence_score >= 80 ? "bg-accent-buy"
                    : r.confidence_score >= 65 ? "bg-amber-500"
                    : "bg-slate-500";
                  return (
                    <motion.tr
                      key={`${r.symbol}:${r.pattern_name}:${r.detected_at}:${r.timeframe}`}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                    >
                      <td className="px-4 py-2 font-mono text-white">{r.symbol}</td>
                      <td className="px-3 py-2 text-slate-200">{r.pattern_name}</td>
                      <td className="px-3 py-2">
                        <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold", dirBadge.tone)}>
                          {dirBadge.emoji} {r.direction.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="font-mono text-slate-200">{r.confidence_score}%</span>
                        </div>
                        <div className="mt-0.5 h-1 w-20 ml-auto bg-bg-border rounded">
                          <div className={clsx("h-full rounded", barCls)} style={{ width: `${r.confidence_score}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={clsx(
                          "px-1.5 py-0.5 rounded text-[10px] font-bold",
                          r.grade === "A+" ? "bg-emerald-500/20 text-emerald-300" :
                          r.grade === "A" ? "bg-emerald-500/15 text-emerald-400" :
                          r.grade === "B" ? "bg-amber-500/15 text-amber-400" :
                          "bg-slate-500/15 text-slate-400"
                        )}>{r.grade}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-300">
                        {r.risk_reward != null ? r.risk_reward.toFixed(2) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-300">
                        {r.entry_price != null ? r.entry_price.toFixed(2) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-accent-buy">
                        {r.target_price != null ? r.target_price.toFixed(2) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-accent-sell">
                        {r.stop_price != null ? r.stop_price.toFixed(2) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-[11px] text-slate-500">
                        {ageString(r.detected_at)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex gap-1 justify-center">
                          <button
                            onClick={() => openChart(r)}
                            className="text-[10px] border border-bg-border rounded px-2 py-0.5 text-slate-300 hover:text-white"
                          >
                            Chart
                          </button>
                          <button
                            onClick={() => openPaperTrade(r)}
                            className="text-[10px] border border-bg-border rounded px-2 py-0.5 text-accent-info hover:text-white"
                          >
                            Paper
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function ScanRadar({ running, hasScanned }: { running: boolean; hasScanned: boolean }) {
  return (
    <div className="px-5 py-12 flex flex-col items-center justify-center text-center">
      <div className="relative h-24 w-24 mb-4">
        <div className={clsx(
          "absolute inset-0 rounded-full border-2 border-accent-info/30",
          running && "animate-ping"
        )} />
        <div className="absolute inset-2 rounded-full border-2 border-accent-info/20" />
        <div className="absolute inset-4 rounded-full border-2 border-accent-info/10" />
        <div className={clsx(
          "absolute inset-0 rounded-full border-t-2 border-accent-info",
          running ? "animate-spin" : ""
        )} />
      </div>
      <div className="text-sm text-slate-300">
        {running ? "Sweeping the universe…" : hasScanned ? "No patterns above the threshold." : "Click Scan now to begin."}
      </div>
      <div className="text-xs text-slate-500 mt-1">
        {running ? "Each symbol takes ~1s; large universes are chunked into 50-symbol batches." : "Try lowering min confidence, switching timeframe, or expanding the universe."}
      </div>
    </div>
  );
}
