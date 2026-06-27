import { Schema, model, Types } from "mongoose";

/**
 * One doc per user. Mutable state that the trading engine reads/writes.
 */
const accountStateSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, unique: true },
    autoTradeMode: { type: String, enum: ["OFF", "SEMI", "AUTO"], default: "AUTO" },
    killSwitch: { type: Boolean, default: false },
    dailyPnl: { type: Number, default: 0 },
    dailyPnlDate: { type: String, default: "" },
    realisedPnl: { type: Number, default: 0 },
    openPositionCount: { type: Number, default: 0 },
    minConfidence: { type: Number, default: 0.55 },
    maxOpenPositions: { type: Number, default: 3 },
    maxDailyLossPct: { type: Number, default: 3 },
    riskPerTradePct: { type: Number, default: 1 },

    // Strategy toggles
    stopMode: { type: String, enum: ["ATR", "FIXED_PCT"], default: "ATR" },
    stopPct: { type: Number, default: 2.0 }, // used when stopMode = FIXED_PCT
    targetRR: { type: Number, default: 2.0 }, // take-profit at this multiple of stop distance
    trailingStopEnabled: { type: Boolean, default: false },
    trailingStopPct: { type: Number, default: 1.0 },
    partialTpEnabled: { type: Boolean, default: false },
    regimeFilterEnabled: { type: Boolean, default: false },
    regimeMinAdx: { type: Number, default: 18 },
    mtfConfirmation: { type: Boolean, default: false },

    // UI / data prefs (Item 19)
    theme: { type: String, enum: ["dark", "light"], default: "dark" },
    autoRefreshSec: { type: Number, default: 60 }, // 30 / 60 / 300 / 0 (manual)
    brokerageFlat: { type: Number, default: 20 },
    brokeragePct: { type: Number, default: 0.03 },
    taxStcgPct: { type: Number, default: 15 },
    scannerUniverse: { type: String, default: "watchlist" }, // 'watchlist' | 'nifty50' | 'nifty100'
    notificationPrefs: {
      type: {
        signal: { type: Boolean, default: true },
        fill: { type: Boolean, default: true },
        exit: { type: Boolean, default: true },
        alert: { type: Boolean, default: true },
        system: { type: Boolean, default: true },
        // Paper-trading channel granularity. When any of these are
        // false the corresponding paper event is dropped before reaching
        // the WebSocket layer (see notifierBridge.ts).
        paperFill: { type: Boolean, default: true },
        paperSlTp: { type: Boolean, default: true },
        paperSqOff: { type: Boolean, default: true },
        paperTrailing: { type: Boolean, default: true },
      },
      default: () => ({}),
    },
  },
  { timestamps: true }
);

export const AccountState = model("AccountState", accountStateSchema);
