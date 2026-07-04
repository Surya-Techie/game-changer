import { useEffect, useState } from "react";
import clsx from "clsx";
import { Brain, RefreshCw, TrendingUp, TrendingDown, Activity, AlertTriangle } from "lucide-react";
import {
  fetchChanRecommendation,
  type ChanRecommendation,
} from "../lib/chanAdvisorApi";

interface Props {
  symbol: string;
}

const BAND_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  CALM:     { label: "Calm",     color: "text-accent-buy",  bg: "bg-accent-buy/10" },
  NORMAL:   { label: "Normal",   color: "text-slate-200",   bg: "bg-slate-700/20" },
  ELEVATED: { label: "Elevated", color: "text-amber-400",   bg: "bg-amber-500/10" },
  CRISIS:   { label: "Crisis",   color: "text-accent-sell", bg: "bg-accent-sell/10" },
};

const TREND_ICONS: Record<string, React.ReactNode> = {
  UP:    <TrendingUp   className="h-3.5 w-3.5 text-accent-buy" />,
  DOWN:  <TrendingDown className="h-3.5 w-3.5 text-accent-sell" />,
  RANGE: <Activity     className="h-3.5 w-3.5 text-slate-400" />,
};

export default function ChanAdvisorCard({ symbol }: Props) {
  const [data, setData] = useState<ChanRecommendation | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    if (!symbol) return;
    setLoading(true);
    setErr(null);
    const r = await fetchChanRecommendation(symbol);
    if (r && "error" in r) {
      setErr(
        r.error === "no_data"
          ? `No price history for ${symbol} on Yahoo Finance — the ticker may be renamed (e.g. ZOMATO → ETERNAL) or delisted. Try searching by company name.`
          : "Chan advisor unavailable. Restart ai-service."
      );
      setData(null);
    } else {
      setData(r);
    }
    setLoading(false);
  };

  // Debounce + minimum-length gate. Parent components pass `symbol`
  // bound to a search input, so every keystroke used to fire a request
  // and produce 404s for partial tickers (W, WI, WIP, ...). We now:
  //   1) Wait 350 ms after the symbol stops changing.
  //   2) Skip anything shorter than 3 characters (NSE tickers are 3+).
  //   3) Cancel pending fetches when the symbol changes again.
  useEffect(() => {
    if (!symbol || symbol.length < 3) {
      setData(null);
      setErr(null);
      return;
    }
    const handle = window.setTimeout(() => { void load(); }, 350);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const band = data?.regime.band ?? "NORMAL";
  const bandStyle = BAND_STYLES[band];

  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500/40 to-cyan-500/40 flex items-center justify-center">
            <Brain className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Chan Advisor</div>
            <div className="text-sm font-mono text-slate-200">
              {symbol || "—"} · strategy fit engine
            </div>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-slate-500 hover:text-slate-200 disabled:opacity-30 transition-colors"
        >
          <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {err && <div className="text-xs text-accent-sell">{err}</div>}

      {data && (
        <>
          {/* Regime band */}
          <div className={clsx("rounded-lg p-3", bandStyle.bg)}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Regime</span>
              <span className={clsx("text-xs font-bold uppercase tracking-wider", bandStyle.color)}>
                {bandStyle.label}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-[10px]">
              <Stat label="Vol" value={`${data.regime.realized_vol_pct.toFixed(1)}%`} />
              <Stat label="ADX" value={data.regime.adx_14.toFixed(1)} />
              <Stat label="Hurst" value={data.regime.hurst.toFixed(2)} />
              <Stat label="Trend" value={<span className="flex items-center justify-center gap-0.5">{TREND_ICONS[data.regime.trend]}{data.regime.trend}</span>} />
            </div>
            <div className="mt-2 text-[10px] text-slate-400">
              Style preference: <span className="text-slate-200 font-mono">{data.regime.favored_style}</span>
              {" · "}leverage cap: <span className="text-slate-200 font-mono">{Math.round(data.regime.leverage_haircut * 100)}%</span>
              {data.regime.is_stationary
                ? <> · <span className="text-accent-buy">stationary</span> ✓</>
                : <> · <span className="text-amber-400">non-stationary</span> (avoid pure MR)</>}
            </div>
          </div>

          {/* Primary recommendation */}
          <div className="border border-bg-border rounded-lg p-3 bg-bg-elevated/30">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Recommended strategy</span>
              <span className="text-[10px] font-mono text-emerald-400">fit {data.primary.fit_score}/100</span>
            </div>
            <div className="text-sm font-bold text-white">{data.primary.title}</div>
            <div className="text-[10px] font-mono text-slate-400 mt-0.5">
              {data.primary.code} · {data.primary.category.replace("_", " ").toLowerCase()}
            </div>
            <div className="mt-2 text-[11px] text-slate-300 leading-relaxed">
              <span className="text-slate-500">Signal: </span>{data.primary.signal}
            </div>
            <div className="mt-1.5 text-[10px] text-slate-400 leading-relaxed">
              <span className="text-slate-500">Risk: </span>{data.primary.risk_block}
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <Stat label="60d Sharpe" value={data.sharpe_60d.toFixed(2)} accent={data.sharpe_60d > 1 ? "buy" : data.sharpe_60d < 0 ? "sell" : null} />
            <Stat label="Half-Kelly" value={data.kelly_half.toFixed(2)} />
            <Stat label="Yrs for sig" value={Number.isFinite(data.years_for_significance) ? data.years_for_significance.toFixed(1) : "∞"} />
          </div>

          {/* Alternates */}
          {data.alternates.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Alternates</div>
              <div className="space-y-1">
                {data.alternates.map((a) => (
                  <div key={a.code} className="flex items-center justify-between text-[10px] px-2 py-1 rounded bg-bg-elevated/20 border border-bg-border/40">
                    <span className="text-slate-300 truncate">
                      <span className="font-mono text-slate-500">{a.code}</span> {a.title}
                    </span>
                    <span className="font-mono text-slate-400 shrink-0 ml-2">{a.fit_score}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Emotional check */}
          <div className="border-l-2 border-amber-500/60 pl-2.5 py-1 bg-amber-500/5 rounded-r">
            <div className="flex items-center gap-1.5 mb-0.5">
              <AlertTriangle className="h-3 w-3 text-amber-400" />
              <span className="text-[9px] uppercase tracking-wider text-amber-400 font-bold">Emotional check</span>
            </div>
            <p className="text-[10px] text-slate-300 leading-snug">{data.emotional_check}</p>
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: "buy" | "sell" | null }) {
  return (
    <div className="bg-bg-elevated/40 rounded p-1.5 text-center">
      <div className="text-[9px] uppercase text-slate-500 tracking-wider">{label}</div>
      <div className={clsx(
        "text-xs font-mono tabular-nums mt-0.5",
        accent === "buy"  && "text-accent-buy",
        accent === "sell" && "text-accent-sell",
        !accent           && "text-slate-200",
      )}>{value}</div>
    </div>
  );
}
