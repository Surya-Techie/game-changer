import clsx from "clsx";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";

export interface TopStockRow {
  symbol: string;
  name: string;
  sector?: string;
  price: number | null;
  changePct: number | null;
  compositeScore: number | null;
  recommendation: "STRONG BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG SELL" | null;
  confidence: number | null;
  trendSignal: -1 | 0 | 1 | null;
  reversionSignal: -1 | 0 | 1 | null;
  breakoutSignal: -1 | 0 | 1 | null;
  aiAction: "BUY" | "SELL" | "HOLD" | null;
  aiConfidence: number | null;
  aiReason?: string;
  mlDirection: "UP" | "DOWN" | "FLAT" | null;
  mlReturnPct: number | null;
  mlConfidence: number | null;
  pattern: { name: string; bias: "BULL" | "BEAR" | "NEUTRAL"; reliability: number } | null;
  rsi: number | null;
  adx: number | null;
  macdHist: number | null;
  sliderPct: number;
}

interface Props {
  rank: number;
  row: TopStockRow;
}

const BANDS = [
  { min: 0,  max: 25, label: "STRONG SELL", color: "#ea3943", glow: "rgba(234,57,67,0.5)" },
  { min: 25, max: 40, label: "SELL",        color: "#ea3943", glow: "rgba(234,57,67,0.3)" },
  { min: 40, max: 60, label: "HOLD",        color: "#94a3b8", glow: "rgba(148,163,184,0.3)" },
  { min: 60, max: 75, label: "BUY",         color: "#16c784", glow: "rgba(22,199,132,0.3)" },
  { min: 75, max:100, label: "STRONG BUY",  color: "#16c784", glow: "rgba(22,199,132,0.5)" },
];

function bandFor(score: number) {
  for (const b of BANDS) if (score >= b.min && score < b.max + (b.max === 100 ? 0.01 : 0)) return b;
  return BANDS[2]!;
}

