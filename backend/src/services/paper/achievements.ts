// Achievements / badges computed on demand from a user's paper-trade
// history. Pure derivation — no separate model. The frontend renders
// the returned list directly.

import { PaperTrade } from "../../models/PaperTrade.js";
import { PaperAccount } from "../../models/PaperAccount.js";

export interface Badge {
  id: string;
  icon: string;
  label: string;
  description: string;
  earned: boolean;
  progress?: string;
}

export async function computeBadges(userId: string, accountId: string): Promise<Badge[]> {
  const account = await PaperAccount.findOne({ _id: accountId, userId }).lean();
  if (!account) return [];
  const trades = await PaperTrade.find({ accountId })
    .sort({ exitTime: 1 })
    .lean();

  const wins = trades.filter((t) => t.netPnl > 0);

  // Compute longest winning streak.
  let curStreak = 0;
  let maxStreak = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      curStreak++;
      if (curStreak > maxStreak) maxStreak = curStreak;
    } else if (t.netPnl < 0) curStreak = 0;
  }

  // Biggest single-day P&L.
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const k = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(t.exitTime));
    byDay.set(k, (byDay.get(k) ?? 0) + t.netPnl);
  }
  const bestDay = Math.max(0, ...Array.from(byDay.values()));
  const bestDayPct = (bestDay / account.startingCapital) * 100;

  // Journal compliance: count of trades with all of preTradePlan/notes/lesson filled.
  const journaled = trades.filter(
    (t) => (t.preTradePlan || "").trim().length > 0 && (t.lesson || "").trim().length > 0
  ).length;

  // Held a winner > 4h.
  const heldWinner = wins.some((t) => t.holdDurationMins >= 240);

  // Drawdown recovery: had a peak-to-trough >10%, then recovered to a new peak.
  let peak = account.startingCapital;
  let trough = peak;
  let recoveredFromDd = false;
  let runningEq = account.startingCapital;
  for (const t of trades) {
    runningEq += t.netPnl;
    if (runningEq > peak) peak = runningEq;
    if (runningEq < trough) trough = runningEq;
    const drawdownPct = ((peak - trough) / peak) * 100;
    if (drawdownPct >= 10 && runningEq >= peak) recoveredFromDd = true;
  }

  const badges: Badge[] = [];
  badges.push({
    id: "first_profit",
    icon: "🎯",
    label: "First Profit",
    description: "Your first profitable paper trade",
    earned: wins.length > 0,
  });
  badges.push({
    id: "first_1pct_day",
    icon: "💰",
    label: "1% Day",
    description: "First day with +1% account return",
    earned: bestDayPct >= 1,
    progress: `${bestDayPct.toFixed(2)}% / 1.00%`,
  });
  badges.push({
    id: "five_win_streak",
    icon: "🔥",
    label: "5-Win Streak",
    description: "Five consecutive winning trades",
    earned: maxStreak >= 5,
    progress: `${maxStreak} / 5`,
  });
  badges.push({
    id: "recovered_from_dd",
    icon: "📉",
    label: "Recovered",
    description: "Recovered from a 10% drawdown",
    earned: recoveredFromDd,
  });
  badges.push({
    id: "held_winner_4h",
    icon: "⏰",
    label: "Patience",
    description: "Held a winner for 4+ hours",
    earned: heldWinner,
  });
  badges.push({
    id: "journaled_10",
    icon: "📚",
    label: "Reflective Trader",
    description: "Wrote journal notes for 10 trades",
    earned: journaled >= 10,
    progress: `${journaled} / 10`,
  });
  badges.push({
    id: "active_50",
    icon: "⚡",
    label: "Active",
    description: "50+ paper trades total",
    earned: trades.length >= 50,
    progress: `${trades.length} / 50`,
  });
  return badges;
}
