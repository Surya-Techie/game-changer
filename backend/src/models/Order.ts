import { Schema, model, Types } from "mongoose";

const orderSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    qty: { type: Number, required: true },
    type: { type: String, enum: ["MARKET", "LIMIT"], default: "MARKET" },
    limitPrice: { type: Number },
    status: {
      type: String,
      enum: ["PENDING", "FILLED", "REJECTED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    filledPrice: { type: Number },
    filledAt: { type: Date },
    rejectReason: { type: String },
    sourceSignalId: { type: Types.ObjectId, ref: "Signal" },
    source: { type: String, enum: ["MANUAL", "AUTO"], default: "AUTO" },
  },
  { timestamps: true }
);

export const Order = model("Order", orderSchema);
