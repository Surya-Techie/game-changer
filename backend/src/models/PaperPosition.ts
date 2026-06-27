import { Schema, model, Types } from "mongoose";

/**
 * An OPEN paper position. When closed, the engine archives the closing
 * snapshot into a PaperTrade and deletes the PaperPosition document
 * (closed history lives in PaperTrade, not here).
 *
 * `currentPrice` / `unrealisedPnl` are kept in sync by the background
 * position manager every ~15s during market hours so the frontend can
 * render live MTM without hitting the price feed itself.
 *
 * `highWatermark` / `lowWatermark` drive trailing stops.
 * `maxAdverseExcursion` / `maxFavorableExcursion` are stored in price terms
 * (worst/best price reached against/for the position) and copied onto the
 * PaperTrade on close for journal analytics.
 */
const paperPositionSchema = new Schema(
  {
    accountId: { type: Types.ObjectId, ref: "PaperAccount", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    symbol: { type: String, required: true, index: true },
    direction: { type: String, enum: ["LONG", "SHORT"], required: true },
    qty: { type: Number, required: true, min: 1 },
    originalQty: { type: Number, required: true, min: 1 },
    avgEntryPrice: { type: Number, required: true },

    currentPrice: { type: Number },
    unrealisedPnl: { type: Number, default: 0 },

    stopLoss: { type: Number },
    takeProfit: { type: Number },
    trailingStopPct: { type: Number },

    highWatermark: { type: Number },
    lowWatermark: { type: Number },
    maxAdverseExcursion: { type: Number },
    maxFavorableExcursion: { type: Number },

    productType: { type: String, enum: ["MIS", "CNC"], default: "MIS", index: true },
    strategyTag: { type: String, default: "" },
    notes: { type: String, default: "" },

    // Snapshot of AI signal / Gainz Alpha composite / active premium
    // indicators at the moment of entry (Section 8 — flexible JSON).
    entrySignal: { type: Schema.Types.Mixed },

    openedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

// Common queries: "all open positions for this account", "this user's
// open positions for this symbol" (used when pyramiding / averaging).
paperPositionSchema.index({ accountId: 1, symbol: 1 });
paperPositionSchema.index({ userId: 1, symbol: 1 });

export const PaperPosition = model("PaperPosition", paperPositionSchema);
