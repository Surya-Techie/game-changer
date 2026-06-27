import { Schema, model, Types } from "mongoose";

/**
 * A CLOSED paper trade — append-only audit + journal record.
 *
 * Created when a PaperPosition is fully or partially closed. Stores
 * everything needed for analytics (P&L, brokerage, MAE/MFE, hold
 * duration, entry signal snapshot) and everything needed for the
 * journal (manual reflection fields filled in after the fact).
 *
 * Partial closes produce one PaperTrade per partial fill; the original
 * PaperPosition stays open with the remaining qty until fully closed.
 */
const paperTradeSchema = new Schema(
  {
    accountId: { type: Types.ObjectId, ref: "PaperAccount", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    symbol: { type: String, required: true, index: true },
    direction: { type: String, enum: ["LONG", "SHORT"], required: true },
    qty: { type: Number, required: true, min: 1 },

    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    entryTime: { type: Date, required: true },
    exitTime: { type: Date, required: true },
    holdDurationMins: { type: Number, required: true },

    grossPnl: { type: Number, required: true },
    brokerage: { type: Number, required: true, default: 0 },
    netPnl: { type: Number, required: true },
    pnlPct: { type: Number, required: true },
    rMultiple: { type: Number },

    exitReason: {
      type: String,
      enum: [
        "MANUAL",
        "SL",
        "TP",
        "TRAILING",
        "SIGNAL_FLIP",
        "AUTO_SQUAREOFF_EOD",
        "PARTIAL_MANUAL",
      ],
      required: true,
    },

    productType: { type: String, enum: ["MIS", "CNC"], default: "MIS" },

    maxAdverseExcursion: { type: Number },
    maxFavorableExcursion: { type: Number },

    // Snapshot of AI signal / Gainz Alpha composite / indicators at entry.
    entrySignal: { type: Schema.Types.Mixed },

    // Auto-classification.
    strategyTag: { type: String, default: "" },

    // Manual journal fields (Section 5). All start blank and can be edited
    // post-hoc via PATCH /api/paper/trades/:id.
    preTradePlan: { type: String, default: "" },
    mistake: { type: String, default: "" },
    lesson: { type: String, default: "" },
    notes: { type: String, default: "" },
    executionStars: { type: Number, min: 0, max: 5, default: 0 },
    emotionTagEntry: {
      type: String,
      enum: ["", "Calm", "Confident", "FOMO", "Anxious", "Revenge", "Bored", "Excited"],
      default: "",
    },
    emotionTagExit: {
      type: String,
      enum: ["", "Calm", "Confident", "FOMO", "Anxious", "Revenge", "Bored", "Excited"],
      default: "",
    },
    qualityTag: {
      type: String,
      enum: ["", "A+", "A", "B", "C", "Mistake"],
      default: "",
    },
    setupType: {
      type: String,
      enum: ["", "Trend", "Breakout", "Reversion", "Scalp", "News", "Other"],
      default: "",
    },
    // Base64-encoded chart screenshot (optional, capped client-side to
    // ~500KB before upload to avoid bloating the doc).
    screenshot: { type: String, default: "" },
  },
  { timestamps: true }
);

// Common queries: account + chronological, account + symbol filter,
// account + exit-day filter (for "today's trades" tab).
paperTradeSchema.index({ accountId: 1, exitTime: -1 });
paperTradeSchema.index({ accountId: 1, symbol: 1, exitTime: -1 });

export const PaperTrade = model("PaperTrade", paperTradeSchema);
