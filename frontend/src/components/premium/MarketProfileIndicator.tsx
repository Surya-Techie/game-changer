import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { overlayManager } from "../../lib/overlayManager";
import { usePremium } from "../../store/premium";
import PremiumIndicatorCard from "../PremiumIndicatorCard";
import { apiErrorMessage } from "../../lib/errors";

interface ProfileResponse {
  symbol: string;
  signal?: {
    label: string;
    poc: number;
    vah: number;
    val: number;
    vaWidthPct: number;
    ibHigh: number;
    ibLow: number;
    ibWidth: number;
    hvn: number[];
    lvn: number[];
    position: string;
    shape: "NORMAL" | "P-SHAPED" | "b-SHAPED" | "DOUBLE DISTRIBUTION";
    priceStep: number;
    lastPrice: number;
  };
  error?: string;
}

export default function MarketProfileIndicator({ symbol }: { symbol: string }) {
  const setLoadState = usePremium((s) => s.setLoadState);
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [updated, setUpdated] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  const fetcher = useCallback(async () => {
    if (!symbol) return;
    setLoadState("profile", "loading");
    setError(undefined);
    try {
      const { data } = await api.get(`/api/premium/profile/${symbol}`);
      if ((data as ProfileResponse).error) {
        setError((data as ProfileResponse).error);
        setLoadState("profile", "error", (data as ProfileResponse).error);
        return;
      }
      setData(data as ProfileResponse);
      setUpdated(Date.now());
      setLoadState("profile", "ready");
    } catch (err) {
      const msg = apiErrorMessage(err, "Failed");
      setError(msg);
      setLoadState("profile", "error", msg);
    }
  }, [symbol, setLoadState]);

  useEffect(() => {
    setData(null);
    setError(undefined);
  }, [symbol]);

  useEffect(() => {
    void fetcher();
    const id = setInterval(fetcher, 5 * 60 * 1000); // 5 min — profile is slow-moving
    return () => clearInterval(id);
  }, [fetcher]);

  useEffect(() => {
    if (data?.signal) {
      const sig = data.signal;
      const mountLine = (id: string, price: number, color: string, title: string, weight: 1 | 2 = 1) => {
        overlayManager.add({
          id, owner: "profile",
          mount(_chart, candleSeries) {
            const line = candleSeries.createPriceLine({
              price, color, lineWidth: weight,
              lineStyle: 2, axisLabelVisible: true, title,
            });
            return () => { try { candleSeries.removePriceLine(line); } catch { /* */ } };
          },
        });
      };
      mountLine("prof:poc", sig.poc, "#f59e0b", "POC", 2);
      mountLine("prof:vah", sig.vah, "#22c55e", "VAH");
      mountLine("prof:val", sig.val, "#ef4444", "VAL");
      sig.hvn.forEach((p, i) => mountLine(`prof:hvn${i}`, p, "#14b8a6", "HVN"));
      sig.lvn.forEach((p, i) => mountLine(`prof:lvn${i}`, p, "#64748b", "LVN"));
    } else {
      overlayManager.removeOwner("profile");
    }
    return () => {
      overlayManager.removeOwner("profile");
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
      k="profile"
      state={error ? "error" : data ? "ready" : "loading"}
      error={error}
      updatedAt={updated}
      signal={data?.signal ? { label: data.signal.label, tone } : undefined}
      onRefresh={fetcher}
    >
      {data?.signal && (
        <div className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
            <Row label="POC" value={`₹${data.signal.poc.toFixed(2)}`} />
            <Row label="VA width" value={`${data.signal.vaWidthPct.toFixed(2)}%`} />
            <Row label="VAH" value={`₹${data.signal.vah.toFixed(2)}`} tone="buy" />
            <Row label="VAL" value={`₹${data.signal.val.toFixed(2)}`} tone="sell" />
            <Row label="IB high" value={`₹${data.signal.ibHigh.toFixed(2)}`} />
            <Row label="IB low" value={`₹${data.signal.ibLow.toFixed(2)}`} />
            <Row label="IB width" value={`₹${data.signal.ibWidth.toFixed(2)}`} />
            <Row label="Step" value={`₹${data.signal.priceStep.toFixed(2)}`} />
          </div>
          <Row label="Position" value={data.signal.position} tone={data.signal.label === "BUY" ? "buy" : data.signal.label === "SELL" ? "sell" : undefined} />
          <Row label="Shape" value={data.signal.shape} />
          {data.signal.hvn.length > 0 && (
            <div className="text-[11px]">
              <span className="text-slate-500">HVN: </span>
              <span className="text-slate-200 font-mono">{data.signal.hvn.map((p) => `₹${p.toFixed(2)}`).join(", ")}</span>
            </div>
          )}
          {data.signal.lvn.length > 0 && (
            <div className="text-[11px]">
              <span className="text-slate-500">LVN: </span>
              <span className="text-slate-200 font-mono">{data.signal.lvn.map((p) => `₹${p.toFixed(2)}`).join(", ")}</span>
            </div>
          )}
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
