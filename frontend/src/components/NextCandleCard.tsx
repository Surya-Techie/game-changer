import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api } from "../lib/api";
import { TrendingUp, TrendingDown, Minus, RefreshCw, CandlestickChart, Clock, Zap } from "lucide-react";

/* ────────────────────────────────────────────────────────────────────── types */

interface PredictionData {
  ready: boolean;
  reason?: string;
  symbol: string;
  horizonBars: number;
  predictedReturnPct: number;
  predictedPrice: number;
  lastPrice: number;
  direction: "UP" | "DOWN" | "FLAT";
  confidence: number;
  ensemble?: { rf: number; gbm: number; mlp: number };
}

interface MiniCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  predicted?: boolean;
}

/* ─────────────────────────────────────────────── mini candlestick SVG chart */

function MiniCandleChart({ candles, predicted }: { candles: MiniCandle[]; predicted: MiniCandle | null }) {
  const all = predicted ? [...candles, predicted] : candles;
  if (all.length === 0) return null;

  const W = 280;
  const H = 100;
  const pad = 8;
  const barCount = all.length;
  const barWidth = Math.min(18, (W - pad * 2) / barCount - 4);
  const gap = ((W - pad * 2) - barWidth * barCount) / Math.max(1, barCount - 1);

  const allPrices = all.flatMap((c) => [c.o, c.h, c.l, c.c]);
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  const range = maxP - minP || 1;

  const scaleY = (v: number) => H - pad - ((v - minP) / range) * (H - pad * 2);
  const scaleX = (i: number) => pad + i * (barWidth + gap) + barWidth / 2;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* grid lines */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={pad}
          x2={W - pad}
          y1={pad + f * (H - pad * 2)}
          y2={pad + f * (H - pad * 2)}
          stroke="#1f2a3d"
          strokeWidth={0.5}
          strokeDasharray="3 3"
        />
      ))}

      {all.map((c, i) => {
        const isPred = !!c.predicted;
        const up = c.c >= c.o;
        const x = scaleX(i);
        const bodyTop = scaleY(Math.max(c.o, c.c));
        const bodyBot = scaleY(Math.min(c.o, c.c));
        const bodyH = Math.max(1.5, bodyBot - bodyTop);
        const wickTop = scaleY(c.h);
        const wickBot = scaleY(c.l);
        const fill = up ? "#16c784" : "#ea3943";
        const opacity = isPred ? 0.85 : 1;

        return (
          <g key={i} opacity={opacity}>
            {/* prediction glow */}
            {isPred && (
              <>
                <rect
                  x={x - barWidth / 2 - 4}
                  y={Math.min(wickTop, bodyTop) - 4}
                  width={barWidth + 8}
                  height={wickBot - Math.min(wickTop, bodyTop) + 8}
                  rx={4}
                  fill={up ? "rgba(22,199,132,0.08)" : "rgba(234,57,67,0.08)"}
                  stroke={up ? "rgba(22,199,132,0.25)" : "rgba(234,57,67,0.25)"}
                  strokeWidth={1}
                  strokeDasharray="3 2"
                >
                  <animate attributeName="opacity" values="0.5;1;0.5" dur="2s" repeatCount="indefinite" />
                </rect>
                {/* "PREDICTED" label */}
                <text
                  x={x}
                  y={Math.min(wickTop, bodyTop) - 8}
                  textAnchor="middle"
                  fontSize={7}
                  fill={up ? "#16c784" : "#ea3943"}
                  fontFamily="JetBrains Mono, monospace"
                  fontWeight="bold"
                >
                  NEXT
                </text>
              </>
            )}
            {/* wick */}
            <line x1={x} x2={x} y1={wickTop} y2={wickBot} stroke={fill} strokeWidth={1.2} />
            {/* body */}
            <rect
              x={x - barWidth / 2}
              y={bodyTop}
              width={barWidth}
              height={bodyH}
              fill={fill}
              rx={1.5}
            />
          </g>
        );
      })}
    </svg>
  );
}

/* ──────────────────────────────────────────── animated confidence ring */

