import { Schema, model, Types, InferSchemaType } from "mongoose";

/**
 * Pattern — every detected chart pattern.
 *
 * The AI service (Phase 3 mongo_store.save_pattern) writes documents in this
 * shape; the Node backend (Phase 5 patternEngine) reads them for the
 * WebSocket fan-out and the Analytics page. The schema is permissive on the
 * nested objects (score_breakdown, ml_probs, filters) so additions on the
 * Python side don't require a Mongoose migration.
 */

export const PATTERN_DIRECTIONS = ["bullish", "bearish", "continuation", "neutral"] as const;
export const PATTERN_OUTCOMES = ["pending", "win", "loss", "breakeven"] as const;
export const PATTERN_GRADES = ["A+", "A", "B", "C"] as const;
export const PATTERN_TIMEFRAMES = ["M5", "M15", "H1", "D1"] as const;
export const PATTERN_CATEGORIES = [
  "single_candle", "two_candle", "three_candle", "multi_candle", "western", "institutional",
] as const;

const trendlinePointSchema = new Schema(
  {
    time: { type: Number, required: true }, // epoch ms (or positional index when no time series available)
    price: { type: Number, required: true },
  },
  { _id: false }
);

const patternSchema = new Schema(
  {
    // Identity.
    symbol: { type: String, required: true, index: true },
    timeframe: { type: String, enum: PATTERN_TIMEFRAMES, required: true, index: true },
    pattern_name: { type: String, required: true, index: true },
    category: { type: String, enum: PATTERN_CATEGORIES },
    direction: { type: String, enum: PATTERN_DIRECTIONS, required: true, index: true },

    // Detection geometry.
    detected_at: { type: Date, default: () => new Date(), index: true },
    candle_indices: { type: [Number], default: [] },

    // Scoring (from confidence_engine).
    confidence_score: { type: Number, required: true, min: 0, max: 100, index: true },
    grade: { type: String, enum: PATTERN_GRADES, index: true },
    rule_strength: { type: Number, min: 0, max: 1 },

    // ML provenance (sklearn ensemble — we keep generic names so the future
    // TF model swap doesn't require a migration). Probabilities sum to ~1.
    ml_source: { type: String, enum: ["ensemble", "rule_only"], default: "rule_only" },
    ml_probs: { type: Schema.Types.Mixed, default: undefined }, // { no_move, bullish_move, bearish_move, gb_probs?, mlp_probs? }
    ml_gb_prob: { type: Number, min: 0, max: 1 },               // probability of the agreeing class — GB model
    ml_mlp_prob: { type: Number, min: 0, max: 1 },              // probability of the agreeing class — MLP model

    // Filter outcomes (booleans derived from score_breakdown for quick query).
    volume_confirmation: { type: Boolean, default: false, index: true },
    trend_alignment: { type: Boolean, default: false, index: true },
    mtf_agreement: { type: Boolean, default: false, index: true },

    // Trade plan (Western + institutional patterns).
    entry_price: { type: Number },
    target_price: { type: Number },
    stop_price: { type: Number },
    risk_reward: { type: Number },
    trendline_points: { type: [trendlinePointSchema], default: [] },

    // Outcome tracking — set by patternEngine.resolvePending() in Phase 5.
    outcome: { type: String, enum: PATTERN_OUTCOMES, default: "pending", index: true },
    exit_price: { type: Number },
    resolved_at: { type: Date },

    // Explanation (Phase 9) + raw breakdowns for the UI panel.
    ai_explanation: { type: String, default: "" },
    description: { type: String, default: "" },
    score_breakdown: { type: Schema.Types.Mixed, default: undefined },
    score_reasoning: { type: [String], default: [] },
    filters: { type: Schema.Types.Mixed, default: undefined },

    historical_win_rate: { type: Number, min: 0, max: 1 },

    // Optional ownership (only set for backtest-derived patterns).
    userId: { type: Types.ObjectId, ref: "User", index: true, required: false },
  },
  { versionKey: false }
);

// Hot query paths:
//  • patternEngine resolvePending → outcome=pending sorted by detected_at
//  • PatternPanel sidebar         → (symbol, detected_at desc)
//  • Scanner / Analytics          → (timeframe, confidence_score desc)
patternSchema.index({ symbol: 1, detected_at: -1 });
patternSchema.index({ pattern_name: 1, timeframe: 1, detected_at: -1 });
patternSchema.index({ outcome: 1, detected_at: -1 });
patternSchema.index({ timeframe: 1, confidence_score: -1 });

// Derive the boolean filter flags from score_breakdown on save, so callers
// inserting documents from the AI side don't need to remember to set them.
patternSchema.pre("save", function (next) {
  const breakdown = (this.get("score_breakdown") as { volume?: number; trend?: number; mtf?: number } | undefined) ?? undefined;
  if (breakdown) {
    if (this.get("volume_confirmation") == null) this.set("volume_confirmation", (breakdown.volume ?? 0) > 0);
    if (this.get("trend_alignment") == null) this.set("trend_alignment", (breakdown.trend ?? 0) > 0);
    if (this.get("mtf_agreement") == null) this.set("mtf_agreement", (breakdown.mtf ?? 0) > 0);
  }
  next();
});

export type PatternDoc = InferSchemaType<typeof patternSchema>;
export const Pattern = model("Pattern", patternSchema);
