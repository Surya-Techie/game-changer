import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { UTCTimestamp } from "lightweight-charts";
import { api } from "../../lib/api";
import { overlayManager } from "../../lib/overlayManager";
import { usePremium } from "../../store/premium";
import PremiumIndicatorCard from "../PremiumIndicatorCard";
import { apiErrorMessage } from "../../lib/errors";

interface IchimokuResponse {
  symbol: string;
  t: number[];
  tenkan: (number | null)[];
  kijun: (number | null)[];
  spanA: (number | null)[];
  spanB: (number | null)[];
  chikou: (number | null)[];
  signal?: {
    label: string;
    score: number;
    outOf: number;
    price: number;
    tenkan: number;
    kijun: number;
    spanA: number;
    spanB: number;
    cloudColor: "green" | "red";
    cloudThickness: number;
    freshTkCross: boolean;
    crossBarsAgo: number | null;
    conditions: {
      priceAboveCloud: boolean;
      tenkanAboveKijun: boolean;
      freshTkCross: boolean;
      chikouAbove: boolean;
      priceAboveTenkan: boolean;
      greenCloudAhead: boolean;
    };
  };
  error?: string;
}

const COLORS = {
  tenkan: "#f43f5e",
  kijun: "#3b82f6",
  spanA: "#22c55e",
  spanB: "#ef4444",
  chikou: "#a78bfa",
};

export default function IchimokuIndicator({ symbol }: { symbol: string }) {
  const setLoadState = usePremium((s) => s.setLoadState);
  const [data, setData] = useState<IchimokuResponse | null>(null);
  const [updated, setUpdated] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  const fetcher = useCallback(async () => {
    if (!symbol) return;
    setLoadState("ichimoku", "loading");
    setError(undefined);
    try {
      const { data } = await api.get(`/api/premium/ichimoku/${symbol}`);
      if ((data as IchimokuResponse).error) {
        setError((data as IchimokuResponse).error);
        setLoadState("ichimoku", "error", (data as IchimokuResponse).error);
        return;
      }
      setData(data as IchimokuResponse);
      setUpdated(Date.now());
      setLoadState("ichimoku", "ready");
    } catch (err) {
      const msg = apiErrorMessage(err, "Failed");
      setError(msg);
      setLoadState("ichimoku", "error", msg);
    }
  }, [symbol, setLoadState]);

  useEffect(() => {
    setData(null);
    setError(undefined);
  }, [symbol]);

  useEffect(() => {
    void fetcher();
    const id = setInterval(fetcher, 60_000);
    return () => clearInterval(id);
  }, [fetcher]);

  useEffect(() => {
    if (data) {
      const t = data.t;
      const mountLine = (id: string, values: (number | null)[], color: string, opts?: { thin?: boolean }) => {
        overlayManager.add({
          id, owner: "ichimoku",
          mount(chart) {
            const s = chart.addLineSeries({
              color, lineWidth: opts?.thin ? 1 : 2,
              priceLineVisible: false, lastValueVisible: false,
            });
            s.setData(values.map((v, i) => ({ time: Math.floor(t[i]! / 1000) as UTCTimestamp, value: v ?? NaN })).filter((p) => Number.isFinite(p.value)));
            return () => { try { chart.removeSeries(s); } catch { /* */ } };
          },
        });
      };
      mountLine("ich:tenkan", data.tenkan, COLORS.tenkan);
      mountLine("ich:kijun", data.kijun, COLORS.kijun);
      mountLine("ich:spanA", data.spanA, COLORS.spanA, { thin: true });
      mountLine("ich:spanB", data.spanB, COLORS.spanB, { thin: true });
      mountLine("ich:chikou", data.chikou, COLORS.chikou, { thin: true });
    } else {
      overlayManager.removeOwner("ichimoku");
    }
    return () => {
      overlayManager.removeOwner("ichimoku");
    };
  }, [data]);

  const tone = useMemo(() => {
    const l = data?.signal?.label;
    if (l?.includes("STRONG BUY") || l === "BUY") return "buy" as const;
    if (l?.includes("STRONG SELL") || l === "SELL") return "sell" as const;
    return "info" as const;
  }, [data]);

  return (
    <PremiumIndicatorCard
      k="ichimoku"
      state={error ? "error" : data ? "ready" : "loading"}
      error={error}
      updatedAt={updated}
      signal={data?.signal ? { label: `${data.signal.label} ${data.signal.score}/${data.signal.outOf}`, tone } : undefined}
      onRefresh={fetcher}
    >
      {data?.signal && (
        <div className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
            <Row label="Tenkan-sen" value={`₹${data.signal.tenkan.toFixed(2)}`} />
            <Row label="Kijun-sen" value={`₹${data.signal.kijun.toFixed(2)}`} />
            <Row label="Span A" value={`₹${data.signal.spanA.toFixed(2)}`} tone="buy" />
            <Row label="Span B" value={`₹${data.signal.spanB.toFixed(2)}`} tone="sell" />
          </div>
          <Row label="Cloud" value={`${data.signal.cloudColor.toUpperCase()} · thickness ₹${data.signal.cloudThickness.toFixed(2)}`} tone={data.signal.cloudColor === "green" ? "buy" : "sell"} />

          <div className="mt-3 pt-3 border-t border-bg-border">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">6-condition checklist</div>
            <ul className="space-y-1 text-[11px]">
              <Cond ok={data.signal.conditions.priceAboveCloud}>Price above cloud</Cond>
              <Cond ok={data.signal.conditions.tenkanAboveKijun}>Tenkan above Kijun</Cond>
              <Cond ok={data.signal.conditions.freshTkCross}>{`Fresh TK cross${data.signal.crossBarsAgo != null ? ` (${data.signal.crossBarsAgo} bars ago)` : ""}`}</Cond>
              <Cond ok={data.signal.conditions.chikouAbove}>Chikou above price 26 bars ago</Cond>
              <Cond ok={data.signal.conditions.priceAboveTenkan}>Price above Tenkan</Cond>
              <Cond ok={data.signal.conditions.greenCloudAhead}>Green cloud ahead</Cond>
            </ul>
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

function Cond({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={clsx("flex items-center gap-2", ok ? "text-slate-200" : "text-slate-500")}>
      <span>{ok ? "✅" : "❌"}</span>
      <span>{children}</span>
    </li>
  );
}
