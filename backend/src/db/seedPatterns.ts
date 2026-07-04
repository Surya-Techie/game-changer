import { Pattern } from "../models/Pattern.js";
import { logger } from "../utils/logger.js";

// Demo seeder so the Pattern Analytics dashboard renders meaningful charts
// in dev / in-mem-Mongo mode. Production ai-service is the authoritative
// writer of pattern docs, so the seed is gated to dev/empty collections.

const SYMBOLS = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "AXISBANK",
  "ICICIBANK", "SBIN", "ITC", "WIPRO", "LT",
  "BAJFINANCE", "MARUTI", "ASIANPAINT", "HCLTECH", "SUNPHARMA",
];

const TFS = ["M5", "M15", "H1", "D1"] as const;
type Direction = "bullish" | "bearish" | "continuation" | "neutral";
type Grade = "A+" | "A" | "B" | "C";

interface PatternSpec {
  name: string;
  direction: Direction;
  category: string;
  // Bias toward win/loss to give the leaderboard a real ranking.
  winBias: number;
}

const PATTERN_SPECS: PatternSpec[] = [
  { name: "Bullish Engulfing",       direction: "bullish",       category: "two_candle",       winBias: 0.68 },
  { name: "Bearish Engulfing",       direction: "bearish",       category: "two_candle",       winBias: 0.62 },
  { name: "Hammer",                  direction: "bullish",       category: "single_candle",    winBias: 0.55 },
  { name: "Shooting Star",           direction: "bearish",       category: "single_candle",    winBias: 0.52 },
  { name: "Morning Star",            direction: "bullish",       category: "three_candle",     winBias: 0.72 },
  { name: "Evening Star",            direction: "bearish",       category: "three_candle",     winBias: 0.66 },
  { name: "Doji",                    direction: "neutral",       category: "single_candle",    winBias: 0.42 },
  { name: "Three White Soldiers",    direction: "bullish",       category: "three_candle",     winBias: 0.74 },
  { name: "Three Black Crows",       direction: "bearish",       category: "three_candle",     winBias: 0.69 },
  { name: "Piercing Line",           direction: "bullish",       category: "two_candle",       winBias: 0.58 },
  { name: "Dark Cloud Cover",        direction: "bearish",       category: "two_candle",       winBias: 0.55 },
  { name: "Inverted Hammer",         direction: "bullish",       category: "single_candle",    winBias: 0.48 },
  { name: "Hanging Man",             direction: "bearish",       category: "single_candle",    winBias: 0.46 },
  { name: "Head and Shoulders",      direction: "bearish",       category: "western",          winBias: 0.71 },
  { name: "Inverse Head and Shoulders", direction: "bullish",    category: "western",          winBias: 0.73 },
  { name: "Double Top",              direction: "bearish",       category: "western",          winBias: 0.64 },
  { name: "Double Bottom",           direction: "bullish",       category: "western",          winBias: 0.66 },
  { name: "Bull Flag",               direction: "continuation",  category: "western",          winBias: 0.61 },
  { name: "Bear Flag",               direction: "continuation",  category: "western",          winBias: 0.58 },
  { name: "Ascending Triangle",      direction: "bullish",       category: "western",          winBias: 0.63 },
  { name: "Descending Triangle",     direction: "bearish",       category: "western",          winBias: 0.60 },
  { name: "Wyckoff Spring",          direction: "bullish",       category: "institutional",    winBias: 0.78 },
  { name: "Order Block Bullish",     direction: "bullish",       category: "institutional",    winBias: 0.70 },
  { name: "Order Block Bearish",     direction: "bearish",       category: "institutional",    winBias: 0.67 },
  { name: "Liquidity Sweep",         direction: "continuation",  category: "institutional",    winBias: 0.64 },
];

// Deterministic PRNG so the seed is reproducible across restarts.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gradeFor(confidence: number): Grade {
  if (confidence >= 90) return "A+";
  if (confidence >= 80) return "A";
  if (confidence >= 65) return "B";
  return "C";
}

export interface SeedOptions {
  totalDocs?: number;
  windowDays?: number;
}

/**
 * Seed realistic Pattern documents covering the last `windowDays` days so
 * the analytics dashboard has data to render. Confidence and outcome are
 * correlated: higher-confidence detections are more likely to resolve as
 * wins, which produces a meaningful calibration scatter.
 */
