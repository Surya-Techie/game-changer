// Weekly review generator. Pulls all closed paper trades for the
// trailing 7 IST days and assembles a self-coaching template the user
// can fill in.

import { PaperTrade } from "../../models/PaperTrade.js";
import { Types } from "mongoose";

function istKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export interface WeeklyReview {
  weekEnding: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  bestTrade: { symbol: string; netPnl: number } | null;
  worstTrade: { symbol: string; netPnl: number } | null;
  topSymbols: Array<{ symbol: string; pnl: number; trades: number }>;
  prompts: { label: string; field: "didWell" | "improve" | "nextWeekGoal" }[];
  template: string;
}

export async function buildWeeklyReview(userId: string, accountId: string): Promise<WeeklyReview> {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const trades = await PaperTrade.find({
    userId,
    accountId: new Types.ObjectId(accountId),
    exitTime: { $gte: since },
  })
    .sort({ exitTime: 1 })
    .lean();

  const wins = trades.filter((t) => t.netPnl > 0).length;
  const losses = trades.length - wins;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const netPnl = trades.reduce((a, t) => a + t.netPnl, 0);

  let best: { symbol: string; netPnl: number } | null = null;
  let worst: { symbol: string; netPnl: number } | null = null;
  for (const t of trades) {
    if (best == null || t.netPnl > best.netPnl) best = { symbol: t.symbol, netPnl: t.netPnl };
    if (worst == null || t.netPnl < worst.netPnl) worst = { symbol: t.symbol, netPnl: t.netPnl };
  }

  const bySymbol = new Map<string, { pnl: number; trades: number }>();
  for (const t of trades) {
    const e = bySymbol.get(t.symbol) ?? { pnl: 0, trades: 0 };
    e.pnl += t.netPnl;
    e.trades += 1;
    bySymbol.set(t.symbol, e);
  }
  const topSymbols = Array.from(bySymbol.entries())
    .map(([symbol, v]) => ({ symbol, ...v }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 5);

  const prompts: WeeklyReview["prompts"] = [
    { label: "What I did well this week:", field: "didWell" },
    { label: "What I need to improve:", field: "improve" },
    { label: "My goal for next week:", field: "nextWeekGoal" },
  ];

  const template =
    `Week ending ${istKey(now)}\n\n` +
    `Trades: ${trades.length} (${wins}W / ${losses}L · ${winRate.toFixed(1)}%)\n` +
    `Net P&L: ${netPnl >= 0 ? "+" : ""}₹${netPnl.toFixed(0)}\n` +
    (best ? `Best: ${best.symbol} +₹${best.netPnl.toFixed(0)}\n` : "") +
    (worst ? `Worst: ${worst.symbol} ₹${worst.netPnl.toFixed(0)}\n` : "") +
    `\nWhat I did well:\n- \n\nWhat I need to improve:\n- \n\nGoal for next week:\n- \n`;

  return {
    weekEnding: istKey(now),
    trades: trades.length,
    wins,
    losses,
    winRate: Math.round(winRate * 10) / 10,
    netPnl: Math.round(netPnl * 100) / 100,
    bestTrade: best,
    worstTrade: worst,
    topSymbols,
    prompts,
    template,
  };
}
