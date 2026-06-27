import { Schema, model, InferSchemaType } from "mongoose";

import { PATTERN_TIMEFRAMES } from "./Pattern.js";

/**
 * CandleCache — OHLCV with pre-computed indicator values, used to avoid
 * recomputing indicators on every patternEngine tick.
 *
 * Lifecycle: documents auto-expire after 7 days via a TTL index on the
 * `timestamp` field. This keeps the collection bounded without a sweeper job.
 *
 * Uniqueness: (symbol, timeframe, timestamp) — a candle is identified by
 * its bar-open time. Repeated writes for the same bar (the partial bar
 * while it's still forming, then the final close) upsert in place.
 */

const indicatorBundleSchema = new Schema(
  {
    rsi: { type: Number },
    ema20: { type: Number },
    ema50: { type: Number },
    atr: { type: Number },
    adx: { type: Number },
    volume_ratio: { type: Number },
  },
  { _id: false }
);

const candleCacheSchema = new Schema(
  {
    symbol: { type: String, required: true, index: true },
    timeframe: { type: String, enum: PATTERN_TIMEFRAMES, required: true, index: true },
    timestamp: { type: Date, required: true, index: true }, // bar-open time

    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    volume: { type: Number, default: 0 },

    indicators: { type: indicatorBundleSchema, default: () => ({}) },
  },
  { versionKey: false }
);

// One row per bar. Upsert on (symbol, timeframe, timestamp).
candleCacheSchema.index({ symbol: 1, timeframe: 1, timestamp: 1 }, { unique: true });

// TTL: 7 days from `timestamp`. MongoDB's TTL monitor scans every 60s and
// deletes expired docs in batches — no cron job to maintain.
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
candleCacheSchema.index({ timestamp: 1 }, { expireAfterSeconds: SEVEN_DAYS_SECONDS });

export type CandleCacheDoc = InferSchemaType<typeof candleCacheSchema>;
export const CandleCache = model("CandleCache", candleCacheSchema);
