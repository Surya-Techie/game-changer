import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

interface Props {
  signal?: {
    symbol?: string;
    action?: "BUY" | "SELL" | "HOLD";
    confidence?: number;
    reason?: string;
    indicators?: Record<string, number | string>;
  };
}

/**
 * Redesigned "AI assistant" panel that surfaces a natural-language read of
 * the current state. Redesigned to feel premium and intelligent.
 */
export default function AIAssistantCard({ signal }: Props) {
  const text = compose(signal);
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className="relative rounded-2xl border border-accent-info/30 bg-gradient-to-br from-accent-info/10 via-accent-info/5 to-transparent p-4 overflow-hidden shadow-sm"
    >
      {/* Decorative Glow blob inside the card */}
      <div className="absolute -right-8 -top-8 w-24 h-24 rounded-full bg-accent-info/10 blur-xl pointer-events-none" />

      <div className="flex items-center gap-2 mb-1.5">
        <div className="h-6 w-6 rounded-lg bg-accent-info/10 border border-accent-info/20 flex items-center justify-center text-accent-info">
          <Sparkles className="h-3.5 w-3.5 animate-pulse-slow" />
        </div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-accent-info font-display">AI Assistant</div>
      </div>
      <div className="text-sm text-slate-200 leading-relaxed font-sans font-medium">{text}</div>
    </motion.div>
  );
}

function compose(sig?: Props["signal"]): string {
  if (!sig || !sig.action) {
    return "Waiting on the next signal pass. The strategy re-evaluates every 15 seconds across the universe.";
  }
  const sym = sig.symbol ?? "this symbol";
  const conf = sig.confidence != null ? `${Math.round(sig.confidence * 100)}%` : "—";
  const rsi = sig.indicators?.rsi14;
  const macd = sig.indicators?.macdHist;
  const st = sig.indicators?.supertrendDir;
  const macdNum = typeof macd === "number" ? macd : 0;
  const stStr = st === 1 ? "Supertrend bullish" : st === -1 ? "Supertrend bearish" : "Supertrend neutral";
  if (sig.action === "HOLD") {
    return `${sym} is consolidating. RSI ${rsi ?? "?"}, MACD histogram ${macdNum.toFixed(3)}, ${stStr}. No high-quality setup — staying flat.`;
  }
  const direction = sig.action === "BUY" ? "long" : "short";
  return `${sym}: ${direction} setup at ${conf} confidence. ${sig.reason ?? ""} Key reads — RSI ${rsi ?? "?"}, MACD hist ${macdNum.toFixed(3)}, ${stStr}.`;
}
