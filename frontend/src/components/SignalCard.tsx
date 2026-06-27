import clsx from "clsx";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

export interface Signal {
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  price: number;
  reason?: string;
  indicators?: Record<string, number | string>;
  suggestedEntry?: number;
  suggestedStop?: number;
  suggestedTarget?: number;
  createdAt?: string;
  // Phase 11 Layer 6 — pattern confirmation attached by signalEngine.
  pattern_confirmation?: {
    pattern_name: string;
    grade?: string;
    direction?: "bullish" | "bearish" | "continuation" | "neutral";
    confidence?: number;
    timeframe?: string;
    agrees?: boolean;
    delta?: number;
  } | null;
}

interface AccuracyBucket {
  symbol: string;
  wins: number;
  losses: number;
  pending: number;
  expired: number;
  total: number;
  hitRate: number | null;
}

interface AccuracyResponse {
  overall: AccuracyBucket;
  perSymbol: AccuracyBucket[];
}

function useAccuracy(symbol: string | undefined) {
  const [data, setData] = useState<AccuracyResponse | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let aborted = false;
    const load = async () => {
      try {
        const res = await api.get<AccuracyResponse>("/api/signals/accuracy", { params: { limit: 500 } });
        if (!aborted) setData(res.data);
      } catch {
        /* keep previous */
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      aborted = true;
      clearInterval(t);
    };
  }, [symbol]);
  return data;
}

