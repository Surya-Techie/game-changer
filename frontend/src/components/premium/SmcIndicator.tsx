import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { api } from "../../lib/api";
import { overlayManager } from "../../lib/overlayManager";
import { usePremium } from "../../store/premium";
import PremiumIndicatorCard from "../PremiumIndicatorCard";

interface OrderBlock { barIdx: number; t: number; top: number; bottom: number; mitigated: boolean }
interface Fvg { type: "bullish" | "bearish"; barIdx: number; t: number; top: number; bottom: number; filled: boolean }

interface SmcResponse {
  symbol: string;
  signal?: {
    label: string;
    structureBias: "BULLISH" | "BEARISH" | "MIXED";
    structureSequence: string[];
    lastBos: { type: "bullish" | "bearish"; price: number; barIdx: number; barsAgo: number } | null;
    lastChoch: { type: "bullish" | "bearish"; price: number; barIdx: number; barsAgo: number } | null;
    bullOrderBlocks: OrderBlock[];
    bearOrderBlocks: OrderBlock[];
    nearestBullOb: OrderBlock | null;
    nearestBearOb: OrderBlock | null;
    unfilledFvgs: Fvg[];
    ssl: { price: number; touches: number } | null;
    bsl: { price: number; touches: number } | null;
    zone: "PREMIUM" | "DISCOUNT" | "EQUILIBRIUM";
    positionPct: number;
    bullScore: number;
    bearScore: number;
  };
  error?: string;
}

