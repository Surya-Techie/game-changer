import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Trade } from "../models/Trade.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const trades = await Trade.find({ userId: req.user!.userId }).sort({ exitAt: -1 }).limit(100).lean();
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    for (const t of trades) {
      if (t.pnl >= 0) wins++;
      else losses++;
      totalPnl += t.pnl;
    }
    res.json({
      trades,
      stats: {
        total: trades.length,
        wins,
        losses,
        winRate: trades.length ? wins / trades.length : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
