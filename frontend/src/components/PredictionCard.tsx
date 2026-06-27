import { useEffect, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { api } from "../lib/api";

interface Prediction {
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
  model: {
    type: string;
    trainSamples: number;
    testSamples?: number;
    inSampleR2: number | null;
    outOfSampleR2?: number | null;
    directionAccuracyPct?: number | null;
    cvR2Mean?: number | null;
    cvR2Std?: number | null;
    trainedAt?: number;
    ageSec?: number;
    featureImportance: Record<string, number>;
  };
}

function ageLabel(sec?: number): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

export default function PredictionCard({ symbol }: { symbol: string }) {
  const [p, setP] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(false);
  const [training, setTraining] = useState(false);

  async function fetchPrediction() {
    if (!symbol) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/api/prediction/${symbol}`);
      setP(data as Prediction);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  async function retrain() {
    setTraining(true);
    try {
      await api.post(`/api/ml/train/${symbol}`);
      await fetchPrediction();
    } catch (err: any) {
      // 403 means not admin — surface helpful hint
      // eslint-disable-next-line no-alert
      alert(err?.response?.data?.error ?? "Train failed (admin only)");
    } finally { setTraining(false); }
  }

  useEffect(() => {
    let aborted = false;
    void fetchPrediction().then(() => { if (aborted) setP(null); });
    return () => { aborted = true; };
  }, [symbol]);

  if (loading && !p) {
    return (
      <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5 text-slate-400 text-sm">
        Loading ML prediction for {symbol}…
      </div>
    );
  }

  if (!p?.ready) {
    return (
      <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5">
        <div className="flex justify-between items-start mb-2">
          <div className="text-sm uppercase tracking-wider text-slate-500">ML Prediction</div>
          <button onClick={retrain} disabled={training} className="text-[10px] text-accent-info hover:text-white disabled:opacity-50">
            {training ? "Training…" : "Train model"}
          </button>
        </div>
        <div className="text-slate-400 text-sm">{p?.reason ?? "Not ready — train a model first."}</div>
      </div>
    );
  }

  const up = p.direction === "UP";
  const tone = up ? "text-accent-buy" : p.direction === "DOWN" ? "text-accent-sell" : "text-slate-300";

  const oosR2 = p.model.outOfSampleR2;
  const dirAcc = p.model.directionAccuracyPct;
  const cvMean = p.model.cvR2Mean;

  // Honest quality assessment of the trained model.
  const hasEdge = oosR2 != null && oosR2 > 0 && dirAcc != null && dirAcc > 53;
  const noEdge = oosR2 != null && oosR2 < -0.1;

  const fi = Object.entries(p.model.featureImportance)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5"
    >
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500">ML Prediction</div>
          <div className="text-xs text-slate-500">{p.model.type} · {p.horizonBars}-bar horizon · trained {ageLabel(p.model.ageSec)}</div>
        </div>
        <div className={clsx("font-bold text-lg", tone)}>{p.direction}</div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3 font-mono">
        <Stat label="Expected" value={`${p.predictedReturnPct >= 0 ? "+" : ""}${p.predictedReturnPct.toFixed(2)}%`} tone={tone} />
        <Stat label="Target" value={p.predictedPrice.toFixed(2)} />
        <Stat label="Confidence" value={`${(p.confidence * 100).toFixed(0)}%`} />
      </div>

      {/* ===== Honest model-quality metrics ===== */}
      <div className="border-t border-bg-border pt-3">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Model quality (out-of-sample)</div>
        <div className="grid grid-cols-3 gap-3 font-mono text-xs">
          <Stat
            label="OOS R²"
            value={oosR2 != null ? oosR2.toFixed(3) : "—"}
            tone={oosR2 != null ? (oosR2 > 0 ? "text-accent-buy" : "text-accent-sell") : undefined}
          />
          <Stat
            label="Dir accuracy"
            value={dirAcc != null ? `${dirAcc.toFixed(1)}%` : "—"}
            tone={dirAcc != null ? (dirAcc > 55 ? "text-accent-buy" : dirAcc < 50 ? "text-accent-sell" : "text-slate-200") : undefined}
          />
          <Stat
            label="CV R² mean"
            value={cvMean != null ? cvMean.toFixed(3) : "—"}
            tone={cvMean != null ? (cvMean > 0 ? "text-accent-buy" : "text-accent-sell") : undefined}
          />
        </div>
        <div className="text-[10px] text-slate-500 font-mono mt-1">
          n_train={p.model.trainSamples} · n_test={p.model.testSamples ?? "—"}
        </div>
        {p.ensemble && (
          <div className="mt-2 text-[10px] text-slate-500 font-mono">
            RF {p.ensemble.rf >= 0 ? "+" : ""}{p.ensemble.rf.toFixed(2)}% · GBM {p.ensemble.gbm >= 0 ? "+" : ""}{p.ensemble.gbm.toFixed(2)}% · MLP {p.ensemble.mlp >= 0 ? "+" : ""}{p.ensemble.mlp.toFixed(2)}%
          </div>
        )}

        {/* Honest interpretation banner */}
        {noEdge && (
          <div className="mt-2 text-[11px] text-accent-sell border border-accent-sell/30 bg-accent-sell/5 rounded px-2 py-1.5 leading-snug">
            ⚠ Negative OOS R² and ~50% direction accuracy. The model does not
            generalize on this data — predictions here are noise. Do not size
            trades based on this signal until trained on real broker ticks.
          </div>
        )}
        {hasEdge && (
          <div className="mt-2 text-[11px] text-accent-buy border border-accent-buy/30 bg-accent-buy/5 rounded px-2 py-1.5 leading-snug">
            ✓ OOS R² &gt; 0 and direction accuracy &gt; 53%. Mild but real signal.
          </div>
        )}
      </div>

      {/* Feature importance */}
      <div className="border-t border-bg-border pt-3 mt-3">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Top features (RandomForest importance)</div>
        <div className="space-y-1">
          {fi.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-xs">
              <span className="w-24 text-slate-400 truncate font-mono">{k}</span>
              <div className="flex-1 h-1.5 rounded bg-bg-elevated overflow-hidden">
                <div className="h-full bg-accent-info" style={{ width: `${Math.min(100, v * 400)}%` }} />
              </div>
              <span className="font-mono text-slate-300 w-12 text-right">{(v * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-bg-border pt-3 mt-3 flex items-center justify-between">
        <span className="text-[10px] text-slate-500">Re-train uses the last ~1000 candles + 70/30 walk-forward split.</span>
        <button onClick={retrain} disabled={training} className="text-[11px] text-accent-info hover:text-white disabled:opacity-50">
          {training ? "Training…" : "Retrain"}
        </button>
      </div>
    </motion.div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("text-base", tone ?? "text-slate-200")}>{value}</div>
    </div>
  );
}
