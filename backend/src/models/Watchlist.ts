import { Schema, model, Types } from "mongoose";

const watchlistSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, default: "Default" },
    symbols: { type: [String], default: [] },
  },
  { timestamps: true }
);

export const Watchlist = model("Watchlist", watchlistSchema);
