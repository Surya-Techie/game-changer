import { Schema, model } from "mongoose";

/** Phase 11 — pattern confirmation layer attached to every signal. */
const patternConfirmationSchema = new Schema(
  {
    pattern_name: { type: String, required: true },
    grade: { type: String },
    direction: { type: String, enum: ["bullish", "bearish", "continuation", "neutral"] },
    confidence: { type: Number, min: 0, max: 100 },
    timeframe: { type: String },
    agrees: { type: Boolean },          // matched the AI signal direction
    delta: { type: Number, default: 0 }, // confidence delta applied (+0.08 / -0.05)
  },
  { _id: false }
);

const signalSchema = new Schema(
  {
    symbol: { type: String, required: true, index: true },
    action: { type: String, enum: ["BUY", "SELL", "HOLD"], required: true },
    confidence: { type: Number, required: true },
    price: { type: Number, required: true },
    suggestedEntry: { type: Number },
    suggestedStop: { type: Number },
    suggestedTarget: { type: Number },
    reason: { type: String, default: "" },
    indicators: { type: Schema.Types.Mixed, default: {} },
    // Phase 11 — Layer 6 result. Null when no high-confidence pattern was
    // detected at signal time, otherwise the best agreeing/conflicting pattern.
    pattern_confirmation: { type: patternConfirmationSchema, default: undefined },
    // Outcome tracking — populated by signalOutcomeTracker once the price
    // hits the stop or the target, or the signal ages out.
    outcome: {
      type: String,
      enum: ["PENDING", "WIN", "LOSS", "EXPIRED"],
      default: "PENDING",
      index: true,
    },
    outcomePrice: { type: Number },
    outcomeAt: { type: Date },
    createdAt: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false }
);

export const Signal = model("Signal", signalSchema);
