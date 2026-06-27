import { Schema, model, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: "" },
    role: { type: String, enum: ["USER", "ADMIN"], default: "USER", index: true },
    capital: { type: Number, default: 100000 },
    targetCapital: { type: Number, default: 200000 },
    riskPerTradePct: { type: Number, default: 1 },
    maxDailyLossPct: { type: Number, default: 3 },

    // 2FA
    twoFactorSecret: { type: String, default: null },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorRecoveryCodes: { type: [String], default: [] },

    // session metadata
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String },
  },
  { timestamps: true }
);

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: unknown };
export const User = model("User", userSchema);
