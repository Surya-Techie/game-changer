import { useCallback, useEffect, useMemo, useState } from "react";
import type { LineStyle, UTCTimestamp } from "lightweight-charts";
import { api } from "../../lib/api";
import { overlayManager } from "../../lib/overlayManager";
import { usePremium } from "../../store/premium";
import PremiumIndicatorCard from "../PremiumIndicatorCard";
import { apiErrorMessage } from "../../lib/errors";

interface VwapResponse {
  symbol: string;
  t: number[];
  vwap: (number | null)[];
  upper1: (number | null)[];
  lower1: (number | null)[];
  upper2: (number | null)[];
  lower2: (number | null)[];
  upper3: (number | null)[];
  lower3: (number | null)[];
  anchored?: Array<{ anchorIdx: number; anchorTime: number; anchorPrice: number; current: number | null; t: number[]; values: (number | null)[]; abovePrice: boolean | null }>;
  signal?: {
    label: string;
    vwap: number;
    prevVwap: number | null;
    prevVwapChangePct: number | null;
    lastPrice: number;
    priceVsVwapPct: number;
    bandPosition: string;
    u1: number; l1: number; u2: number; l2: number; u3: number; l3: number;
    slopePct: number;
    slopeLabel: string;
    volumeRatio: number;
    extendedWarning: boolean;
  };
  error?: string;
}

const COLORS = {
  vwap: "#3b82f6",
  band1Top: "#22c55e",
  band1Bot: "#ef4444",
  band2: "#94a3b8",
  prev: "#64748b",
  anchored: "#f97316",
};

