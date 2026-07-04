// Performance analytics for a paper account. All computations done on
// the PaperTrade collection. Returns the bundle of series + scalar
// metrics the analytics page needs.

import { PaperTrade } from "../../models/PaperTrade.js";
import { PaperAccount } from "../../models/PaperAccount.js";
import { PaperPosition } from "../../models/PaperPosition.js";

// Lean shapes — just the fields the analytics computations read.
interface TradeRow {
  netPnl: number;
  symbol: string;
  strategyTag?: string;
  entryTime: Date;
  exitTime: Date;
  holdDurationMins: number;
  exitReason?: string;
}

interface PositionRow {
  currentPrice?: number | null;
  avgEntryPrice: number;
  qty: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function istKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function istHour(d: Date): number {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return Number(h);
}

function istWeekday(d: Date): number {
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

export async function buildAnalytics(userId: string, accountId: string) {
  const account = await PaperAccount.findOne({ _id: accountId, userId }).lean();
  if (!account) throw Object.assign(new Error("Account not found"), { status: 404 });

  const trades = await PaperTrade.find({ accountId }).sort({ exitTime: 1 }).lean();
  const positions = await PaperPosition.find({ accountId }).lean();

  const summary = computeSummary(trades, account.startingCapital, account.currentCash, positions);
  const equityCurve = computeEquityCurve(trades, account.startingCapital);
  const dailyPnl = computeDailyPnl(trades);
  const drawdown = computeDrawdown(equityCurve);
  const distribution = computeDistribution(trades);
  const bySymbol = computeBySymbol(trades);
  const byHour = computeByHour(trades);
  const byWeekday = computeByWeekday(trades);
  const byStrategy = computeByStrategy(trades);
  const advanced = computeAdvanced(trades, account.startingCapital);
  const streaks = computeStreaks(trades);
  const behavior = computeBehavior(trades);

  return {
    summary,
    equityCurve,
    dailyPnl,
    drawdown,
    distribution,
    bySymbol,
    byHour,
    byWeekday,
    byStrategy,
    advanced,
    streaks,
    behavior,
  };
}

function computeSummary(
  trades: TradeRow[],
  startingCapital: number,
  currentCash: number,
  positions: PositionRow[]
) {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const totalPnl = trades.reduce((a, t) => a + t.netPnl, 0);
  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 99 : 0) : grossProfit / grossLoss;
  const winRate = trades.length === 0 ? 0 : (wins.length / trades.length) * 100;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  const positionsValue = positions.reduce(
    (a, p) => a + (p.currentPrice ?? p.avgEntryPrice) * p.qty,
    0
  );
  const equity = round2(currentCash + positionsValue);

  return {
    startingCapital,
    currentEquity: equity,
    totalPnl: round2(totalPnl),
    totalPnlPct: round2(((equity - startingCapital) / startingCapital) * 100),
    winRate: round2(winRate),
    profitFactor: round2(profitFactor),
    totalTrades: trades.length,
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    payoffRatio: avgLoss ? round2(avgWin / avgLoss) : 0,
    expectancy: round2((winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss),
  };
}

function computeEquityCurve(trades: TradeRow[], starting: number) {
  let eq = starting;
  const points: { date: string; equity: number; tradePnl: number }[] = [];
  for (const t of trades) {
    eq += t.netPnl;
    points.push({ date: istKey(new Date(t.exitTime)), equity: round2(eq), tradePnl: round2(t.netPnl) });
  }
  return points;
}

function computeDailyPnl(trades: TradeRow[]) {
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const k = istKey(new Date(t.exitTime));
    byDay.set(k, (byDay.get(k) ?? 0) + t.netPnl);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([date, pnl]) => ({ date, pnl: round2(pnl) }));
}

function computeDrawdown(curve: { equity: number }[]) {
  let peak = curve[0]?.equity ?? 0;
  let maxDd = 0;
  const series = curve.map((p) => {
    if (p.equity > peak) peak = p.equity;
    const dd = peak === 0 ? 0 : ((peak - p.equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
    return { equity: p.equity, ddPct: round2(dd) };
  });
  return { series, maxDrawdownPct: round2(maxDd) };
}

function computeDistribution(trades: TradeRow[]) {
  if (trades.length === 0) return { bins: [], min: 0, max: 0 };
  const pnls = trades.map((t) => t.netPnl);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const binCount = Math.min(20, Math.max(5, Math.floor(trades.length / 3)));
  const step = (max - min) / binCount || 1;
  const bins = new Array(binCount).fill(0).map((_, i) => ({
    from: round2(min + i * step),
    to: round2(min + (i + 1) * step),
    count: 0,
  }));
  for (const p of pnls) {
    const idx = Math.min(binCount - 1, Math.floor((p - min) / step));
    bins[idx].count++;
  }
  return { bins, min: round2(min), max: round2(max) };
}

function computeBySymbol(trades: TradeRow[]) {
  const map = new Map<string, { trades: number; pnl: number; wins: number }>();
  for (const t of trades) {
    const e = map.get(t.symbol) ?? { trades: 0, pnl: 0, wins: 0 };
    e.trades++;
    e.pnl += t.netPnl;
    if (t.netPnl > 0) e.wins++;
    map.set(t.symbol, e);
  }
  return Array.from(map.entries())
    .map(([symbol, v]) => ({
      symbol,
      trades: v.trades,
      pnl: round2(v.pnl),
      winRate: round2((v.wins / v.trades) * 100),
    }))
    .sort((a, b) => b.pnl - a.pnl);
}

function computeByHour(trades: TradeRow[]) {
  const map = new Map<number, { count: number; pnl: number; wins: number }>();
  for (let h = 9; h <= 15; h++) map.set(h, { count: 0, pnl: 0, wins: 0 });
  for (const t of trades) {
    const h = istHour(new Date(t.entryTime));
    if (h < 9 || h > 15) continue;
    const e = map.get(h)!;
    e.count++;
    e.pnl += t.netPnl;
    if (t.netPnl > 0) e.wins++;
  }
  return Array.from(map.entries()).map(([hour, v]) => ({
    hour,
    trades: v.count,
    pnl: round2(v.pnl),
    winRate: v.count ? round2((v.wins / v.count) * 100) : 0,
  }));
}

function computeByWeekday(trades: TradeRow[]) {
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const map = new Map<number, { count: number; pnl: number; wins: number }>();
  for (let i = 1; i <= 5; i++) map.set(i, { count: 0, pnl: 0, wins: 0 });
  for (const t of trades) {
    const w = istWeekday(new Date(t.entryTime));
    if (w < 1 || w > 5) continue;
    const e = map.get(w)!;
    e.count++;
    e.pnl += t.netPnl;
    if (t.netPnl > 0) e.wins++;
  }
  return Array.from(map.entries()).map(([w, v]) => ({
    weekday: labels[w - 1],
    trades: v.count,
    pnl: round2(v.pnl),
    winRate: v.count ? round2((v.wins / v.count) * 100) : 0,
  }));
}

function computeByStrategy(trades: TradeRow[]) {
  const map = new Map<string, { count: number; pnl: number; wins: number; sumWin: number; sumLoss: number }>();
  for (const t of trades) {
    const tag = (t.strategyTag || "Untagged") as string;
    const e = map.get(tag) ?? { count: 0, pnl: 0, wins: 0, sumWin: 0, sumLoss: 0 };
    e.count++;
    e.pnl += t.netPnl;
    if (t.netPnl > 0) {
      e.wins++;
      e.sumWin += t.netPnl;
    } else {
      e.sumLoss += Math.abs(t.netPnl);
    }
    map.set(tag, e);
  }
  return Array.from(map.entries()).map(([tag, v]) => {
    const avgWin = v.wins ? v.sumWin / v.wins : 0;
    const avgLoss = v.count - v.wins ? v.sumLoss / (v.count - v.wins) : 0;
    return {
      strategy: tag,
      trades: v.count,
      pnl: round2(v.pnl),
      winRate: round2((v.wins / v.count) * 100),
      avgWin: round2(avgWin),
      avgLoss: round2(avgLoss),
      profitFactor: v.sumLoss > 0 ? round2(v.sumWin / v.sumLoss) : 0,
    };
  });
}

function computeAdvanced(trades: TradeRow[], starting: number) {
  if (trades.length === 0) {
    return { sharpe: 0, sortino: 0, calmar: 0, sqn: 0, kelly: 0, recoveryFactor: 0 };
  }
  // Daily returns from grouped daily P&L.
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const k = istKey(new Date(t.exitTime));
    byDay.set(k, (byDay.get(k) ?? 0) + t.netPnl);
  }
  const dailyReturns = Array.from(byDay.values()).map((p) => p / starting);
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length;
  const sd = Math.sqrt(variance);
  const sharpe = sd === 0 ? 0 : (mean / sd) * Math.sqrt(252);

  const downside = dailyReturns.filter((r) => r < 0);
  const dsVar = downside.reduce((a, b) => a + b ** 2, 0) / Math.max(1, downside.length);
  const dsSd = Math.sqrt(dsVar);
  const sortino = dsSd === 0 ? 0 : (mean / dsSd) * Math.sqrt(252);

  const equityCurve = computeEquityCurve(trades, starting);
  const dd = computeDrawdown(equityCurve);
  const totalReturnPct = equityCurve.length
    ? ((equityCurve[equityCurve.length - 1].equity - starting) / starting) * 100
    : 0;
  const calmar = dd.maxDrawdownPct === 0 ? 0 : totalReturnPct / dd.maxDrawdownPct;
  const recoveryFactor = dd.maxDrawdownPct === 0 ? 0 : Math.abs(totalReturnPct) / dd.maxDrawdownPct;

  // SQN = (mean trade P&L / std trade P&L) * sqrt(N)
  const pnls = trades.map((t) => t.netPnl);
  const m2 = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v2 = pnls.reduce((a, b) => a + (b - m2) ** 2, 0) / pnls.length;
  const sd2 = Math.sqrt(v2);
  const sqn = sd2 === 0 ? 0 : (m2 / sd2) * Math.sqrt(pnls.length);

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const winRate = wins.length / trades.length;
  const lossRate = losses.length / trades.length;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.netPnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.netPnl, 0)) / losses.length : 0;
  const payoff = avgLoss === 0 ? 0 : avgWin / avgLoss;
  const kelly = payoff === 0 ? 0 : (winRate - lossRate / payoff) * 100;

