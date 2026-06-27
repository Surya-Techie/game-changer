import { Schema, model, Types } from "mongoose";

const ALERT_TYPES = [
  "PRICE_ABOVE",
  "PRICE_BELOW",
  "PRICE_CHANGE_PCT",
  "RSI_ABOVE",
  "RSI_BELOW",
  "MACD_CROSS_BULL",
  "MACD_CROSS_BEAR",
  "AI_SIGNAL_BUY",
  "AI_SIGNAL_SELL",
  "COMPOSITE_ABOVE",
  "COMPOSITE_BELOW",
  "VOLUME_SPIKE",
  "SUPERTREND_FLIP_BULL",
  "SUPERTREND_FLIP_BEAR",
  "INDICATOR_FORMULA",
  // Phase 11 — fires when patternEngine emits a 'pattern' event whose name
  // is in `patternNames` (or any pattern, if empty) AND confidence >= minConfidence.
  "PATTERN_ALERT",
] as const;

// Allowed indicators / operators / timeframes for INDICATOR_FORMULA alerts.
// The actual evaluation against ai-service /indicators/snapshot lives in
// alertWatcher.ts; we export these arrays so the frontend and the watcher
// share a single source of truth.
export const FORMULA_INDICATORS = [
  "RSI", "MACD", "EMA_20", "EMA_50", "SMA_200", "ADX", "ATR", "SUPERTREND", "VWAP", "OBV",
] as const;
export const FORMULA_OPERATORS = [
  "crosses_above", "crosses_below", "is_above", "is_below",
] as const;
export const FORMULA_TIMEFRAMES = ["M5", "M15", "H1", "D1"] as const;

const formulaConditionSchema = new Schema(
  {
    indicator: { type: String, enum: FORMULA_INDICATORS, required: true },
    operator: { type: String, enum: FORMULA_OPERATORS, required: true },
    // Either a literal number (e.g. 30) or another indicator name
    // (e.g. "EMA_50") for cross-indicator comparisons.
    rhs: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const alertSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    symbol: { type: String, required: true, index: true },
    type: { type: String, enum: ALERT_TYPES, required: true },
    value: { type: Number, required: false }, // threshold value (price, %, RSI, score, etc.)

    // INDICATOR_FORMULA fields. Conditions are AND-ed. timeframe controls
    // which indicator snapshot the watcher pulls from the ai-service.
    formula: { type: [formulaConditionSchema], default: undefined },
    formulaTimeframe: { type: String, enum: FORMULA_TIMEFRAMES, required: false },
    // Last evaluated values, keyed by indicator name. Used by the
    // watcher to detect "crosses" between ticks, and surfaced to the UI
    // so the user can see WHY an alert fired.
    lastFormulaValues: { type: Schema.Types.Mixed },

    // Phase 11 — PATTERN_ALERT fields. patternNames is an optional whitelist:
    // when empty, any pattern that meets the confidence threshold fires the
    // alert. patternDirections is the optional direction filter
    // (e.g. ["bullish"] to alert on long setups only).
    patternNames: { type: [String], default: undefined },
    patternMinConfidence: { type: Number, min: 0, max: 100, default: 75 },
    patternDirections: { type: [String], enum: ["bullish", "bearish", "continuation", "neutral"], default: undefined },
    patternTimeframes: { type: [String], enum: FORMULA_TIMEFRAMES, default: undefined },

    enabled: { type: Boolean, default: true },
    note: { type: String, default: "" },
    soundEnabled: { type: Boolean, default: true },
    triggerCount: { type: Number, default: 0 },
    lastTriggeredAt: { type: Date },
    lastTriggeredValue: { type: Number },
    history: {
      type: [
        {
          ts: { type: Date, default: () => new Date() },
          value: Number,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

export const Alert = model("Alert", alertSchema);
export const ALERT_TYPE_VALUES = ALERT_TYPES;