export async function seedPatternsIfEmpty(opts: SeedOptions = {}): Promise<number> {
  const totalDocs = opts.totalDocs ?? 720;
  const windowDays = opts.windowDays ?? 45;

  const existing = await Pattern.estimatedDocumentCount();
  if (existing > 0) {
    logger.info("Pattern seeder skipped — collection already populated", { existing });
    return 0;
  }

  const rng = mulberry32(20260519);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const docs: unknown[] = [];

  for (let i = 0; i < totalDocs; i++) {
    const spec = pick(PATTERN_SPECS);
    const symbol = pick(SYMBOLS);
    const timeframe = pick(TFS);

    // Confidence distribution skews high (the detector filters low-conf).
    const baseConf = 35 + Math.floor(rng() * 65); // 35..99
    const confidence_score = Math.min(99, Math.max(30, baseConf));

    // Outcome model: combine pattern-level win bias with confidence boost
    // so higher confidence ⇒ higher realised win rate (powers the calibration chart).
    const confBoost = (confidence_score - 50) / 200;   // -0.10..+0.245
    const winProb = Math.max(0.15, Math.min(0.92, spec.winBias + confBoost));

    const detected_at = new Date(now - rng() * windowMs);

    // ~30% remain pending; the rest resolve.
    const pendingDie = rng();
    let outcome: "pending" | "win" | "loss" | "breakeven";
    let resolved_at: Date | undefined;
    let exit_price: number | undefined;
    let risk_reward: number | undefined;

    const entry_price = 100 + rng() * 3500;
    const stopDist = entry_price * (0.005 + rng() * 0.02);
    const rrPlanned = 1 + rng() * 2.5;
    const target_price =
      spec.direction === "bearish"
        ? entry_price - stopDist * rrPlanned
        : entry_price + stopDist * rrPlanned;
    const stop_price =
      spec.direction === "bearish"
        ? entry_price + stopDist
        : entry_price - stopDist;

    if (pendingDie < 0.30 && detected_at.getTime() > now - 7 * 24 * 60 * 60 * 1000) {
      outcome = "pending";
    } else {
      const r = rng();
      if (r < winProb) outcome = "win";
      else if (r < winProb + 0.06) outcome = "breakeven";
      else outcome = "loss";

      const holdMs =
        timeframe === "M5"  ? (10 + rng() * 60)  * 60_000 :
        timeframe === "M15" ? (20 + rng() * 240) * 60_000 :
        timeframe === "H1"  ? (1  + rng() * 18)  * 3_600_000 :
                              (1  + rng() * 12)  * 24 * 3_600_000;
      resolved_at = new Date(Math.min(now, detected_at.getTime() + holdMs));

      if (outcome === "win") {
        const realised = rrPlanned * (0.8 + rng() * 0.7); // 0.8x..1.5x planned
        risk_reward = Number(realised.toFixed(2));
        exit_price = target_price;
      } else if (outcome === "loss") {
        risk_reward = -1;
        exit_price = stop_price;
      } else {
        risk_reward = 0;
        exit_price = entry_price;
      }
    }

    const grade = gradeFor(confidence_score);
    const volume_confirmation = rng() < 0.65;
    const trend_alignment = rng() < 0.55;
    const mtf_agreement = rng() < 0.45;

    docs.push({
      symbol,
      timeframe,
      pattern_name: spec.name,
      category: spec.category,
      direction: spec.direction,
      detected_at,
      candle_indices: [99 - Math.floor(rng() * 4), 99],
      confidence_score,
      grade,
      rule_strength: Number((0.4 + rng() * 0.6).toFixed(3)),
      ml_source: rng() < 0.7 ? "ensemble" : "rule_only",
      ml_probs: undefined,
      volume_confirmation,
      trend_alignment,
      mtf_agreement,
      entry_price: Number(entry_price.toFixed(2)),
      target_price: Number(target_price.toFixed(2)),
      stop_price: Number(stop_price.toFixed(2)),
      risk_reward,
      outcome,
      exit_price: exit_price ? Number(exit_price.toFixed(2)) : undefined,
      resolved_at,
      ai_explanation: "",
      description: "",
      historical_win_rate: Number(spec.winBias.toFixed(2)),
      score_reasoning: [],
    });
  }

  await Pattern.insertMany(docs, { ordered: false });
  logger.info("Pattern seeder inserted demo patterns", { count: docs.length, windowDays });
  return docs.length;
}