export default function VwapIndicator({ symbol }: { symbol: string }) {
  const setLoadState = usePremium((s) => s.setLoadState);
  const anchorBars = usePremium((s) => s.anchorBars[symbol] ?? []);
  const addAnchor = usePremium((s) => s.addAnchor);
  const removeAnchor = usePremium((s) => s.removeAnchor);
  const [data, setData] = useState<VwapResponse | null>(null);
  const [updated, setUpdated] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  const fetcher = useCallback(async () => {
    if (!symbol) return;
    setLoadState("vwap", "loading");
    setError(undefined);
    try {
      const params = anchorBars.length ? `?anchor=${anchorBars.join(",")}` : "";
      const { data } = await api.get(`/api/premium/vwap/${symbol}${params}`);
      if ((data as VwapResponse).error) {
        setError((data as VwapResponse).error);
        setLoadState("vwap", "error", (data as VwapResponse).error);
        return;
      }
      setData(data as VwapResponse);
      setUpdated(Date.now());
      setLoadState("vwap", "ready");
    } catch (err) {
      const msg = apiErrorMessage(err, "Failed");
      setError(msg);
      setLoadState("vwap", "error", msg);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [symbol, anchorBars.join(","), setLoadState]);

  useEffect(() => {
    setData(null);
    setError(undefined);
  }, [symbol]);

  useEffect(() => {
    void fetcher();
    const id = setInterval(fetcher, 60_000);
    return () => clearInterval(id);
  }, [fetcher]);

  // Register chart overlays whenever data changes.
  useEffect(() => {
    if (data) {
      const t = data.t;
      const mountLine = (id: string, values: (number | null)[], color: string, opts?: { dashed?: boolean; thin?: boolean }) => {
        overlayManager.add({
          id, owner: "vwap",
          mount(chart, _candle) {
            const series = chart.addLineSeries({
              color, lineWidth: opts?.thin ? 1 : 2,
              lineStyle: (opts?.dashed ? 2 : 0) as LineStyle,
              priceLineVisible: false, lastValueVisible: id === "vwap:main",
              title: id === "vwap:main" ? "VWAP" : "",
            });
            series.setData(values.map((v, i) => ({ time: Math.floor(t[i]! / 1000) as UTCTimestamp, value: v ?? NaN })).filter((p) => Number.isFinite(p.value)));
            return () => { try { chart.removeSeries(series); } catch { /* removed */ } };
          },
        });
      };
      mountLine("vwap:main", data.vwap, COLORS.vwap);
      mountLine("vwap:u1", data.upper1, COLORS.band1Top, { dashed: true });
      mountLine("vwap:l1", data.lower1, COLORS.band1Bot, { dashed: true });
      mountLine("vwap:u2", data.upper2, COLORS.band2, { dashed: true, thin: true });
      mountLine("vwap:l2", data.lower2, COLORS.band2, { dashed: true, thin: true });
      mountLine("vwap:u3", data.upper3, COLORS.band1Top, { dashed: true, thin: true });
      mountLine("vwap:l3", data.lower3, COLORS.band1Bot, { dashed: true, thin: true });

      // Anchored VWAP lines.
      for (const a of data.anchored ?? []) {
        overlayManager.add({
          id: `vwap:anchor:${a.anchorIdx}`,
          owner: "vwap",
          mount(chart) {
            const series = chart.addLineSeries({
              color: COLORS.anchored, lineWidth: 2,
              priceLineVisible: false, lastValueVisible: true,
              title: `aVWAP@${a.anchorIdx}`,
            });
            series.setData(a.values.map((v, i) => ({ time: Math.floor(a.t[i]! / 1000) as UTCTimestamp, value: v ?? NaN })).filter((p) => Number.isFinite(p.value)));
            return () => { try { chart.removeSeries(series); } catch { /* */ } };
          },
        });
      }

      // Previous-day VWAP as a horizontal price-line on the candle series.
      const prevVwap = data.signal?.prevVwap;
      if (prevVwap != null) {
        overlayManager.add({
          id: "vwap:prev",
          owner: "vwap",
          mount(_chart, candleSeries) {
            const line = candleSeries.createPriceLine({
              price: prevVwap, color: COLORS.prev, lineWidth: 1,
              lineStyle: 2, axisLabelVisible: true, title: "Prev VWAP",
            });
            return () => { try { candleSeries.removePriceLine(line); } catch { /* */ } };
          },
        });
      }
    } else {
      overlayManager.removeOwner("vwap");
    }
    return () => {
      overlayManager.removeOwner("vwap");
    };
  }, [data]);

  const tone = useMemo(() => {
    const l = data?.signal?.label;
    if (l === "STRONG BUY" || l === "BUY") return "buy" as const;
    if (l === "STRONG SELL" || l === "SELL") return "sell" as const;
    if (l === "EXTENDED") return "hold" as const;
    return "info" as const;
  }, [data]);

  return (
    <PremiumIndicatorCard
      k="vwap"
      state={error ? "error" : data ? "ready" : "loading"}
      error={error}
      updatedAt={updated}
      signal={data?.signal ? { label: data.signal.label, tone } : undefined}
      onRefresh={fetcher}
    >
      {data?.signal && (
        <div className="space-y-2 text-xs">
          <Row label="VWAP" value={`₹${data.signal.vwap.toFixed(2)}`} />
          {data.signal.prevVwap != null && (
            <Row label="Prev VWAP" value={`₹${data.signal.prevVwap.toFixed(2)} (${data.signal.prevVwapChangePct! >= 0 ? "+" : ""}${data.signal.prevVwapChangePct!.toFixed(2)}%)`} />
          )}
          <Row label="Price vs VWAP" tone={data.signal.priceVsVwapPct >= 0 ? "buy" : "sell"} value={`${data.signal.priceVsVwapPct >= 0 ? "+" : ""}${data.signal.priceVsVwapPct.toFixed(2)}%`} />
          <Row label="Band position" value={data.signal.bandPosition} />
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
            <Row label="+1σ" value={`₹${data.signal.u1.toFixed(2)}`} tone="buy" />
            <Row label="-1σ" value={`₹${data.signal.l1.toFixed(2)}`} tone="sell" />
            <Row label="+2σ" value={`₹${data.signal.u2.toFixed(2)}`} />
            <Row label="-2σ" value={`₹${data.signal.l2.toFixed(2)}`} />
            <Row label="+3σ" value={`₹${data.signal.u3.toFixed(2)}`} />
            <Row label="-3σ" value={`₹${data.signal.l3.toFixed(2)}`} />
          </div>
          <Row label="Slope" value={`${data.signal.slopeLabel} (${data.signal.slopePct >= 0 ? "+" : ""}${data.signal.slopePct.toFixed(3)}%/bar)`} />
          <Row label="Volume" value={`${data.signal.volumeRatio.toFixed(2)}× 20-bar avg`} />
          {data.signal.extendedWarning && (
            <div className="mt-2 text-[11px] text-accent-hold border border-accent-hold/40 rounded p-2">
              ⚠ Extended beyond +2σ — mean-reversion risk.
            </div>
          )}

          <div className="mt-3 pt-3 border-t border-bg-border">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Anchored VWAP</span>
              <div className="flex gap-1">
                <button
                  onClick={() => addAnchor(symbol, data.t.length - 1)}
                  className="text-[10px] border border-bg-border rounded px-1.5 py-0.5 hover:text-white text-slate-400"
                >
                  Anchor here
                </button>
                <button
                  onClick={() => addAnchor(symbol, 0)}
                  className="text-[10px] border border-bg-border rounded px-1.5 py-0.5 hover:text-white text-slate-400"
                  title="Anchor at the first available bar"
                >
                  Anchor start
                </button>
              </div>
            </div>
            {data.anchored && data.anchored.length > 0 ? (
              <div className="space-y-1">
                {data.anchored.map((a) => (
                  <div key={a.anchorIdx} className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400 font-mono">@bar{a.anchorIdx} ({new Date(a.anchorTime).toLocaleTimeString()})</span>
                    <span className={a.abovePrice === false ? "text-accent-sell" : "text-accent-buy"}>
                      ₹{a.current?.toFixed(2) ?? "—"}
                    </span>
                    <button onClick={() => removeAnchor(symbol, a.anchorIdx)} className="text-slate-500 hover:text-accent-sell">✕</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-slate-500">No anchors. Up to 3 simultaneous.</div>
            )}
          </div>
        </div>
      )}
    </PremiumIndicatorCard>
  );
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