export default function TopStockCard({ rank, row }: Props) {
  const nav = useNavigate();
  const score = row.compositeScore ?? row.sliderPct ?? 50;
  const band = bandFor(score);
  const changeUp = (row.changePct ?? 0) >= 0;

  // Highlight a band button when it matches the recommendation tone.
  const recoBand = row.recommendation === "STRONG BUY" ? 4
                 : row.recommendation === "BUY" ? 3
                 : row.recommendation === "NEUTRAL" ? 2
                 : row.recommendation === "SELL" ? 1
                 : row.recommendation === "STRONG SELL" ? 0
                 : 2;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
      onClick={() => nav(`/?symbol=${row.symbol}`)}
      className="cursor-pointer rounded-xl border bg-bg-panel-solid/70 backdrop-blur-glass hover:border-accent-info/50 transition-colors overflow-hidden"
      style={{ borderColor: `${band.color}40`, boxShadow: `0 0 24px -12px ${band.glow}` }}
    >
      {/* ----- header ----- */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <span className="font-mono text-[10px] text-slate-500 w-6">#{rank}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <div className="text-base font-bold text-white truncate">{row.symbol}</div>
            {row.sector && (
              <span className="text-[10px] text-slate-500 uppercase tracking-wider">{row.sector}</span>
            )}
          </div>
          <div className="text-[11px] text-slate-400 truncate">{row.name}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm tabular-nums text-white">
            ₹{row.price?.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}
          </div>
          {row.changePct != null && (
            <div className={clsx("text-[11px] font-mono", changeUp ? "text-accent-buy" : "text-accent-sell")}>
              {changeUp ? "+" : ""}{row.changePct.toFixed(2)}%
            </div>
          )}
        </div>
      </div>

      {/* ----- recommendation slider (5-position segmented bar) ----- */}
      <div className="px-4 pb-2">
        <div className="grid grid-cols-5 gap-0.5 rounded-md overflow-hidden text-[9px] font-bold uppercase tracking-wider">
          {BANDS.map((b, i) => {
            const active = i === recoBand;
            return (
              <div
                key={b.label}
                className={clsx(
                  "py-1 text-center transition-colors",
                  active ? "text-white" : "text-slate-600 bg-bg-elevated/40"
                )}
                style={active ? { background: b.color, boxShadow: `0 0 12px -4px ${b.glow}` } : undefined}
              >
                {b.label.split(" ").join(" ")}
              </div>
            );
          })}
        </div>
        {/* Score indicator dot below the slider showing exact position */}
        <div className="relative mt-1 h-1.5 rounded-full bg-bg-elevated overflow-hidden">
          <div
            className="absolute top-0 h-full rounded-full"
            style={{
              left: 0, width: `${Math.max(0, Math.min(100, score))}%`,
              background: `linear-gradient(90deg, #ea3943 0%, #f0b90b 40%, #f0b90b 60%, #16c784 100%)`,
              opacity: 0.45,
            }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full ring-2 ring-bg-panel-solid"
            style={{ left: `${Math.max(0, Math.min(100, score))}%`, background: band.color }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[9px] font-mono text-slate-600">
          <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
        </div>
      </div>

      {/* ----- stats grid ----- */}
      <div className="px-4 pb-3 pt-1 grid grid-cols-3 gap-x-2 gap-y-1 text-[11px] font-mono">
        <Cell label="Composite" value={score.toFixed(0)} tone={band.color} />
        <Cell label="Confidence" value={row.confidence != null ? `${Math.round(row.confidence * 100)}%` : "—"} />
        <Cell label="AI" value={row.aiAction ?? "—"} tone={row.aiAction === "BUY" ? "#16c784" : row.aiAction === "SELL" ? "#ea3943" : undefined} />
        <Cell label="RSI" value={row.rsi != null ? row.rsi.toFixed(0) : "—"} tone={row.rsi != null ? (row.rsi >= 70 ? "#ea3943" : row.rsi <= 30 ? "#16c784" : undefined) : undefined} />
        <Cell label="ADX" value={row.adx != null ? row.adx.toFixed(0) : "—"} />
        <Cell label="MACD" value={row.macdHist != null ? (row.macdHist >= 0 ? "+" : "") + row.macdHist.toFixed(2) : "—"} tone={row.macdHist != null ? (row.macdHist >= 0 ? "#16c784" : "#ea3943") : undefined} />
      </div>

      {/* ----- ML + pattern footer ----- */}
      <div className="px-4 pb-3 pt-1 border-t border-bg-border/40 flex flex-wrap items-center gap-2 text-[10px]">
        {row.mlDirection && (
          <Badge label="ML" tone={row.mlDirection === "UP" ? "buy" : row.mlDirection === "DOWN" ? "sell" : "neutral"}>
            {row.mlDirection} {row.mlReturnPct != null ? `${row.mlReturnPct >= 0 ? "+" : ""}${row.mlReturnPct.toFixed(2)}%` : ""}
            {row.mlConfidence != null && <span className="text-slate-500 ml-1">({Math.round(row.mlConfidence * 100)}%)</span>}
          </Badge>
        )}
        {row.pattern && (
          <Badge label="Pattern" tone={row.pattern.bias === "BULL" ? "buy" : row.pattern.bias === "BEAR" ? "sell" : "neutral"}>
            {row.pattern.name} ({Math.round(row.pattern.reliability * 100)}%)
          </Badge>
        )}
        {row.trendSignal != null && (
          <Badge label="Trend" tone={row.trendSignal > 0 ? "buy" : row.trendSignal < 0 ? "sell" : "neutral"}>
            {row.trendSignal > 0 ? "↑" : row.trendSignal < 0 ? "↓" : "→"}
          </Badge>
        )}
        {row.breakoutSignal != null && row.breakoutSignal !== 0 && (
          <Badge label="Breakout" tone={row.breakoutSignal > 0 ? "buy" : "sell"}>
            {row.breakoutSignal > 0 ? "UP" : "DOWN"}
          </Badge>
        )}
      </div>
    </motion.div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="tabular-nums" style={tone ? { color: tone } : { color: "#e2e8f0" }}>{value}</span>
    </div>
  );
}

function Badge({ label, tone, children }: { label: string; tone: "buy" | "sell" | "neutral"; children: React.ReactNode }) {
  const cls = tone === "buy" ? "bg-accent-buy/15 text-accent-buy" : tone === "sell" ? "bg-accent-sell/15 text-accent-sell" : "bg-slate-500/15 text-slate-300";
  return (
    <span className={clsx("inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono", cls)}>
      <span className="text-[9px] opacity-60">{label}</span>
      <span className="font-semibold">{children}</span>
    </span>
  );
}
