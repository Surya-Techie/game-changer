import { User } from "../models/User.js";
import { AccountState } from "../models/AccountState.js";
import { Position } from "../models/Position.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

// Capital assumed for the default dev user when auth is disabled and no
// real User document exists. Keeps the auto-trade / risk path working in
// dev without seeding a user. Production (auth on) still requires a User.
const DEV_DEFAULT_CAPITAL = 100_000;

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
  qty?: number;
  capital?: number;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function getOrCreateAccountState(userId: string) {
  let state = await AccountState.findOne({ userId });
  if (!state) state = await AccountState.create({ userId });
  // Reset daily P&L if the date rolled over.
  if (state.dailyPnlDate !== today()) {
    state.dailyPnl = 0;
    state.dailyPnlDate = today();
    await state.save();
  }
  return state;
}

/**
 * Decides whether a new position can be opened on this symbol.
 * Computes size from per-trade risk %.
 */
export async function evaluateNewPosition(args: {
  userId: string;
  symbol: string;
  entry: number;
  stop: number;
}): Promise<RiskDecision> {
  const state = await getOrCreateAccountState(args.userId);
  if (state.killSwitch) return { allowed: false, reason: "Kill switch active" };
  if (state.autoTradeMode === "OFF") return { allowed: false, reason: "Auto-trade OFF" };

  const user = await User.findById(args.userId);
  if (!user && !env.authDisabled) return { allowed: false, reason: "User not found" };
  const capital = user?.capital ?? DEV_DEFAULT_CAPITAL;

  // Daily loss limit.
  const dailyLossCap = (capital * state.maxDailyLossPct) / 100;
  if (state.dailyPnl <= -dailyLossCap) {
    if (!state.killSwitch) {
      state.killSwitch = true;
      await state.save();
      logger.warn("Daily loss limit breached — kill switch engaged", {
        userId: args.userId,
        dailyPnl: state.dailyPnl,
      });
    }
    return { allowed: false, reason: "Daily loss limit hit" };
  }

  // Concurrency cap.
  const open = await Position.countDocuments({ userId: args.userId, status: "OPEN" });
  if (open >= state.maxOpenPositions) {
    return { allowed: false, reason: "Max open positions reached" };
  }

  // Position sizing.
  const perShareRisk = Math.abs(args.entry - args.stop);
  if (perShareRisk <= 0) return { allowed: false, reason: "Invalid stop distance" };
  const riskAmount = (capital * state.riskPerTradePct) / 100;
  const qty = Math.floor(riskAmount / perShareRisk);
  if (qty <= 0) return { allowed: false, reason: "Computed qty is zero" };

  return { allowed: true, qty, capital };
}

export async function recordPnl(userId: string, pnl: number) {
  const state = await getOrCreateAccountState(userId);
  state.realisedPnl += pnl;
  state.dailyPnl += pnl;
  await state.save();
  return state;
}
