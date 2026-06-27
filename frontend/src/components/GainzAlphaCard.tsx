import { useEffect, useState } from "react";
import clsx from "clsx";
import { Sparkles, AlertTriangle, RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import {
  fetchGainzAlphaScore,
  type GainzAlphaResponse,
} from "../lib/gainzAlphaApi";

interface Props {
  symbol: string;
  capital?: number;   // INR; enables full position-sizing block
}

const SIGNAL_STYLES: Record<string, { label: string; color: string; bg: string; border: string; icon: React.ReactNode }> = {
  STRONG_BUY:  { label: "Strong Buy",  color: "text-accent-buy",  bg: "bg-accent-buy/15",  border: "border-accent-buy/40",  icon: <TrendingUp className="h-4 w-4" /> },
  BUY:         { label: "Buy",          color: "text-accent-buy",  bg: "bg-accent-buy/10",  border: "border-accent-buy/30",  icon: <TrendingUp className="h-4 w-4" /> },
  NEUTRAL:     { label: "Neutral",      color: "text-slate-300",   bg: "bg-slate-700/20",   border: "border-slate-700/40",   icon: <Minus className="h-4 w-4" /> },
  SELL:        { label: "Sell",         color: "text-accent-sell", bg: "bg-accent-sell/10", border: "border-accent-sell/30", icon: <TrendingDown className="h-4 w-4" /> },
  STRONG_SELL: { label: "Strong Sell",  color: "text-accent-sell", bg: "bg-accent-sell/15", border: "border-accent-sell/40", icon: <TrendingDown className="h-4 w-4" /> },
  NO_TRADE:    { label: "No Trade",     color: "text-amber-400",   bg: "bg-amber-500/10",   border: "border-amber-500/40",   icon: <AlertTriangle className="h-4 w-4" /> },
  NO_PATTERN:  { label: "No Pattern",   color: "text-slate-500",   bg: "bg-slate-800/40",   border: "border-slate-700/40",   icon: <Minus className="h-4 w-4" /> },
};

export default function GainzAlphaCard({ symbol, capital }: Props) {
  const [data, setData] = useState<GainzAlphaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    if (!symbol) return;
    setLoading(true);
    setErr(null);
    const r = await fetchGainzAlphaScore(symbol, capital);
    if (!r) setErr("Gainz Alpha unavailable. Restart ai-service.");
    setData(r);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [symbol]);

  const sig = data?.signal ?? "NO_PATTERN";
  const style = SIGNAL_STYLES[sig] ?? SIGNAL_STYLES.NEUTRAL;
  const components = data?.component_scores;
  const weights = data?.weights ?? {};

  return (
    <section className={clsx(
      "bg-bg-panel-solid/70 backdrop-blur-glass border rounded-xl p-4 space-y-3 transition-colors",
      style.border,
    )}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-purple-500/40 to-blue-500/40 flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Gainz Alpha</div>
            <div className="text-sm font-mono text-slate-200">{symbol || "—"}</div>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-slate-500 hover:text-slate-200 disabled:opacity-30 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {err && <div className="text-xs text-accent-sell">{err}</div>}

      {/* Signal + score */}
      <div className={clsx("rounded-lg p-3", style.bg)}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className={clsx("flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider", style.color)}>
              {style.icon}
              {style.label}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              {data?.pattern_detected
                ? <>Pattern: <span className="text-slate-200 font-mono">{data.pattern_detected}</span></>
                : (data?.note || "—")}
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-black tabular-nums text-white leading-none">
              {data ? data.gainz_alpha_score.toFixed(0) : "—"}
            </div>
            <div className="text-[9px] uppercase tracking-wider text-slate-500 mt-0.5">Alpha</div>
          </div>
        </div>

        {/* Reject reasons (NO_TRADE) */}
        {data?.reject_reasons && data.reject_reasons.length > 0 && (
          <div className="mt-2 text-[10px] text-amber-300 leading-snug">
            Brandt filter rejected:&nbsp;
            {data.reject_reasons.map((r) => r.replace(/_/g, " ")).join(" · ")}
          </div>
        )}

        {/* Brandt bonuses */}
        {data?.brandt_bonuses_applied && data.brandt_bonuses_applied.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {data.brandt_bonuses_applied.map((b) => (
              <span key={b} className="text-[9px] px-1.5 py-0.5 rounded bg-bg-elevated/60 text-slate-300 font-mono">
                +{b.replace(/_bonus$/, "").replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Component scores */}
      {components && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Model breakdown</div>
          {[
            { key: "brandt_pattern",          label: "Brandt classical",   w: weights.brandt_pattern },
            { key: "model_1_rsi_macd",        label: "RSI · MACD · ADX",    w: weights.model_1_rsi_macd },
            { key: "model_2_sentiment_volume", label: "Volume · sentiment",  w: weights.model_2_sentiment_volume },
            { key: "model_3_momentum",        label: "Price-action momentum", w: weights.model_3_momentum },
          ].map(({ key, label, w }) => {
            const val = components[key as keyof typeof components];
            const offline = val == null;
            const wpct = Math.round((w ?? 0) * 100);
            return (
              <div key={key} className="flex items-center gap-2">
                <div className="w-32 text-[10px] text-slate-400 truncate">{label}</div>
                <div className="flex-1 h-1.5 bg-slate-800/60 rounded overflow-hidden">
                  <div
                    className={clsx(
                      "h-full transition-all",
                      offline ? "bg-slate-700" :
                      (val as number) >= 60 ? "bg-accent-buy" :
                      (val as number) <= 40 ? "bg-accent-sell" : "bg-slate-500"
                    )}
                    style={{ width: `${offline ? 0 : Math.max(0, Math.min(100, val as number))}%` }}
                  />
                </div>
                <div className="w-10 text-[10px] font-mono text-slate-300 text-right tabular-nums">
                  {offline ? "—" : (val as number).toFixed(0)}
                </div>
                <div className="w-8 text-[9px] text-slate-500 text-right">{wpct}%</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Risk block */}
      {data?.risk_management && data.signal !== "NO_PATTERN" && data.signal !== "NO_TRADE" && (
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-bg-border">
          <div>
            <div className="text-[9px] uppercase text-slate-500">Stop</div>
            <div className="text-xs font-mono text-accent-sell tabular-nums">
              {data.risk_management.stop_loss_pct != null ? `${data.risk_management.stop_loss_pct.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-slate-500">Target</div>
            <div className="text-xs font-mono text-accent-buy tabular-nums">
              {data.risk_management.target_pct != null ? `${data.risk_management.target_pct.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-slate-500">R:R</div>
            <div className="text-xs font-mono text-slate-200 tabular-nums">
              {data.risk_management.reward_risk != null ? data.risk_management.reward_risk.toFixed(2) : "—"}
            </div>
          </div>
          {data.risk_management.position_sizing?.note && (
            <div className="col-span-3 text-[9px] text-slate-400 leading-snug pt-1">
              {data.risk_management.position_sizing.note}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
