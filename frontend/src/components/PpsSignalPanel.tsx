import clsx from "clsx";
import { PATTERN_LABEL, type PpsSignal } from "../lib/ppsApi";

/**
 * Card showing the LATEST actionable signal. Shows HOLD-style placeholder
 * when no actionable signal exists in the visible window.
 */

interface Props {
  signal: PpsSignal | null;
}

/** Returns ($ distance, %) tuple for a stop or target relative to entry. */
function distance(entry: number, level: number): { abs: number; pct: number } {
  return { abs: level - entry, pct: ((level - entry) / entry) * 100 };
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("font-mono text-sm", tone ?? "text-slate-200")}>{value}</div>
    </div>
  );
}

export default function PpsSignalPanel({ signal }: Props) {
  if (!signal || signal.signal === "HOLD") {
    return (
      <div className="bg-bg-panel border border-bg-border rounded-xl p-5">
        <div className="text-sm uppercase tracking-wider text-slate-500 mb-2">Latest PPS signal</div>
        <div className="flex items-center gap-3">
          <span className="px-3 py-1 rounded text-xs bg-slate-500/15 text-slate-300 border border-slate-500/40 font-medium">HOLD</span>
          <span className="text-slate-400 text-sm">
            {signal?.trend_aligned ? "Trend aligned but no setup detected." : "Trend filter not aligned — no signals."}
          </span>
        </div>
      </div>
    );
  }

  const isBuy = signal.signal === "BUY";
  const badgeCls = isBuy
    ? "bg-accent-buy/15 text-accent-buy border-accent-buy/40"
    : "bg-accent-sell/15 text-accent-sell border-accent-sell/40";

  const entry = signal.entry_price ?? 0;
  const stop = signal.stop_loss ?? 0;
  const target = signal.target_price ?? 0;
  const dStop = distance(entry, stop);
  const dTgt = distance(entry, target);
  const rr = signal.risk_reward ?? 0;
  const confPct = signal.confidence * 100;

  return (
    <div className="bg-bg-panel border border-bg-border rounded-xl p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500">Latest PPS signal</div>
          <div className="text-xs text-slate-500 mt-0.5">{signal.date}</div>
        </div>
        <span className={clsx("px-3 py-1 rounded text-xs font-medium border", badgeCls)}>{signal.signal}</span>
      </div>

      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Pattern</div>
        <div className="text-base text-slate-100">{signal.pattern ? PATTERN_LABEL[signal.pattern] : "—"}</div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="Entry" value={entry.toFixed(2)} />
        <Stat
          label="Stop"
          tone="text-accent-sell"
          value={`${stop.toFixed(2)}  (${dStop.abs >= 0 ? "+" : ""}${dStop.abs.toFixed(2)})`}
        />
        <Stat
          label="Target (3R)"
          tone="text-accent-buy"
          value={`${target.toFixed(2)}  (${dTgt.abs >= 0 ? "+" : ""}${dTgt.abs.toFixed(2)})`}
        />
        <Stat label="R:R" value={`${rr.toFixed(2)} : 1`} />
      </div>

      {/* Confidence bar */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Confidence</span>
          <span className="text-xs text-slate-300 font-mono">{confPct.toFixed(0)}%</span>
        </div>
        <div className="h-2 bg-bg-bg/70 rounded overflow-hidden">
          <div
            className={clsx(
              "h-full transition-all",
              confPct >= 70 ? "bg-accent-buy" : confPct >= 50 ? "bg-amber-400" : "bg-slate-500"
            )}
            style={{ width: `${Math.min(100, Math.max(0, confPct))}%` }}
          />
        </div>
      </div>

      {/* Trend status */}
      <div className="text-xs flex items-center gap-2">
        {signal.trend_aligned ? (
          <span className="text-accent-buy">✅ Trend aligned (40/18 SMA + price)</span>
        ) : (
          <span className="text-accent-sell">❌ Trend not aligned</span>
        )}
      </div>
    </div>
  );
}
