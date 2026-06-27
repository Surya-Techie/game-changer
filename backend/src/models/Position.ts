import { Schema, model, Types } from "mongoose";

const positionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ["LONG", "SHORT"], required: true },
    qty: { type: Number, required: true },
    originalQty: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    entryAt: { type: Date, default: () => new Date() },
    initialStopPrice: { type: Number },
    stopPrice: { type: Number },
    targetPrice: { type: Number },
    status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN", index: true },
    exitPrice: { type: Number },
    exitAt: { type: Date },
    exitReason: { type: String, enum: ["SL", "TP", "TRAIL", "PARTIAL_TP", "MANUAL", "FLIP", null], default: null },
    realisedPnl: { type: Number, default: 0 },
    sourceSignalId: { type: Types.ObjectId, ref: "Signal" },

    // Tracking for trailing stop + partial TP
    highWatermark: { type: Number },
    lowWatermark: { type: Number },
    partialTpDone: { type: Boolean, default: false },
    trailingPct: { type: Number },
  },
  { timestamps: true }
);

export const Position = model("Position", positionSchema);