function ConfidenceRing({ value, size = 56, direction }: { value: number; size?: number; direction: "UP" | "DOWN" | "FLAT" }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(value, 1));
  const color = direction === "UP" ? "#16c784" : direction === "DOWN" ? "#ea3943" : "#94a3b8";

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1f2a3d" strokeWidth={3} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: circ }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.2, ease: "easeOut" }}
          style={{ filter: `drop-shadow(0 0 4px ${color}40)` }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-bold font-mono" style={{ color }}>
          {Math.round(value * 100)}%
        </span>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────── main component */

interface Props {
  symbol: string;
  recentCandles?: Array<{ t: number; o: number; h: number; l: number; c: number }>;
}

export default function NextCandleCard({ symbol, recentCandles }: Props) {
  const [prediction, setPrediction] = useState<PredictionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const fetchPrediction = useCallback(async () => {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/api/prediction/${symbol}`);
      setPrediction(data as PredictionData);
      setLastFetch(Date.now());
    } catch (err) {
      setError("Prediction unavailable");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    void fetchPrediction();
    // Auto-refresh every 30 seconds
    timerRef.current = window.setInterval(() => {
      void fetchPrediction();
    }, 30_000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [fetchPrediction]);

  // Build mini candles from recent chart data (last 8 candles)
  const miniCandles: MiniCandle[] = useMemo(() => {
    if (!recentCandles || recentCandles.length === 0) return [];
    return recentCandles.slice(-8).map((c) => ({
      o: c.o,
      h: c.h,
      l: c.l,
      c: c.c,
    }));
  }, [recentCandles]);

  // Build predicted next candle from ML prediction
  const predictedCandle: MiniCandle | null = useMemo(() => {
    if (!prediction?.ready || !recentCandles || recentCandles.length === 0) return null;
    const last = recentCandles[recentCandles.length - 1];
    const predPrice = prediction.predictedPrice;
    const lastClose = last.c;

    // Estimate OHLC for the predicted candle based on typical volatility
    const recentHighs = recentCandles.slice(-10).map((c) => (c.h - c.c) / c.c);
    const recentLows = recentCandles.slice(-10).map((c) => (c.c - c.l) / c.c);
    const avgHighWick = recentHighs.reduce((a, b) => a + b, 0) / recentHighs.length;
    const avgLowWick = recentLows.reduce((a, b) => a + b, 0) / recentLows.length;

    const open = lastClose; // next bar opens near prior close
    const close = predPrice;
    const high = Math.max(open, close) * (1 + avgHighWick * 0.6);
    const low = Math.min(open, close) * (1 - avgLowWick * 0.6);

    return { o: open, h: high, l: low, c: close, predicted: true };
  }, [prediction, recentCandles]);

  const direction = prediction?.direction ?? "FLAT";
  const DirectionIcon = direction === "UP" ? TrendingUp : direction === "DOWN" ? TrendingDown : Minus;
  const dirColor = direction === "UP" ? "text-accent-buy" : direction === "DOWN" ? "text-accent-sell" : "text-slate-400";
  const dirBg = direction === "UP" ? "bg-accent-buy/8 border-accent-buy/20" : direction === "DOWN" ? "bg-accent-sell/8 border-accent-sell/20" : "bg-slate-800/40 border-slate-700/30";
  const changePct = prediction?.predictedReturnPct ?? 0;

  const timeSinceRefresh = useMemo(() => {
    if (!lastFetch) return "";
    const sec = Math.floor((Date.now() - lastFetch) / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    return `${Math.floor(sec / 60)}m ago`;
  }, [lastFetch]);

  // Not ready state
  if (!loading && prediction && !prediction.ready) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative rounded-2xl border border-bg-border bg-bg-panel backdrop-blur-glass shadow-glass overflow-hidden p-5"
      >
        <div className="flex items-center gap-2 mb-2">
          <CandlestickChart size={16} className="text-indigo-400" />
          <span className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Next Expected Candle</span>
        </div>
        <div className="text-xs text-slate-500">{prediction.reason ?? "ML model not trained — train first via the Prediction card."}</div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="relative rounded-2xl border border-bg-border bg-bg-panel backdrop-blur-glass shadow-glass overflow-hidden"
    >
      {/* Subtle top glow accent */}
      <div
        className={clsx(
          "absolute top-0 left-0 right-0 h-[2px]",
          direction === "UP" ? "bg-gradient-to-r from-transparent via-accent-buy/60 to-transparent"
            : direction === "DOWN" ? "bg-gradient-to-r from-transparent via-accent-sell/60 to-transparent"
            : "bg-gradient-to-r from-transparent via-slate-500/40 to-transparent"
        )}
      />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={clsx("p-1.5 rounded-lg border", dirBg)}>
              <CandlestickChart size={14} className={dirColor} />
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider leading-tight">Next Expected Candle</div>
              <div className="text-[10px] text-slate-500 font-mono flex items-center gap-1">
                <Clock size={9} />
                {prediction?.horizonBars ?? 5}-bar horizon
                {timeSinceRefresh && <span className="text-slate-600">· {timeSinceRefresh}</span>}
              </div>
            </div>
          </div>
          <button
            onClick={() => void fetchPrediction()}
            disabled={loading}
            className="text-slate-500 hover:text-white transition-colors disabled:opacity-30"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Loading state */}
        {loading && !prediction && (
          <div className="flex items-center justify-center py-8">
            <RefreshCw size={18} className="animate-spin text-indigo-400" />
            <span className="ml-2 text-xs text-slate-400">Fetching prediction…</span>
          </div>
        )}

        {/* Error state */}
        {error && !prediction && (
          <div className="text-xs text-slate-500 text-center py-6">{error}</div>
        )}

        {/* Main content */}
        {prediction?.ready && (
          <>
            {/* Direction + Price row */}
            <div className="flex items-center gap-4 mb-3">
              {/* Confidence ring */}
              <ConfidenceRing value={prediction.confidence} direction={direction} />

              {/* Stats */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <DirectionIcon size={18} className={dirColor} />
                  <span className={clsx("text-lg font-bold font-mono", dirColor)}>
                    {direction}
                  </span>
                  <span className={clsx(
                    "text-xs font-mono px-1.5 py-0.5 rounded border",
                    dirBg, dirColor
                  )}>
                    {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Current</span>
                    <span className="font-mono text-slate-300">₹{prediction.lastPrice.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Target</span>
                    <span className={clsx("font-mono font-semibold", dirColor)}>₹{prediction.predictedPrice.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Mini candlestick chart */}
            {miniCandles.length > 0 && (
              <div className="rounded-lg bg-[#0a0d12] border border-bg-border p-2 mb-3">
                <div className="flex items-center gap-1 mb-1 px-1">
                  <span className="text-[9px] uppercase tracking-wider text-slate-600 font-mono">Recent candles</span>
                  <span className="text-[9px] text-slate-600 font-mono">→</span>
                  <span className={clsx("text-[9px] uppercase tracking-wider font-mono font-bold", dirColor)}>
                    Predicted next
                  </span>
                </div>
                <MiniCandleChart candles={miniCandles} predicted={predictedCandle} />
              </div>
            )}

            {/* Ensemble breakdown */}
            {prediction.ensemble && (
              <div className="border-t border-bg-border pt-2.5">
                <div className="text-[9px] uppercase tracking-wider text-slate-600 font-mono mb-1.5 flex items-center gap-1">
                  <Zap size={9} />
                  Ensemble Models
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(["rf", "gbm", "mlp"] as const).map((key) => {
                    const val = prediction.ensemble![key];
                    const modelUp = val >= 0;
                    return (
                      <div
                        key={key}
                        className="rounded-md bg-bg-elevated/60 border border-bg-border px-2 py-1.5 text-center"
                      >
                        <div className="text-[9px] uppercase tracking-wider text-slate-500 font-mono">
                          {key === "rf" ? "Random Forest" : key === "gbm" ? "Gradient Boost" : "Neural Net"}
                        </div>
                        <div className={clsx(
                          "text-sm font-bold font-mono",
                          modelUp ? "text-accent-buy" : "text-accent-sell"
                        )}>
                          {modelUp ? "+" : ""}{val.toFixed(2)}%
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
