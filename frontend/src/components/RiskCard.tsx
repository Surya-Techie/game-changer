import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { useAuth } from "../store/auth";

interface SignalLike {
  symbol?: string;
  action: "BUY" | "SELL" | "HOLD";
  price?: number;
  suggestedEntry?: number;
  suggestedStop?: number;
  suggestedTarget?: number;
}

interface Props {
  signal?: SignalLike;
  currentPrice?: number;
}

const fmtINR = (n: number, signed = false) => `${signed && n > 0 ? "+" : ""}₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function ratingFor(rr: number): { label: string; tone: string } {
  if (rr >= 3) return { label: "EXCELLENT", tone: "text-accent-buy" };
  if (rr >= 2) return { label: "GOOD", tone: "text-accent-buy" };
  if (rr >= 1.2) return { label: "FAIR", tone: "text-accent-hold" };
  return { label: "POOR", tone: "text-accent-sell" };
}

export default function RiskCard({ signal, currentPrice }: Props) {
  const user = useAuth((s) => s.user);
  const capital = user?.capital ?? 100_000;
  const riskPct = 1; // synced with /api/autotrade settings; sensible default
  const riskAmount = (capital * riskPct) / 100;

  // Manual calculator inputs default to signal values when available.
  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [entry, setEntry] = useState<string>("");
  const [stop, setStop] = useState<string>("");
  const [target, setTarget] = useState<string>("");

  useEffect(() => {
    if (signal?.action === "BUY") setSide("LONG");
    else if (signal?.action === "SELL") setSide("SHORT");
    const e = signal?.suggestedEntry ?? signal?.price ?? currentPrice;
    if (e != null) setEntry(String(e));
    if (signal?.suggestedStop != null) setStop(String(signal.suggestedStop));
    if (signal?.suggestedTarget != null) setTarget(String(signal.suggestedTarget));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [signal?.symbol, signal?.suggestedEntry, signal?.suggestedStop, signal?.suggestedTarget]);

  const calc = useMemo(() => {
    const e = Number(entry);
    const s = Number(stop);
    const t = Number(target);
    if (!Number.isFinite(e) || !Number.isFinite(s) || e <= 0 || s <= 0) return null;
    const riskPerShare = Math.abs(e - s);
    if (riskPerShare === 0) return null;
    const tValid = Number.isFinite(t) && t > 0;
    const rewardPerShare = tValid ? Math.abs(t - e) : 0;
    const rr = rewardPerShare > 0 ? rewardPerShare / riskPerShare : 0;
    const qty = Math.floor(riskAmount / riskPerShare);
    const maxLoss = qty * riskPerShare;
    const potentialGain = qty * rewardPerShare;
    const riskPctOfPrice = (riskPerShare / e) * 100;
    const rewardPctOfPrice = tValid ? (rewardPerShare / e) * 100 : 0;
    const rating = ratingFor(rr);
    // Validity sanity (LONG: stop < entry < target; SHORT: stop > entry > target)
    const validLong = side === "LONG" && s < e && (!tValid || t > e);
    const validShort = side === "SHORT" && s > e && (!tValid || t < e);
    return { e, s, t: tValid ? t : undefined, riskPerShare, rewardPerShare, rr, qty, maxLoss, potentialGain, riskPctOfPrice, rewardPctOfPrice, rating, valid: validLong || validShort };
  }, [entry, stop, target, side, riskAmount]);

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm uppercase tracking-wider text-slate-500">Risk / Reward</div>
        {calc && calc.valid && (
          <div className={clsx("text-base font-bold", calc.rating.tone)}>
            R:R 1:{calc.rr.toFixed(2)} · {calc.rating.label}
          </div>
        )}
      </div>

      {calc && calc.valid && (
        <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-4">
          <Stat label="Risk %" value={`${calc.riskPctOfPrice.toFixed(2)}%`} tone="sell" />
          <Stat label="Reward %" value={calc.t ? `${calc.rewardPctOfPrice.toFixed(2)}%` : "—"} tone="buy" />
          <Stat label="Qty" value={`${calc.qty}`} />
          <Stat label="Max loss" value={fmtINR(calc.maxLoss, true).replace("+", "-")} tone="sell" />
          <Stat label="Potential gain" value={calc.t ? fmtINR(calc.potentialGain, true) : "—"} tone="buy" />
          <Stat label="Capital risked" value={fmtINR(riskAmount, false)} />
        </div>
      )}

      <div className="border-t border-bg-border pt-3">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Manual calculator</div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button onClick={() => setSide("LONG")} className={clsx("text-xs py-1.5 rounded-md border", side === "LONG" ? "border-accent-buy bg-accent-buy/10 text-accent-buy" : "border-bg-border text-slate-400")}>LONG</button>
          <button onClick={() => setSide("SHORT")} className={clsx("text-xs py-1.5 rounded-md border", side === "SHORT" ? "border-accent-sell bg-accent-sell/10 text-accent-sell" : "border-bg-border text-slate-400")}>SHORT</button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Input label="Entry" value={entry} onChange={setEntry} />
          <Input label="Stop" value={stop} onChange={setStop} />
          <Input label="Target" value={target} onChange={setTarget} />
        </div>
        {calc && !calc.valid && (
          <div className="text-[11px] text-accent-sell mt-2">
            Invalid setup — for LONG need stop &lt; entry &lt; target, for SHORT need stop &gt; entry &gt; target.
          </div>
        )}
      </div>

      <div className="mt-3 text-[10px] text-slate-500 leading-relaxed">
        Sized at {riskPct}% of ₹{capital.toLocaleString("en-IN")} capital. Adjust risk in Settings.
      </div>
    </motion.div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "buy" | "sell" }) {
  return (
    <div>
      <div className="text-slate-500">{label}</div>
      <div className={tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-slate-200"}>{value}</div>
    </div>
  );
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-[10px] text-slate-500 mb-0.5">{label}</span>
      <input
        type="number"
        step={0.01}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1 text-slate-200 font-mono text-xs outline-none focus:border-accent-info"
      />
    </label>
  );
}
