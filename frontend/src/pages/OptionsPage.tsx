import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import { optionsApi, type OptionsChain, type StrikeRow, type StrikeSide } from "../lib/optionsApi";

const UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL",
  "MARUTI", "KOTAKBANK", "BAJFINANCE", "HCLTECH", "WIPRO", "ASIANPAINT", "NESTLEIND", "TITAN", "ADANIENT", "SUNPHARMA",
];

export default function OptionsPage() {
  const [symbol, setSymbol] = useState<string>("RELIANCE");
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [activeExpiry, setActiveExpiry] = useState<string>("");
  const [selected, setSelected] = useState<{ strike: number; kind: "CE" | "PE" } | null>(null);
  const [itmOnly, setItmOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(sym: string) {
    setLoading(true);
    setError(null);
    try {
      const c = await optionsApi.chain(sym);
      setChain(c);
      if (!c.expiries.find((e) => e.expiry === activeExpiry)) {
        setActiveExpiry(c.expiries[0]?.expiry ?? "");
      }
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string; detail?: string } } })?.response?.data?.detail
        ?? (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? (e as Error).message;
      setError(typeof msg === "string" ? msg : "Failed to load options chain");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const expiry = useMemo(
    () => chain?.expiries.find((e) => e.expiry === activeExpiry) ?? null,
    [chain, activeExpiry]
  );

  const visibleRows = useMemo(() => {
    if (!expiry || !chain) return [];
    if (!itmOnly) return expiry.rows;
    return expiry.rows.filter((r) => {
      // ITM CE: strike < underlying. ITM PE: strike > underlying.
      return (
        (r.ce != null && r.strike < chain.underlying) ||
        (r.pe != null && r.strike > chain.underlying)
      );
    });
  }, [expiry, chain, itmOnly]);

  const maxOi = useMemo(() => {
    if (!expiry) return 1;
    let m = 1;
    for (const r of expiry.rows) {
      m = Math.max(m, r.ce?.oi ?? 0, r.pe?.oi ?? 0);
    }
    return m;
  }, [expiry]);

  return (
    <div className="min-h-screen flex flex-col bg-app-radial text-slate-200">
      <Topbar symbol={symbol} wsStatus="open" />
      <div className="flex-1 flex">
        <Sidebar symbols={[]} prices={{}} prevPrices={{}} active="" onSelect={() => {}} />
        <main className="flex-1 p-4 space-y-3 min-w-0">
          {/* Header row */}
          <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-3 flex flex-wrap items-center gap-3">
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="bg-bg-elevated border border-bg-border rounded-md px-2 py-1 text-sm text-white font-mono"
            >
              {UNIVERSE.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <div className="text-sm font-mono">
              <span className="text-slate-500 text-xs uppercase mr-1">Underlying</span>
              <span className="text-white">₹{chain?.underlying.toFixed(2) ?? "—"}</span>
            </div>
            {chain?.expiries.length ? (
              <div className="flex gap-1">
                {chain.expiries.map((e) => (
                  <button
                    key={e.expiry}
                    onClick={() => setActiveExpiry(e.expiry)}
                    className={clsx(
                      "text-xs px-2 py-1 rounded border",
                      e.expiry === activeExpiry
                        ? "border-accent-info bg-accent-info/20 text-white"
                        : "border-bg-border text-slate-400 hover:text-white"
                    )}
                  >
                    {e.expiry} <span className="text-slate-500">({e.days_to_expiry}d)</span>
                  </button>
                ))}
              </div>
            ) : null}
            <label className="flex items-center gap-1 text-xs text-slate-400 ml-auto">
              <input type="checkbox" checked={itmOnly} onChange={(e) => setItmOnly(e.target.checked)} />
              Show ITM only
            </label>
          </div>

          {error && <div className="text-rose-400 text-sm">{error}</div>}
          {loading && <div className="text-slate-500 text-sm">Loading options chain…</div>}

          {expiry && chain && (
            <>
              {/* PCR + Max Pain + IV summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SummaryCard label="Put / Call Ratio (OI)" value={expiry.pcr.toFixed(2)}
                  hint={expiry.pcr > 1 ? "Put-heavy → bearish bias" : "Call-heavy → bullish bias"} />
                <SummaryCard label="Max Pain" value={expiry.max_pain ? `₹${expiry.max_pain.toFixed(0)}` : "—"}
                  hint="Strike where option writers lose least at expiry" />
                <SummaryCard label="Avg IV" value={expiry.iv_avg != null ? `${(expiry.iv_avg * 100).toFixed(1)}%` : "—"} />
                <SummaryCard label="Unusual OI strikes"
                  value={expiry.unusual_oi_strikes.length > 0 ? expiry.unusual_oi_strikes.length.toString() : "0"}
                  hint={expiry.unusual_oi_strikes.length > 0 ? `at ₹${expiry.unusual_oi_strikes.slice(0, 5).map(s => s.toFixed(0)).join(", ")}` : "no spikes"} />
              </div>

              {/* Mini price scale with max-pain marker */}
              <MiniPriceScale chain={chain} expiry={expiry} />

              <div className="grid grid-cols-12 gap-3">
                <div className="col-span-12 lg:col-span-8 bg-bg-panel-solid/60 border border-bg-border rounded-xl overflow-hidden">
                  <ChainTable
                    rows={visibleRows}
                    underlying={chain.underlying}
                    maxOi={maxOi}
                    unusual={new Set(expiry.unusual_oi_strikes)}
                    onSelect={(strike, kind) => setSelected({ strike, kind })}
                    selected={selected}
                  />
                </div>
                <div className="col-span-12 lg:col-span-4">
                  <GreeksPanel symbol={symbol} expiry={expiry.expiry} selected={selected} />
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-lg font-mono text-white">{value}</div>
      {hint && <div className="text-[10px] text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}

function MiniPriceScale({ chain, expiry }: { chain: OptionsChain; expiry: { rows: StrikeRow[]; max_pain: number | null } }) {
  const strikes = expiry.rows.map((r) => r.strike);
  if (strikes.length === 0) return null;
  const lo = Math.min(...strikes);
  const hi = Math.max(...strikes);
  const range = hi - lo || 1;
  const pos = (val: number) => ((val - lo) / range) * 100;
  return (
    <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-3">
      <div className="text-[10px] uppercase text-slate-500 mb-1">Strike scale</div>
      <div className="relative h-8 bg-bg-elevated/30 rounded">
        <div className="absolute top-0 bottom-0 w-px bg-emerald-400" style={{ left: `${pos(chain.underlying)}%` }} title="Underlying" />
        {expiry.max_pain != null && (
          <div className="absolute top-0 bottom-0 w-px bg-amber-400" style={{ left: `${pos(expiry.max_pain)}%` }} title="Max pain" />
        )}
        <div className="absolute -top-4 left-0 text-[10px] text-slate-500 font-mono">₹{lo.toFixed(0)}</div>
        <div className="absolute -top-4 right-0 text-[10px] text-slate-500 font-mono">₹{hi.toFixed(0)}</div>
      </div>
      <div className="flex gap-3 text-[10px] mt-1">
        <span className="flex items-center gap-1"><span className="w-2 h-2 bg-emerald-400 inline-block" /> Underlying ₹{chain.underlying.toFixed(2)}</span>
        {expiry.max_pain != null && <span className="flex items-center gap-1"><span className="w-2 h-2 bg-amber-400 inline-block" /> Max pain ₹{expiry.max_pain.toFixed(0)}</span>}
      </div>
    </div>
  );
}

function ChainTable({
  rows, underlying, maxOi, unusual, onSelect, selected,
}: {
  rows: StrikeRow[];
  underlying: number;
  maxOi: number;
  unusual: Set<number>;
  onSelect: (strike: number, kind: "CE" | "PE") => void;
  selected: { strike: number; kind: "CE" | "PE" } | null;
}) {
  return (
    <div className="overflow-auto max-h-[64vh]">
      <table className="w-full text-xs font-mono">
        <thead className="text-[10px] uppercase text-slate-500 bg-bg-elevated/40 sticky top-0">
          <tr>
            <th className="px-2 py-2 text-left">CE OI</th>
            <th className="px-2 py-2 text-right">CE LTP</th>
            <th className="px-2 py-2 text-right">CE IV</th>
            <th className="px-2 py-2 text-right">CE Δ</th>
            <th className="px-2 py-2 text-center">Strike</th>
            <th className="px-2 py-2 text-left">PE Δ</th>
            <th className="px-2 py-2 text-left">PE IV</th>
            <th className="px-2 py-2 text-left">PE LTP</th>
            <th className="px-2 py-2 text-right">PE OI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isAtm = Math.abs(r.strike - underlying) < (underlying * 0.005);
            const ceItm = r.strike < underlying;
            const peItm = r.strike > underlying;
            return (
              <tr
                key={r.strike}
                className={clsx(
                  "border-t border-bg-border",
                  isAtm && "bg-amber-500/10"
                )}
              >
                <SideCell side={r.ce} maxOi={maxOi} kind="CE" unusual={unusual.has(r.strike)}
                  selected={selected?.strike === r.strike && selected?.kind === "CE"}
                  onClick={() => r.ce && onSelect(r.strike, "CE")}
                  itm={ceItm}
                />
                <td className={clsx("px-2 py-1.5 text-center font-semibold", ceItm ? "text-emerald-300" : peItm ? "text-rose-300" : "text-white")}>
                  {r.strike.toFixed(0)}
                </td>
                <SideCell side={r.pe} maxOi={maxOi} kind="PE" unusual={unusual.has(r.strike)}
                  selected={selected?.strike === r.strike && selected?.kind === "PE"}
                  onClick={() => r.pe && onSelect(r.strike, "PE")}
                  itm={peItm}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SideCell({
  side, maxOi, kind, unusual, selected, onClick, itm,
}: {
  side: StrikeSide | undefined;
  maxOi: number;
  kind: "CE" | "PE";
  unusual: boolean;
  selected: boolean;
  onClick: () => void;
  itm: boolean;
}) {
  if (!side) {
    if (kind === "CE") {
      return (
        <>
          <td className="px-2 py-1.5 text-slate-600">—</td>
          <td className="px-2 py-1.5 text-right text-slate-600">—</td>
          <td className="px-2 py-1.5 text-right text-slate-600">—</td>
          <td className="px-2 py-1.5 text-right text-slate-600">—</td>
        </>
      );
    }
    return (
      <>
        <td className="px-2 py-1.5 text-slate-600">—</td>
        <td className="px-2 py-1.5 text-slate-600">—</td>
        <td className="px-2 py-1.5 text-slate-600">—</td>
        <td className="px-2 py-1.5 text-right text-slate-600">—</td>
      </>
    );
  }
  const oiRatio = side.oi / maxOi;
  const bgColor = kind === "CE" ? "rgba(22,199,132,0.18)" : "rgba(234,57,67,0.18)";

  if (kind === "CE") {
    return (
      <>
        <td onClick={onClick} className={clsx("px-2 py-1.5 cursor-pointer relative", selected && "ring-1 ring-accent-info ring-inset", itm && "bg-emerald-500/5")}>
          <div className="absolute right-0 top-0 bottom-0" style={{ width: `${oiRatio * 100}%`, background: bgColor }} />
          <span className="relative">{Math.round(side.oi).toLocaleString("en-IN")}</span>
          {unusual && <span className="ml-1 text-[9px] text-amber-300">⚡</span>}
        </td>
        <td onClick={onClick} className={clsx("px-2 py-1.5 text-right cursor-pointer", selected && "ring-1 ring-accent-info ring-inset")}>{side.ltp.toFixed(2)}</td>
        <td onClick={onClick} className={clsx("px-2 py-1.5 text-right text-slate-400 cursor-pointer")}>{(side.iv * 100).toFixed(1)}%</td>
        <td onClick={onClick} className={clsx("px-2 py-1.5 text-right text-slate-400 cursor-pointer")}>{side.delta.toFixed(2)}</td>
      </>
    );
  }
  return (
    <>
      <td onClick={onClick} className={clsx("px-2 py-1.5 text-slate-400 cursor-pointer")}>{side.delta.toFixed(2)}</td>
      <td onClick={onClick} className={clsx("px-2 py-1.5 text-slate-400 cursor-pointer")}>{(side.iv * 100).toFixed(1)}%</td>
      <td onClick={onClick} className={clsx("px-2 py-1.5 cursor-pointer")}>{side.ltp.toFixed(2)}</td>
      <td onClick={onClick} className={clsx("px-2 py-1.5 text-right cursor-pointer relative", selected && "ring-1 ring-accent-info ring-inset", itm && "bg-rose-500/5")}>
        <div className="absolute left-0 top-0 bottom-0" style={{ width: `${oiRatio * 100}%`, background: bgColor }} />
        <span className="relative">{Math.round(side.oi).toLocaleString("en-IN")}</span>
        {unusual && <span className="ml-1 text-[9px] text-amber-300">⚡</span>}
      </td>
    </>
  );
}

function GreeksPanel({
  symbol, expiry, selected,
}: {
  symbol: string;
  expiry: string;
  selected: { strike: number; kind: "CE" | "PE" } | null;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof optionsApi.greeks>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setErr(null);
    if (!selected) return;
    optionsApi.greeks(symbol, expiry, selected.strike, selected.kind)
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, [symbol, expiry, selected]);

  if (!selected) {
    return (
      <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-4 text-sm text-slate-400 h-full">
        Click a strike row's CE or PE side to view its Greeks and IV percentile.
      </div>
    );
  }
  return (
    <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-white font-semibold">
          {selected.kind === "CE" ? "Call" : "Put"} ₹{selected.strike.toFixed(0)}
        </div>
        <div className="text-[10px] text-slate-500">{expiry}</div>
      </div>
      {err && <div className="text-xs text-rose-400">{err}</div>}
      {!data && !err && <div className="text-xs text-slate-500">Computing Greeks…</div>}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
            <Stat label="LTP" value={`₹${data.price.toFixed(2)}`} />
            <Stat label="IV" value={data.iv != null ? `${(data.iv * 100).toFixed(1)}%` : "—"} />
            <Stat label="Delta" value={data.greeks.delta.toFixed(4)} />
            <Stat label="Gamma" value={data.greeks.gamma.toFixed(6)} />
            <Stat label="Theta/day" value={data.greeks.theta.toFixed(2)} />
            <Stat label="Vega/1%" value={data.greeks.vega.toFixed(2)} />
            <Stat label="Rho/1%" value={data.greeks.rho.toFixed(2)} />
            <Stat label="Underlying" value={`₹${data.underlying.toFixed(2)}`} />
          </div>
          {data.iv_percentile != null && (
            <div className="text-xs pt-2 border-t border-bg-border">
              <div className="text-slate-500">IV percentile (vs other strikes this expiry)</div>
              <div className="text-white font-mono">{data.iv_percentile.toFixed(0)}%</div>
              <div className="h-1 bg-bg-elevated rounded mt-1 overflow-hidden">
                <div className="h-full bg-accent-info" style={{ width: `${data.iv_percentile}%` }} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-elevated/40 border border-bg-border rounded p-2">
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className="text-white">{value}</div>
    </div>
  );
}
