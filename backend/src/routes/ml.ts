import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { getCandles } from "../services/candleAggregator.js";
import { mockFeed } from "../services/mockFeed.js";
import { getMlRegistry, trainMl } from "../services/aiClient.js";
import { logger } from "../utils/logger.js";

const router = Router();
router.use(requireAuth);

router.get("/registry", async (_req, res, next) => {
  try {
    const out = await getMlRegistry();
    res.json(out ?? { models: {} });
  } catch (err) {
    next(err);
  }
});

router.post("/train/:symbol", requireAdmin, async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const candles = getCandles(symbol, 1000);
    if (candles.length < 100) {
      return res.status(400).json({ error: "not enough candles to train (need ≥ 100)", have: candles.length });
    }
    const out = await trainMl(symbol, candles);
    if (!out) return res.status(502).json({ error: "AI service unavailable" });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

/** Sequentially train every universe symbol. Slow (~30s for 20 symbols). */
router.post("/train-all", requireAdmin, async (_req, res, next) => {
  try {
    const symbols = mockFeed.symbols();
    const results: Array<{ symbol: string; ok: boolean; metrics?: unknown; error?: string }> = [];
    for (const symbol of symbols) {
      const candles = getCandles(symbol, 1000);
      if (candles.length < 100) {
        results.push({ symbol, ok: false, error: `only ${candles.length} candles` });
        continue;
      }
      try {
        const out = await trainMl(symbol, candles);
        if (!out || (out as { error?: string }).error) {
          results.push({ symbol, ok: false, error: (out as { error?: string })?.error ?? "train failed" });
        } else {
          results.push({ symbol, ok: true, metrics: out });
        }
      } catch (err) {
        logger.warn("train-all failed for symbol", { symbol, err: (err as Error).message });
        results.push({ symbol, ok: false, error: (err as Error).message });
      }
    }
    res.json({ trained: results.filter((r) => r.ok).length, total: symbols.length, results });
  } catch (err) {
    next(err);
  }
});

export default router;
