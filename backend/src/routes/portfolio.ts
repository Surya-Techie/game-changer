import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Position } from "../models/Position.js";
import { User } from "../models/User.js";
import { getOrCreateAccountState } from "../services/riskManager.js";
import { priceBook } from "../services/priceBook.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const [user, state, openPositions] = await Promise.all([
      User.findById(userId).select("capital targetCapital").lean(),
      getOrCreateAccountState(userId),
      Position.find({ userId, status: "OPEN" }).lean(),
    ]);

    let unrealised = 0;
    const enriched = openPositions.map((p) => {
      const last = priceBook.price(p.symbol);
      const mtm =
        last == null
          ? 0
          : p.side === "LONG"
          ? (last - p.entryPrice) * p.qty
          : (p.entryPrice - last) * p.qty;
      unrealised += mtm;
      return { ...p, lastPrice: last, unrealisedPnl: round2(mtm) };
    });

    const capital = user?.capital ?? 100_000;
    res.json({
      capital,
      targetCapital: user?.targetCapital ?? capital * 2,
      equity: round2(capital + state.realisedPnl + unrealised),
      realisedPnl: round2(state.realisedPnl),
      unrealisedPnl: round2(unrealised),
      dailyPnl: round2(state.dailyPnl),
      openPositions: enriched,
      autoTradeMode: state.autoTradeMode,
      killSwitch: state.killSwitch,
      minConfidence: state.minConfidence,
      maxOpenPositions: state.maxOpenPositions,
      riskPerTradePct: state.riskPerTradePct,
      maxDailyLossPct: state.maxDailyLossPct,
      notificationPrefs: state.notificationPrefs ?? {},
    });
  } catch (err) {
    next(err);
  }
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default router;
