import { Schema, model, Types } from "mongoose";

const tradeSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    positionId: { type: Types.ObjectId, ref: "Position", required: true },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ["LONG", "SHORT"], required: true },
    qty: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    entryAt: { type: Date, required: true },
    exitAt: { type: Date, required: true },
    exitReason: {
      type: String,
      enum: ["SL", "TP", "TRAIL", "PARTIAL_TP", "MANUAL", "FLIP"],
      required: true,
    },
    pnl: { type: Number, required: true },
    pnlPct: { type: Number, required: true },
    durationMs: { type: Number, required: true },

    // Trade journal extensions (Item 16).
    note: { type: String, default: "" },
    tags: {
      type: [String],
      default: [],
      validate: (arr: string[]) => arr.length <= 10,
    },
  },
  { timestamps: true }
);

export const Trade = model("Trade", tradeSchema);
