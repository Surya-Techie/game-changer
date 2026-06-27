import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Trade } from "../models/Trade.js";
import { Position } from "../models/Position.js";
import { User } from "../models/User.js";
import { getOrCreateAccountState } from "../services/riskManager.js";
import { priceBook } from "../services/priceBook.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const [user, state, openPositions, trades] = await Promise.all([
      User.findById(userId).select("capital").lean(),
      getOrCreateAccountState(userId),
      Position.find({ userId, status: "OPEN" }).lean(),
      Trade.find({ userId }).sort({ exitAt: -1 }).limit(500).lean(),
    ]);

    const capital = user?.capital ?? 100_000;

    // Unrealised on open positions.
    let unrealised = 0;
    const enrichedOpen = openPositions.map((p) => {
      const last = priceBook.price(p.symbol);
      const mtm =
        last == null
          ? 0
          : p.side === "LONG"
          ? (last - p.entryPrice) * p.qty
          : (p.entryPrice - last) * p.qty;
      unrealised += mtm;
      return { ...p, lastPrice: last, unrealisedPnl: Math.round(mtm * 100) / 100 };
    });

    // Daily P&L bar chart (last 30 days).
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const buckets: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(today.getTime() - i * dayMs);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    for (const t of trades) {
      const key = new Date(t.exitAt).toISOString().slice(0, 10);
      if (key in buckets) buckets[key] += t.pnl;
    }
    const dailyPnl = Object.entries(buckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, pnl]) => ({ date, pnl: Math.round(pnl * 100) / 100 }));

    // Cumulative equity curve from trades (assumes initial = 0 P&L).
    let cum = 0;
    const equityCurve = [...trades]
      .sort((a, b) => new Date(a.exitAt).getTime() - new Date(b.exitAt).getTime())
      .map((t) => {
        cum += t.pnl;
        return { t: new Date(t.exitAt).getTime(), pnl: Math.round(cum * 100) / 100 };
      });

    // P&L by symbol.
    const bySymbol: Record<string, { pnl: number; trades: number; wins: number }> = {};
    for (const t of trades) {
      const k = t.symbol;
      bySymbol[k] ??= { pnl: 0, trades: 0, wins: 0 };
      bySymbol[k].pnl += t.pnl;
      bySymbol[k].trades += 1;
      if (t.pnl > 0) bySymbol[k].wins += 1;
    }
    const pnlBySymbol = Object.entries(bySymbol)
      .map(([symbol, v]) => ({
        symbol,
        pnl: Math.round(v.pnl * 100) / 100,
        trades: v.trades,
        winRate: v.trades ? v.wins / v.trades : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl);

    // P&L by hour-of-day (0-23 UTC).
    const byHour: number[] = Array(24).fill(0);
    const byHourCount: number[] = Array(24).fill(0);
    for (const t of trades) {
      const hr = new Date(t.exitAt).getUTCHours();
      byHour[hr] += t.pnl;
      byHourCount[hr] += 1;
    }
    const pnlByHour = byHour.map((pnl, hr) => ({
      hour: hr,
      pnl: Math.round(pnl * 100) / 100,
      trades: byHourCount[hr],
    }));

    // Risk metrics.
    const winsArr = trades.filter((t) => t.pnl > 0);
    const lossesArr = trades.filter((t) => t.pnl <= 0);
    const winRate = trades.length ? winsArr.length / trades.length : 0;
    const grossWin = winsArr.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = -lossesArr.reduce((s, t) => s + t.pnl, 0);
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0;
    const avgWin = winsArr.length ? grossWin / winsArr.length : 0;
    const avgLoss = lossesArr.length ? -grossLoss / lossesArr.length : 0;
    const expectancy = winRate * avgWin - (1 - winRate) * Math.abs(avgLoss);
    const avgR = trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;

    // Drawdown from cumulative equity.
    let peak = 0;
    let maxDd = 0;
    for (const p of equityCurve) {
      peak = Math.max(peak, p.pnl);
      const dd = peak - p.pnl;
      if (dd > maxDd) maxDd = dd;
    }

    res.json({
      capital,
      equity: Math.round((capital + state.realisedPnl + unrealised) * 100) / 100,
      realisedPnl: Math.round(state.realisedPnl * 100) / 100,
      unrealisedPnl: Math.round(unrealised * 100) / 100,
      dailyPnl: Math.round(state.dailyPnl * 100) / 100,
      openPositions: enrichedOpen,
      totals: {
        trades: trades.length,
        wins: winsArr.length,
        losses: lossesArr.length,
        winRate,
        profitFactor,
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
        expectancy: Math.round(expectancy * 100) / 100,
        avgRPct: Math.round(avgR * 1000) / 1000,
        maxDrawdown: Math.round(maxDd * 100) / 100,
      },
      dailySeries: dailyPnl,
      equityCurve,
      pnlBySymbol,
      pnlByHour,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/trades/:id", async (req, res, next) => {
  try {
    const { note, tags, screenshots } = req.body as {
      note?: string;
      tags?: string[];
      screenshots?: string[];
    };
    // Reject oversized base64 screenshots (>1 MB each, max 4).
    if (screenshots) {
      for (const s of screenshots) {
        if (typeof s !== "string" || s.length > 1_400_000) {
          return res.status(400).json({ error: "Screenshot too large (max ~1MB each, 4 total)" });
        }
      }
    }
    const set: Record<string, unknown> = {};
    if (note !== undefined) set.note = note;
    if (tags !== undefined) set.tags = tags;
    if (screenshots !== undefined) set.screenshots = screenshots;
    const trade = await Trade.findOneAndUpdate(
      { _id: req.params.id, userId: req.user!.userId },
      { $set: set },
      { new: true }
    );
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    res.json({ trade });
  } catch (err) {
    next(err);
  }
});

/**
 * Tag analytics — bucket trades by each tag they carry, return per-tag win
 * rate, profit factor, total P&L. Useful for "which setup type works best"
 * once a journal has a few weeks of data.
 */
router.get("/tag-stats", async (req, res, next) => {
  try {
    const trades = await Trade.find({ userId: req.user!.userId }).select("tags pnl exitReason").lean();
    const byTag: Record<string, { trades: number; wins: number; pnl: number; grossWin: number; grossLoss: number }> = {};
    for (const t of trades) {
      for (const raw of t.tags ?? []) {
        const tag = raw.trim();
        if (!tag) continue;
        const b = (byTag[tag] ??= { trades: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0 });
        b.trades += 1;
        b.pnl += t.pnl;
        if (t.pnl > 0) {
          b.wins += 1;
          b.grossWin += t.pnl;
        } else {
          b.grossLoss += -t.pnl;
        }
      }
    }
    const rows = Object.entries(byTag).map(([tag, v]) => ({
      tag,
      trades: v.trades,
      wins: v.wins,
      winRate: v.trades ? v.wins / v.trades : 0,
      totalPnl: Math.round(v.pnl * 100) / 100,
      profitFactor: v.grossLoss > 0 ? Math.round((v.grossWin / v.grossLoss) * 100) / 100 : v.grossWin > 0 ? null : 0,
    }));
    rows.sort((a, b) => b.trades - a.trades);
    res.json({ rows, totalTrades: trades.length });
  } catch (err) {
    next(err);
  }
});

/**
 * Weekly review — auto-generated summary of the last 7 days' trades.
 * Honest: just aggregates what's in the journal; no LLM, no fluff. UI then
 * prints the page to PDF via window.print() with a print stylesheet.
 */
router.get("/weekly-review", async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const trades = await Trade.find({
      userId,
      exitAt: { $gte: new Date(sinceMs) },
    })
      .sort({ exitAt: 1 })
      .lean();

    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const winRate = trades.length ? wins.length / trades.length : 0;
    const biggestWin = wins.reduce<typeof trades[number] | null>(
      (best, t) => (best == null || t.pnl > best.pnl ? t : best),
      null
    );
    const biggestLoss = losses.reduce<typeof trades[number] | null>(
      (worst, t) => (worst == null || t.pnl < worst.pnl ? t : worst),
      null
    );

    // Most-used tag.
    const tagCount: Record<string, { count: number; pnl: number }> = {};
    for (const t of trades) {
      for (const tag of t.tags ?? []) {
        const b = (tagCount[tag] ??= { count: 0, pnl: 0 });
        b.count += 1;
        b.pnl += t.pnl;
      }
    }
    const topTag = Object.entries(tagCount).sort((a, b) => b[1].count - a[1].count)[0];

    // Per-symbol breakdown.
    const symbols: Record<string, { trades: number; pnl: number }> = {};
    for (const t of trades) {
      const k = t.symbol;
      symbols[k] ??= { trades: 0, pnl: 0 };
      symbols[k].trades += 1;
      symbols[k].pnl += t.pnl;
    }

    // Simple data-driven observations.
    const lessons: string[] = [];
    if (trades.length === 0) {
      lessons.push("No trades in the last 7 days.");
    } else {
      if (winRate < 0.4) lessons.push(`Win rate ${(winRate * 100).toFixed(0)}% is below 40% — review entry triggers.`);
      if (winRate > 0.6) lessons.push(`Win rate ${(winRate * 100).toFixed(0)}% is strong — keep what's working.`);
      if (biggestLoss && biggestWin && Math.abs(biggestLoss.pnl) > biggestWin.pnl * 2) {
        lessons.push("One loss is more than 2× your best win — tighten stop discipline.");
      }
      const slCount = trades.filter((t) => t.exitReason === "SL").length;
      const tpCount = trades.filter((t) => t.exitReason === "TP").length;
      if (slCount > tpCount * 2 && trades.length >= 5) {
        lessons.push("Stops hit far more often than targets — entries may be too eager.");
      }
      if (topTag && topTag[1].count >= 3) {
        const avg = topTag[1].pnl / topTag[1].count;
        lessons.push(
          `Most-used tag "${topTag[0]}": ${topTag[1].count} trades, avg ₹${avg.toFixed(2)}.`
        );
      }
    }

    res.json({
      sinceIso: new Date(sinceMs).toISOString(),
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 10000) / 10000,
      totalPnl: Math.round(totalPnl * 100) / 100,
      biggestWin: biggestWin && { symbol: biggestWin.symbol, pnl: biggestWin.pnl, exitAt: biggestWin.exitAt },
      biggestLoss: biggestLoss && { symbol: biggestLoss.symbol, pnl: biggestLoss.pnl, exitAt: biggestLoss.exitAt },
      topTag: topTag && { tag: topTag[0], count: topTag[1].count, pnl: Math.round(topTag[1].pnl * 100) / 100 },
      symbols: Object.entries(symbols)
        .map(([s, v]) => ({ symbol: s, trades: v.trades, pnl: Math.round(v.pnl * 100) / 100 }))
        .sort((a, b) => b.pnl - a.pnl),
      lessons,
      trades,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
