import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getCandlesSmart } from "../services/candleAggregator.js";
import { getPowerAnalysis, type CandleIn } from "../services/aiClient.js";

/**
 * POST /api/power-analysis
 *
 * Two call shapes:
 *   1) { symbol, candles: [{t,o,h,l,c,v}, ...], mode?, useMl? }
 *      Caller supplies the OHLCV directly. Used by the Pattern Analytics
 *      page so the chart-data and the signal-data are guaranteed in sync.
 *   2) { symbol, mode?, useMl? } — backend pulls candles from its
 *      in-memory aggregator.
 */
const router = Router();
router.use(requireAuth);

router.post("/", async (req, res, next) => {
  try {
    const { symbol, mode = "strict", useMl = false, targetR, stopPct, targetPct } = req.body ?? {};
    const tR = Math.max(1, Math.min(6, Number(targetR) || 2));
    const sPct = (stopPct != null && Number.isFinite(Number(stopPct)) && Number(stopPct) > 0)
      ? Math.max(0.1, Math.min(20, Number(stopPct))) : undefined;
    const tPct = (targetPct != null && Number.isFinite(Number(targetPct)) && Number(targetPct) > 0)
      ? Math.max(0.1, Math.min(30, Number(targetPct))) : undefined;
    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({ error: "symbol required" });
    }
    const m = mode === "loose" ? "loose" : "strict";

    let candles: CandleIn[] | null = null;
    if (Array.isArray(req.body?.candles) && req.body.candles.length > 0) {
      candles = req.body.candles as CandleIn[];
    } else {
      const c = await getCandlesSmart(String(symbol).toUpperCase(), 500);
      candles = c.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    }

    // The ai-service /power-analysis endpoint enforces min_length=80 via
    // Pydantic and returns a 422 we'd otherwise surface as a noisy 502.
    // Short-circuit here so the frontend gets a clean empty result with
    // a clear reason it can render as "load more data" instead of a
    // generic gateway error.
    if (!candles || candles.length < 80) {
      return res.json({
        symbol,
        mode: m,
        signals: [],
        summary: { total_signals: 0, buy_count: 0, sell_count: 0, avg_confidence: 0 },
        reason: `not enough candle history (have ${candles?.length ?? 0}, need ≥ 80)`,
      });
    }

    const data = await getPowerAnalysis(
      String(symbol).toUpperCase(),
      candles,
      m,
      Boolean(useMl),
      tR,
      sPct,
      tPct
    );
    if (!data) {
      return res.status(502).json({ error: "AI service unavailable" });
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
