import { Schema, model, Types } from "mongoose";

// Persisted dashboard chart layout — drawings + overlay toggles per
// (user, symbol). Capped at 5 layouts per (user, symbol) by the route
// layer. The `data` blob is opaque to the backend; the frontend owns
// the shape (DrawingShape[] + activeOverlays[]).
//
// We deliberately do NOT validate `data` past a size cap — overlay
// definitions evolve quickly on the client and a strict schema would
// break older layouts on every redesign.

const chartLayoutSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    symbol: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    data: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

chartLayoutSchema.index({ userId: 1, symbol: 1, name: 1 }, { unique: true });

export const ChartLayout = model("ChartLayout", chartLayoutSchema);