  return {
    sharpe: round2(sharpe),
    sortino: round2(sortino),
    calmar: round2(calmar),
    sqn: round2(sqn),
    kelly: round2(kelly),
    recoveryFactor: round2(recoveryFactor),
  };
}

function computeStreaks(trades: TradeRow[]) {
  let curWin = 0;
  let curLoss = 0;
  let maxWin = 0;
  let maxLoss = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      curWin++;
      curLoss = 0;
      if (curWin > maxWin) maxWin = curWin;
    } else if (t.netPnl < 0) {
      curLoss++;
      curWin = 0;
      if (curLoss > maxLoss) maxLoss = curLoss;
    }
  }
  return { maxWinStreak: maxWin, maxLossStreak: maxLoss };
}

function computeBehavior(trades: TradeRow[]) {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const avgHoldWin = wins.length ? wins.reduce((a, t) => a + t.holdDurationMins, 0) / wins.length : 0;
  const avgHoldLoss = losses.length ? losses.reduce((a, t) => a + t.holdDurationMins, 0) / losses.length : 0;
  // Overtrading days: >10 trades on the same IST day.
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const k = istKey(new Date(t.entryTime));
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  const overtradingDays = Array.from(byDay.values()).filter((n) => n > 10).length;
  // Revenge trades: any trade opened within 5 mins of a prior SL hit.
  const sorted = [...trades].sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());
  let revenge = 0;
  let lastSlExit = 0;
  for (const t of sorted) {
    if (lastSlExit && new Date(t.entryTime).getTime() - lastSlExit < 5 * 60 * 1000) revenge++;
    if (t.exitReason === "SL") lastSlExit = new Date(t.exitTime).getTime();
  }
  return {
    avgHoldMinsWin: Math.round(avgHoldWin),
    avgHoldMinsLoss: Math.round(avgHoldLoss),
    overtradingDays,
    revengeTrades: revenge,
  };
}
