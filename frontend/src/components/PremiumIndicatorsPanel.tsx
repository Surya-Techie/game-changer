/**
 * Right-rail container that holds one card per currently-active premium
 * indicator. Each indicator component renders its own full card via
 * PremiumIndicatorCard and registers chart overlays through overlayManager.
 */

import { motion, AnimatePresence } from "framer-motion";
import { usePremium, type PremiumKey } from "../store/premium";
import VwapIndicator from "./premium/VwapIndicator";
import IchimokuIndicator from "./premium/IchimokuIndicator";
import SmcIndicator from "./premium/SmcIndicator";
import OrderFlowIndicator from "./premium/OrderFlowIndicator";
import MarketProfileIndicator from "./premium/MarketProfileIndicator";

interface Props {
  symbol: string;
}

export default function PremiumIndicatorsPanel({ symbol }: Props) {
  const active = usePremium((s) => s.active);
  const order = usePremium((s) => s.order);
  const collapseAll = usePremium((s) => s.collapseAll);
  const expandAll = usePremium((s) => s.expandAll);

  const visible = order.filter((k) => active.has(k));

  if (visible.length === 0) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-panel-solid/70 backdrop-blur-glass p-4">
        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">⚡ Premium Indicators</div>
        <div className="text-xs text-slate-500">
          Pick one from the toolbar above the chart to begin. Up to 5 can be active at once.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">⚡ Premium Indicators</div>
        <div className="flex items-center gap-2 text-[10px] text-slate-500">
          <button onClick={expandAll} className="hover:text-white">Expand all</button>
          <span className="text-slate-700">·</span>
          <button onClick={collapseAll} className="hover:text-white">Collapse all</button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {visible.map((k) => (
          <motion.div key={k} layout>
            {renderFor(k, symbol)}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function renderFor(k: PremiumKey, symbol: string) {
  switch (k) {
    case "vwap":      return <VwapIndicator symbol={symbol} />;
    case "ichimoku":  return <IchimokuIndicator symbol={symbol} />;
    case "smc":       return <SmcIndicator symbol={symbol} />;
    case "orderflow": return <OrderFlowIndicator symbol={symbol} />;
    case "profile":   return <MarketProfileIndicator symbol={symbol} />;
  }
}