export default function SignalCard({ signal }: { signal?: Signal }) {
  const accuracy = useAccuracy(signal?.symbol);

  if (!signal) {
    return (
      <div className="bg-bg-panel border border-bg-border rounded-2xl p-4">
        <div className="text-xs uppercase tracking-wider text-slate-500 mb-1.5">AI Signal</div>
        <div className="text-slate-400 text-sm">Warming up — waiting for the model to evaluate this symbol.</div>
      </div>
    );
  }

  const colors = {
    BUY: "bg-accent-buy/15 text-accent-buy border-accent-buy/40",
    SELL: "bg-accent-sell/15 text-accent-sell border-accent-sell/40",
    HOLD: "bg-accent-hold/15 text-accent-hold border-accent-hold/40",
  } as const;

  const confidencePct = Math.round((signal.confidence ?? 0) * 100);

  return (
    <div className="bg-bg-panel border border-bg-border rounded-2xl p-4">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500">AI Signal</div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5">{signal.symbol}</div>
        </div>
        <div className={clsx("px-3 py-1.5 rounded-full text-xs font-bold border", colors[signal.action])}>
          {signal.action}
        </div>
      </div>

      {/* Confidence */}
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Confidence</div>
        <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
          <div
            className={clsx(
              "h-full rounded-full transition-all duration-500",
              signal.action === "BUY" ? "bg-accent-buy" : signal.action === "SELL" ? "bg-accent-sell" : "bg-accent-hold"
            )}
            style={{ width: `${confidencePct}%` }}
          />
        </div>
        <div className="text-[11px] text-slate-400 mt-1 font-mono">{confidencePct}%</div>
      </div>

      {signal.reason && <div className="text-sm text-slate-300 mb-3 leading-relaxed">{signal.reason}</div>}

      <PatternConfirmationRow pc={signal.pattern_confirmation} />

      {/* Entry / Stop / Target */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <Stat label="Entry" value={signal.suggestedEntry ?? signal.price} />
        <Stat label="Stop" value={signal.suggestedStop} tone="sell" />
        <Stat label="Target" value={signal.suggestedTarget} tone="buy" />
      </div>

      <OptionsContextRow symbol={signal.symbol} />

      {signal.action !== "HOLD" && <PaperTradeButton signal={signal} />}

      <AccuracySection accuracy={accuracy} symbol={signal.symbol} />

      {signal.indicators && (
        <div className="mt-3 pt-3 border-t border-bg-border">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Indicators</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono">
            {Object.entries(signal.indicators).map(([k, v]) => (
              <div key={k} className="flex justify-between text-slate-300">
                <span className="text-slate-500">{k}</span>
                <span>{typeof v === "number" ? v.toFixed(2) : v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AccuracySection({ accuracy, symbol }: { accuracy: AccuracyResponse | null; symbol: string }) {
  const sym = accuracy?.perSymbol.find((b) => b.symbol === symbol);
  const overall = accuracy?.overall;

  function pct(b: AccuracyBucket | undefined): string {
    if (!b || b.hitRate == null) return "—";
    return `${Math.round(b.hitRate * 100)}%`;
  }
  function sample(b: AccuracyBucket | undefined): string {
    if (!b) return "0 resolved";
    return `${b.wins + b.losses} resolved · ${b.pending} pending`;
  }

  return (
    <div className="mt-3 pt-3 border-t border-bg-border">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Live measured accuracy</div>
        <div className="text-[10px] text-slate-600 font-mono">rolling · last 500</div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">{symbol}</div>
          <div className="font-mono text-base text-slate-200">{pct(sym)}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">{sample(sym)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">All symbols</div>
          <div className="font-mono text-base text-slate-200">{pct(overall)}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">{sample(overall)}</div>
        </div>
      </div>
      <div className="mt-2.5 text-[10px] text-slate-600 leading-relaxed">
        Hit rate = wins / (wins + losses) on signals whose target or stop was reached.
        No system is 100% accurate — markets are partially random. Trade on edge and risk-reward, not perfect calls.
      </div>
    </div>
  );
}

// Module-level cache of symbols we've already established don't have an
// options chain (NSE small-caps, freshly-listed names). Prevents this
// component from spamming the AI service with 404s every time the user
// flips back to the same symbol.
const noOptionsCache = new Set<string>();

function OptionsContextRow({ symbol }: { symbol: string }) {
  const [data, setData] = useState<{ pcr: number; max_pain: number | null; expiry: string; dte: number } | null>(null);
  useEffect(() => {
    if (noOptionsCache.has(symbol)) { setData(null); return; }
    let alive = true;
    void api.get(`/api/options/chain/${symbol}`)
      .then((r) => {
        const exp = (r.data?.expiries ?? [])[0];
        if (!exp || !alive) {
          noOptionsCache.add(symbol);
          return;
        }
        setData({ pcr: exp.pcr, max_pain: exp.max_pain ?? null, expiry: exp.expiry, dte: exp.days_to_expiry });
      })
      .catch((err: { response?: { status?: number } }) => {
        // 404 = no options listed; remember and don't retry. Other errors
        // (5xx, network) — leave the cache untouched so we'll retry later.
        if (err?.response?.status === 404) noOptionsCache.add(symbol);
      });
    return () => { alive = false; };
  }, [symbol]);
  if (!data) return null;
  const bias = data.pcr > 1.1 ? "Bearish" : data.pcr < 0.9 ? "Bullish" : "Neutral";
  const biasColor = bias === "Bullish" ? "text-accent-buy" : bias === "Bearish" ? "text-accent-sell" : "text-slate-300";
  return (
    <div className="mt-3 grid grid-cols-3 gap-2 text-xs font-mono bg-bg-elevated/30 border border-bg-border rounded-md p-2">
      <div>
        <div className="text-[10px] uppercase text-slate-500">PCR ({data.expiry.slice(5)})</div>
        <div className={clsx("font-semibold", biasColor)}>{data.pcr.toFixed(2)} · {bias}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase text-slate-500">Max Pain</div>
        <div className="text-white">{data.max_pain != null ? `₹${data.max_pain.toFixed(0)}` : "—"}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase text-slate-500">DTE</div>
        <div className="text-white">{data.dte}d</div>
      </div>
    </div>
  );
}

function PaperTradeButton({ signal }: { signal: Signal }) {
  // Default qty: 1% of ₹10L on the spec's default capital, fall back to 10
  // shares if no entry price (handled inside the order terminal).
  const entry = signal.suggestedEntry ?? signal.price ?? 0;
  const stop = signal.suggestedStop ?? 0;
  const riskPerShare = Math.max(0.01, Math.abs(entry - stop));
  const defaultRiskRupees = 10_000; // 1% of the default ₹10L paper account
  const qty = entry > 0 ? Math.max(1, Math.floor(defaultRiskRupees / riskPerShare)) : 10;
  const side = signal.action === "BUY" ? "BUY" : "SELL";
  const params = new URLSearchParams({
    symbol: signal.symbol,
    side,
    qty: String(qty),
    sl: stop ? String(stop) : "",
    tp: signal.suggestedTarget ? String(signal.suggestedTarget) : "",
    tag: "AI Signal",
  });
  return (
    <div className="mt-3">
      <Link
        to={`/paper?${params.toString()}`}
        className="block w-full text-center text-xs bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/40 rounded-md py-2 transition-colors"
      >
        📄 Paper Trade this signal
      </Link>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value?: number; tone?: "buy" | "sell" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">{label}</div>
      <div
        className={clsx(
          "font-mono text-sm",
          tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-slate-200"
        )}
      >
        {value != null ? value.toFixed(2) : "—"}
      </div>
    </div>
  );
}


// Phase 11 Layer 6 — pattern confirmation row inside the AI signal card.
function PatternConfirmationRow({ pc }: { pc?: Signal["pattern_confirmation"] }) {
  if (pc == null) {
    return (
      <div className="mb-3 px-3 py-2 rounded-lg bg-bg-elevated/40 border border-bg-border text-[11px] text-slate-500">
        <span className="uppercase tracking-wider">Pattern Confirmation</span>
        <div className="text-slate-400 mt-0.5">No pattern — pure indicator signal.</div>
      </div>
    );
  }
  const arrow = pc.direction === "bullish" ? "▲" : pc.direction === "bearish" ? "▼" : "●";
  const cls = pc.agrees ? "border-accent-buy/30 bg-accent-buy/5" : "border-amber-500/30 bg-amber-500/5";
  const verb = pc.agrees ? "Confirms" : "⚠ Conflicts with";
  const gradeBg =
    pc.grade === "A+" ? "bg-emerald-500/20 text-emerald-300" :
    pc.grade === "A" ? "bg-emerald-500/15 text-emerald-400" :
    pc.grade === "B" ? "bg-amber-500/15 text-amber-400" :
    "bg-slate-500/15 text-slate-400";
  const deltaSign = (pc.delta ?? 0) >= 0 ? "+" : "";
  return (
    <div className={clsx("mb-3 px-3 py-2 rounded-lg border text-[11px]", cls)}>
      <div className="flex items-center justify-between mb-0.5">
        <span className="uppercase tracking-wider text-slate-500">Pattern Confirmation · {pc.timeframe ?? ""}</span>
        <span className="text-slate-500 font-mono">{deltaSign}{((pc.delta ?? 0) * 100).toFixed(1)} confidence</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={clsx(
          "text-lg",
          pc.direction === "bullish" ? "text-accent-buy" : pc.direction === "bearish" ? "text-accent-sell" : "text-amber-400"
        )}>{arrow}</span>
        <span className="text-white font-medium">{pc.pattern_name}</span>
        {pc.grade && <span className={clsx("px-1.5 py-0.5 rounded text-[9px] font-bold", gradeBg)}>{pc.grade}</span>}
        {pc.confidence != null && <span className="font-mono text-slate-300">{pc.confidence}%</span>}
        <span className="text-slate-400 ml-auto">{verb} the signal</span>
      </div>
    </div>
  );
}
