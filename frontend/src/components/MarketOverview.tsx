import { useEffect, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api } from "../lib/api";

interface MarketOverview {
  ts: number;
  real: {
    adRatio: number;
    advancers: number;
    decliners: number;
    breadthPct: number;
    symbolsEvaluated: number;
    niftyProxy: number | null;
    niftyProxyChangePct: number | null;
  };
  synthetic: {
    source: "mock";
    note: string;
    indiaVix: number;
    indiaVixZone: "calm" | "caution" | "fear";
    pcr: number;
    pcrInterpretation: string;
    fiiNetCr: number;
    diiNetCr: number;
    bankNiftyChangePct: number;
    sensexChangePct: number;
    sgxNiftyChangePct: number;
  };
  sectors: Array<{ name: string; changePct: number }>;
}

export default function MarketOverviewPanel() {
  const [data, setData] = useState<MarketOverview | null>(null);

  useEffect(() => {
    const load = () => api.get("/api/market-overview").then(({ data }) => setData(data as MarketOverview)).catch(() => {});
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!data) return <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4 text-slate-400 text-sm">Loading market…</div>;

  const vixTone = data.synthetic.indiaVixZone === "calm" ? "text-accent-buy" : data.synthetic.indiaVixZone === "fear" ? "text-accent-sell" : "text-accent-hold";
  const niftyUp = (data.real.niftyProxyChangePct ?? 0) >= 0;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm uppercase tracking-wider text-slate-500">Market Overview</div>
        <div className="text-[10px] text-slate-500" title={data.synthetic.note}>Mock indices · live A/D</div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-xs">
        <Cell label="A/D ratio" value={data.real.adRatio.toFixed(2)} sub={`${data.real.advancers}/${data.real.decliners}`} tone={data.real.adRatio >= 1 ? "buy" : "sell"} real />
        <Cell label="Breadth >20EMA" value={`${data.real.breadthPct.toFixed(0)}%`} sub={`of ${data.real.symbolsEvaluated}`} tone={data.real.breadthPct >= 50 ? "buy" : "sell"} real />
        <Cell label="Nifty proxy" value={data.real.niftyProxy != null ? data.real.niftyProxy.toFixed(2) : "—"} sub={data.real.niftyProxyChangePct != null ? `${niftyUp ? "+" : ""}${data.real.niftyProxyChangePct.toFixed(2)}%` : ""} tone={niftyUp ? "buy" : "sell"} real />
        <Cell label="India VIX" value={data.synthetic.indiaVix.toFixed(1)} sub={data.synthetic.indiaVixZone} tone={vixTone === "text-accent-buy" ? "buy" : vixTone === "text-accent-sell" ? "sell" : undefined} mock />
        <Cell label="PCR" value={data.synthetic.pcr.toFixed(2)} sub={data.synthetic.pcrInterpretation.split(" ")[0]} mock />
        <Cell label="FII net (₹cr)" value={data.synthetic.fiiNetCr.toFixed(0)} sub={`DII ${data.synthetic.diiNetCr.toFixed(0)}`} tone={data.synthetic.fiiNetCr >= 0 ? "buy" : "sell"} mock />
        <Cell label="Bank Nifty" value={`${data.synthetic.bankNiftyChangePct >= 0 ? "+" : ""}${data.synthetic.bankNiftyChangePct.toFixed(2)}%`} tone={data.synthetic.bankNiftyChangePct >= 0 ? "buy" : "sell"} mock />
        <Cell label="Sensex" value={`${data.synthetic.sensexChangePct >= 0 ? "+" : ""}${data.synthetic.sensexChangePct.toFixed(2)}%`} tone={data.synthetic.sensexChangePct >= 0 ? "buy" : "sell"} mock />
        <Cell label="SGX Nifty" value={`${data.synthetic.sgxNiftyChangePct >= 0 ? "+" : ""}${data.synthetic.sgxNiftyChangePct.toFixed(2)}%`} tone={data.synthetic.sgxNiftyChangePct >= 0 ? "buy" : "sell"} mock />
      </div>

      <div className="mt-3 pt-3 border-t border-bg-border">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Sector performance <span className="text-slate-600">(mock)</span></div>
        <div className="grid grid-cols-7 gap-2">
          {data.sectors.map((s) => {
            const up = s.changePct >= 0;
            const intensity = Math.min(1, Math.abs(s.changePct) / 2);
            const bg = up
              ? `rgba(22,199,132,${0.1 + intensity * 0.4})`
              : `rgba(234,57,67,${0.1 + intensity * 0.4})`;
            return (
              <div key={s.name} className="rounded p-2 text-center" style={{ background: bg }}>
                <div className="text-[10px] text-slate-300">{s.name}</div>
                <div className={clsx("text-xs font-mono font-semibold", up ? "text-accent-buy" : "text-accent-sell")}>
                  {up ? "+" : ""}{s.changePct.toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

function Cell({ label, value, sub, tone, real, mock }: { label: string; value: string; sub?: string; tone?: "buy" | "sell"; real?: boolean; mock?: boolean }) {
  const cls = tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-white";
  return (
    <div className="bg-bg-elevated/40 rounded-lg px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
        {label}
        {real && <span className="bg-accent-buy/20 text-accent-buy text-[8px] px-1 rounded">LIVE</span>}
        {mock && <span className="bg-slate-500/20 text-slate-400 text-[8px] px-1 rounded">MOCK</span>}
      </div>
      <div className={clsx("text-sm font-mono tabular-nums", cls)}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}
