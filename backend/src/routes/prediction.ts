import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getCandles } from "../services/candleAggregator.js";
import { getPrediction } from "../services/aiClient.js";

const router = Router();
router.use(requireAuth);

router.get("/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const candles = getCandles(symbol, 500);
    if (candles.length < 80) return res.json({ symbol, ready: false, reason: "not enough history" });
    const prediction = await getPrediction(symbol, candles, 5);
    res.json(prediction);
  } catch (err) {
    next(err);
  }
});

export default router;