export default function SmcIndicator({ symbol }: { symbol: string }) {
  const setLoadState = usePremium((s) => s.setLoadState);
  const [data, setData] = useState<SmcResponse | null>(null);
  const [updated, setUpdated] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  const fetcher = useCallback(async () => {
    if (!symbol) return;
    setLoadState("smc", "loading");
    setError(undefined);
    try {
      const { data } = await api.get(`/api/premium/smc/${symbol}`);
      if ((data as SmcResponse).error) {
        setError((data as SmcResponse).error);
        setLoadState("smc", "error", (data as SmcResponse).error);
        return;
      }
      setData(data as SmcResponse);
      setUpdated(Date.now());
      setLoadState("smc", "ready");
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err.message ?? "Failed";
      setError(msg);
      setLoadState("smc", "error", msg);
    }
  }, [symbol, setLoadState]);

  useEffect(() => {
    setData(null);
    setError(undefined);
  }, [symbol]);

  useEffect(() => {
    void fetcher();
    const id = setInterval(fetcher, 45_000);
    return () => clearInterval(id);
  }, [fetcher]);

  // Overlays: draw OB tops + bottoms + FVG tops + bottoms + SSL/BSL as price lines.
  useEffect(() => {
    if (data?.signal) {
      const sig = data.signal;
      const mountLine = (id: string, price: number, color: string, title: string, dashed = true) => {
        overlayManager.add({
          id, owner: "smc",
          mount(_chart, candleSeries) {
            const line = candleSeries.createPriceLine({
              price, color, lineWidth: 1,
              lineStyle: (dashed ? 2 : 0) as 0 | 1 | 2 | 3 | 4,
              axisLabelVisible: true, title,
            });
            return () => { try { candleSeries.removePriceLine(line); } catch { /* */ } };
          },
        });
      };
      // Order blocks — top + bottom each (last 2 of each side).
      sig.bullOrderBlocks.slice(-2).forEach((ob, i) => {
        const tag = ob.mitigated ? "✗" : "✓";
        mountLine(`smc:bullOb${i}:top`, ob.top, "#22c55e", `Bull OB ${tag}`);
        mountLine(`smc:bullOb${i}:bot`, ob.bottom, "#22c55e", "");
      });
      sig.bearOrderBlocks.slice(-2).forEach((ob, i) => {
        const tag = ob.mitigated ? "✗" : "✓";
        mountLine(`smc:bearOb${i}:top`, ob.top, "#ef4444", `Bear OB ${tag}`);
        mountLine(`smc:bearOb${i}:bot`, ob.bottom, "#ef4444", "");
      });
      sig.unfilledFvgs.slice(-3).forEach((fvg, i) => {
        const color = fvg.type === "bullish" ? "#22c55e" : "#ef4444";
        mountLine(`smc:fvg${i}:top`, fvg.top, color, `${fvg.type === "bullish" ? "Bull" : "Bear"} FVG`);
        mountLine(`smc:fvg${i}:bot`, fvg.bottom, color, "");
      });
      if (sig.ssl) mountLine("smc:ssl", sig.ssl.price, "#ef4444", `SSL ×${sig.ssl.touches}`);
      if (sig.bsl) mountLine("smc:bsl", sig.bsl.price, "#22c55e", `BSL ×${sig.bsl.touches}`);
      if (sig.lastBos) mountLine("smc:bos", sig.lastBos.price, "#f97316", `BOS ${sig.lastBos.type === "bullish" ? "↑" : "↓"}`);
    } else {
      overlayManager.removeOwner("smc");
    }
    return () => {
      overlayManager.removeOwner("smc");
    };
  }, [data]);

  const tone = useMemo(() => {
    const l = data?.signal?.label;
    if (l === "BUY") return "buy" as const;
    if (l === "SELL") return "sell" as const;
    return "info" as const;
  }, [data]);

  return (
    <PremiumIndicatorCard
      k="smc"
      state={error ? "error" : data ? "ready" : "loading"}
      error={error}
      updatedAt={updated}
      signal={data?.signal ? { label: data.signal.label, tone } : undefined}
      onRefresh={fetcher}
    >
      {data?.signal && (
        <div className="space-y-2 text-xs">
          <Row label="Structure bias" value={data.signal.structureBias} tone={data.signal.structureBias === "BULLISH" ? "buy" : data.signal.structureBias === "BEARISH" ? "sell" : undefined} />
          <Row label="Sequence" value={data.signal.structureSequence.join(" → ") || "—"} />
          <Row label="Zone" value={`${data.signal.zone} (${data.signal.positionPct.toFixed(0)}%)`} tone={data.signal.zone === "PREMIUM" ? "sell" : data.signal.zone === "DISCOUNT" ? "buy" : undefined} />

          {data.signal.lastBos && (
            <div className="mt-2 pt-2 border-t border-bg-border">
              <Row label="Last BOS" value={`${data.signal.lastBos.type === "bullish" ? "↑" : "↓"} ₹${data.signal.lastBos.price.toFixed(2)} (${data.signal.lastBos.barsAgo} bars)`} tone={data.signal.lastBos.type === "bullish" ? "buy" : "sell"} />
            </div>
          )}
          {data.signal.lastChoch && (
            <Row label="Last CHoCH" value={`${data.signal.lastChoch.type === "bullish" ? "↑" : "↓"} ₹${data.signal.lastChoch.price.toFixed(2)} (${data.signal.lastChoch.barsAgo} bars)`} tone={data.signal.lastChoch.type === "bullish" ? "buy" : "sell"} />
          )}

          {data.signal.nearestBullOb && (
            <Row label="Nearest Bull OB" value={`₹${data.signal.nearestBullOb.bottom.toFixed(2)} – ₹${data.signal.nearestBullOb.top.toFixed(2)} ${data.signal.nearestBullOb.mitigated ? "(used)" : ""}`} tone="buy" />
          )}
          {data.signal.nearestBearOb && (
            <Row label="Nearest Bear OB" value={`₹${data.signal.nearestBearOb.bottom.toFixed(2)} – ₹${data.signal.nearestBearOb.top.toFixed(2)} ${data.signal.nearestBearOb.mitigated ? "(used)" : ""}`} tone="sell" />
          )}

          {data.signal.ssl && <Row label="SSL ⚡" value={`₹${data.signal.ssl.price.toFixed(2)} (×${data.signal.ssl.touches})`} tone="sell" />}
          {data.signal.bsl && <Row label="BSL ⚡" value={`₹${data.signal.bsl.price.toFixed(2)} (×${data.signal.bsl.touches})`} tone="buy" />}

          {data.signal.unfilledFvgs.length > 0 && (
            <div className="mt-2 pt-2 border-t border-bg-border">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Unfilled FVGs ({data.signal.unfilledFvgs.length})</div>
              {data.signal.unfilledFvgs.slice(-3).map((f, i) => (
                <div key={i} className="flex justify-between text-[11px] font-mono">
                  <span className={f.type === "bullish" ? "text-accent-buy" : "text-accent-sell"}>{f.type === "bullish" ? "Bull" : "Bear"} FVG</span>
                  <span className="text-slate-300">₹{f.bottom.toFixed(2)} – ₹{f.top.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-2 pt-2 border-t border-bg-border text-[10px] text-slate-500 font-mono">
            Bull score: {data.signal.bullScore} · Bear score: {data.signal.bearScore}
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
