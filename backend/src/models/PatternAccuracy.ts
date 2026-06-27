import { Schema, model, InferSchemaType } from "mongoose";

import { PATTERN_TIMEFRAMES } from "./Pattern.js";

/**
 * PatternAccuracy — rolling win/loss/breakeven stats per pattern × timeframe.
 *
 * Written by both sides:
 *   • AI side (Python mongo_store.update_accuracy / resolve_pattern_outcome)
 *     after every feedback POST.
 *   • Node side (patternEngine in Phase 5) when it auto-resolves a pending
 *     pattern by watching for the target/stop price.
 *
 * Both use upsert with $inc semantics so concurrent writers from the two
 * services can't race each other.
 *
 * The Confidence Engine pulls win_rate from this collection (via the
 * winrate_overrides snapshot) and uses it to override the static baseline
 * once total_detected ≥ 10 — see ai-service/patterns/confidence_engine.py.
 */

const patternAccuracySchema = new Schema(
  {
    pattern_name: { type: String, required: true, index: true },
    timeframe: { type: String, enum: PATTERN_TIMEFRAMES, required: true, index: true },

    total_detected: { type: Number, default: 0, min: 0 },
    wins: { type: Number, default: 0, min: 0 },
    losses: { type: Number, default: 0, min: 0 },
    breakevens: { type: Number, default: 0, min: 0 },

    win_rate: { type: Number, default: 0, min: 0, max: 1, index: true },
    avg_rr: { type: Number, default: 0 },         // realised R-multiple
    avg_hold_bars: { type: Number, default: 0 },  // average bars from entry to exit

    last_updated: { type: Date, default: () => new Date() },
  },
  { versionKey: false }
);

// One row per (pattern_name, timeframe). The Python side relies on this for
// its upsert semantics, so the index MUST be unique.
patternAccuracySchema.index({ pattern_name: 1, timeframe: 1 }, { unique: true });

// Recompute the cached win_rate whenever wins / losses / breakevens change.
// This keeps the field consistent for callers that read it directly without
// re-deriving on read.
patternAccuracySchema.pre("save", function (next) {
  const wins = (this.get("wins") as number) ?? 0;
  const losses = (this.get("losses") as number) ?? 0;
  const breakevens = (this.get("breakevens") as number) ?? 0;
  const total = wins + losses + breakevens;
  if (total > 0) {
    this.set("win_rate", Number((wins / total).toFixed(4)));
    if ((this.get("total_detected") as number) < total) {
      // Self-heal in case total_detected drifts behind the components.
      this.set("total_detected", total);
    }
  }
  this.set("last_updated", new Date());
  next();
});

export type PatternAccuracyDoc = InferSchemaType<typeof patternAccuracySchema>;
export const PatternAccuracy = model("PatternAccuracy", patternAccuracySchema);
