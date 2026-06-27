import { Schema, model, Types } from "mongoose";

/**
 * A virtual brokerage account used exclusively for paper (simulated) trading.
 * Fully isolated from the user's real AccountState / auto-trader state.
 *
 * A user can own up to 3 paper accounts ("Conservative", "Aggressive", ...).
 * Exactly one is `isActive` at any time — the partial unique index below
 * enforces that invariant at the database level.
 *
 * `currentCash` is the authoritative cash balance and is mutated
 * transactionally on every fill / position close. Equity and marginUsed
 * are derived at read-time from currentCash + open positions (not cached
 * here, to avoid drift bugs).
 */
const paperAccountSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    startingCapital: { type: Number, required: true, min: 10_000 },
    currentCash: { type: Number, required: true },
    isActive: { type: Boolean, default: false, index: true },
    resetAt: { type: Date },
  },
  { timestamps: true }
);

// One active paper account per user. Mongoose translates this into a
// partial unique index in MongoDB.
paperAccountSchema.index(
  { userId: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

export const PaperAccount = model("PaperAccount", paperAccountSchema);
