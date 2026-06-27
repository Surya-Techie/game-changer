import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { api } from "../../lib/api";
import { usePremium } from "../../store/premium";
import PremiumIndicatorCard from "../PremiumIndicatorCard";

interface OrderFlowResponse {
  symbol: string;
  delta?: number[];
  cumDelta?: number[];
  signal?: {
    label: string;
    currentDelta: number;
    cumulativeDelta: number;
    buyVolume: number;
    sellVolume: number;
    buyPct: number;
    sellPct: number;
    positivePctLast10: number;
    divergence: { type: "bullish" | "bearish"; note: string } | null;
    absorption: Array<{ barIdx: number; type: string; delta: number }>;
  };
  error?: string;
}

export default function OrderFlowIndicator({ symbol }: { symbol: string }) {
  const setLoadState = usePremium((s) => s.setLoadState);
  const [data, setData] = useState<OrderFlowResponse | null>(null);
  const [updated, setUpdated] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  const fetcher = useCallback(async () => {
    if (!symbol) return;
    setLoadState("orderflow", "loading");
    setError(undefined);
    try {
      const { data } = await api.get(`/api/premium/orderflow/${symbol}`);
      if ((data as OrderFlowResponse).error) {
        setError((data as OrderFlowResponse).error);
        setLoadState("orderflow", "error", (data as OrderFlowResponse).error);
        return;
      }
      setData(data as OrderFlowResponse);
      setUpdated(Date.now());
      setLoadState("orderflow", "ready");
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err.message ?? "Failed";
      setError(msg);
      setLoadState("orderflow", "error", msg);
    }
  }, [symbol, setLoadState]);

  useEffect(() => {
    setData(null);
    setError(undefined);
  }, [symbol]);

  useEffect(() => {
    void fetcher();
    const id = setInterval(fetcher, 30_000); // faster refresh — per spec
    return () => clearInterval(id);
  }, [fetcher]);

  // Mini delta histogram inline (no separate chart sub-pane — that needs LWC primitives).
  const deltaBars = useMemo(() => {
    const arr = data?.delta?.slice(-30) ?? [];
    if (arr.length === 0) return null;
    const max = Math.max(...arr.map((x) => Math.abs(x)), 1);
    return { arr, max };
  }, [data]);

  const tone = useMemo(() => {
    const l = data?.signal?.label ?? "";
    if (l.includes("BUYERS")) return "buy" as const;
    if (l.includes("SELLERS")) return "sell" as const;
    if (l.includes("bearish")) return "sell" as const;
    if (l.includes("bullish")) return "buy" as const;
    return "info" as const;
  }, [data]);

  return (
    <PremiumIndicatorCard
      k="orderflow"
      state={error ? "error" : data ? "ready" : "loading"}
      error={error}
      updatedAt={updated}
      signal={data?.signal ? { label: data.signal.label, tone } : undefined}
      onRefresh={fetcher}
    >
      {data?.signal && (
        <div className="space-y-2 text-xs">
          <Row label="Current Δ" value={fmt(data.signal.currentDelta, true)} tone={data.signal.currentDelta >= 0 ? "buy" : "sell"} />
          <Row label="Cumulative Δ" value={fmt(data.signal.cumulativeDelta, true)} tone={data.signal.cumulativeDelta >= 0 ? "buy" : "sell"} />
          <div className="grid grid-cols-2 gap-x-3">
            <Row label="Buy vol" value={`${fmt(data.signal.buyVolume)} (${data.signal.buyPct.toFixed(0)}%)`} tone="buy" />
            <Row label="Sell vol" value={`${fmt(data.signal.sellVolume)} (${data.signal.sellPct.toFixed(0)}%)`} tone="sell" />
          </div>

          {deltaBars && (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Δ — last 30 bars</div>
              <div className="flex items-center gap-px h-10">
                {deltaBars.arr.map((v, i) => {
                  const up = v >= 0;
                  const h = (Math.abs(v) / deltaBars.max) * 100;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center justify-center">
                      <div
                        className={clsx("w-full", up ? "bg-accent-buy/70 self-end" : "bg-accent-sell/70 self-start")}
                        style={{ height: `${h}%` }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <Row label="Positive bars (10)" value={`${data.signal.positivePctLast10}%`} />

          {data.signal.divergence && (
            <div className={clsx("mt-2 p-2 rounded border text-[11px]",
              data.signal.divergence.type === "bearish"
                ? "border-accent-sell/40 bg-accent-sell/5 text-accent-sell"
                : "border-accent-buy/40 bg-accent-buy/5 text-accent-buy"
            )}>
              ⚠ {data.signal.divergence.type.toUpperCase()} divergence — {data.signal.divergence.note}
            </div>
          )}

          {data.signal.absorption.length > 0 && (
            <div className="mt-2 pt-2 border-t border-bg-border">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Absorption</div>
              {data.signal.absorption.map((a, i) => (
                <div key={i} className="text-[11px] text-accent-hold">
                  {a.type} at bar {a.barIdx} (Δ={a.delta.toFixed(0)})
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </PremiumIndicatorCard>
  );
}

function fmt(n: number, signed = false): string {
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${Math.round(n).toLocaleString("en-IN")}`;
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "buy" | "sell" }) {
  const cls = tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-slate-200";
  return (
    <div className="flex justify-between font-mono">
      <span className="text-slate-500">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}
