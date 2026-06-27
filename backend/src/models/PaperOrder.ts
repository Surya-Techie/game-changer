import { Schema, model, Types } from "mongoose";

/**
 * A paper order. Covers four order types:
 *   MARKET     — fills immediately at LTP +/- slippage
 *   LIMIT      — fills when price touches limitPrice
 *   SL_MARKET  — triggers at triggerPrice, then fills at market (gap slippage)
 *   SL_LIMIT   — triggers at triggerPrice, then becomes a LIMIT @ limitPrice
 *
 * `side` is BUY/SELL to match the existing Order model and standard
 * broker terminology. The UI's LONG/SHORT toggle maps to BUY (open long)
 * / SELL (open short, intraday short-sell). Pending orders are
 * open-only — position closes go through POST /positions/:id/close and
 * do NOT create a PaperOrder.
 *
 * `stopLoss` / `takeProfit` / `trailingStopPct` are *bracket* parameters:
 * they are carried over to the PaperPosition when this order fills.
 *
 * `filledPositionId` is populated on fill so the journal can link an
 * order back to the position it opened.
 *
 * Status transitions:
 *   PENDING  -> FILLED | CANCELLED | EXPIRED | REJECTED
 *   QUEUED   -> PENDING (when market opens) | CANCELLED
 */
const paperOrderSchema = new Schema(
  {
    accountId: { type: Types.ObjectId, ref: "PaperAccount", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    symbol: { type: String, required: true, index: true },

    side: { type: String, enum: ["BUY", "SELL"], required: true },
    orderType: {
      type: String,
      enum: ["MARKET", "LIMIT", "SL_MARKET", "SL_LIMIT"],
      required: true,
    },
    qty: { type: Number, required: true, min: 1 },
    limitPrice: { type: Number },
    triggerPrice: { type: Number },

    // Bracket params — applied to the resulting PaperPosition on fill.
    stopLoss: { type: Number },
    takeProfit: { type: Number },
    trailingStopPct: { type: Number },

    productType: { type: String, enum: ["MIS", "CNC"], default: "MIS" },
    validity: { type: String, enum: ["DAY", "IOC", "GTC"], default: "DAY" },

    status: {
      type: String,
      enum: ["PENDING", "QUEUED", "FILLED", "CANCELLED", "REJECTED", "EXPIRED"],
      default: "PENDING",
      index: true,
    },
    rejectReason: { type: String },

    filledAt: { type: Date },
    filledPrice: { type: Number },
    filledPositionId: { type: Types.ObjectId, ref: "PaperPosition" },

    strategyTag: { type: String, default: "" },
    // Snapshot of AI signal / composite / indicators at order placement —
    // copied to the resulting PaperPosition on fill (Section 8).
    entrySignal: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// "All pending orders for account" — the most common query.
paperOrderSchema.index({ accountId: 1, status: 1 });
// "Pending orders for symbol X across all users" — used by the price-feed
// tick handler when deciding which symbols to keep polling.
paperOrderSchema.index({ symbol: 1, status: 1 });

export const PaperOrder = model("PaperOrder", paperOrderSchema);
