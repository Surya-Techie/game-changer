import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getCandlesSmart } from "../services/candleAggregator.js";
import { getIndicators } from "../services/aiClient.js";

const router = Router();
router.use(requireAuth);

router.get("/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const candles = await getCandlesSmart(symbol, limit);
    if (candles.length < 30) return res.json({ symbol, indicators: {} });
    const families = (req.query.families as string | undefined)?.split(",").filter(Boolean);
    const indicators = await getIndicators(symbol, candles, families);
    res.json({ symbol, indicators });
  } catch (err) {
    next(err);
  }
});

export default router;
