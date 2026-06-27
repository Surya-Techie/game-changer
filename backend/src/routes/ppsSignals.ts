import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getCandles } from "../services/candleAggregator.js";
import { getPpsSignals, recordPpsOutcomes, type PpsBarIn } from "../services/aiClient.js";

/**
 * POST /api/pps-signals
 *
 * Two call shapes are supported:
 *   1. { symbol, timeframe, bars: [{date, open, high, low, close, volume}, ...] }
 *      — caller supplies the OHLCV themselves (matches the spec contract).
 *   2. { symbol, timeframe } only — the backend pulls the most recent
 *      candle window from the aggregator and forwards. Convenient for the
 *      frontend so it doesn't have to wrangle candles twice.
 */
const router = Router();
router.use(requireAuth);

router.post("/", async (req, res, next) => {
  try {
    const { symbol, timeframe = "1D" } = req.body ?? {};
    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({ error: "symbol required" });
    }
    let bars: PpsBarIn[] | null = null;

    if (Array.isArray(req.body?.bars) && req.body.bars.length > 0) {
      bars = req.body.bars as PpsBarIn[];
    } else {
      // Pull candles from the in-memory aggregator and convert to PPS bar shape.
      const candles = getCandles(String(symbol).toUpperCase(), 500);
      if (candles.length < 50) {
        return res.json({
          symbol,
          timeframe,
          signals: [],
          summary: { total_signals: 0, buy_count: 0, sell_count: 0, avg_confidence: 0 },
          reason: "not enough candle history",
        });
      }
      bars = candles.map((c) => ({
        date: new Date(c.t).toISOString().slice(0, 10),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
      }));
    }

    const data = await getPpsSignals(String(symbol).toUpperCase(), String(timeframe), bars);
    if (!data) {
      return res.status(502).json({ error: "AI service unavailable" });
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/pps-signals/record  (PPS → Analytics)
 *
 * Resolves each PPS signal's outcome over the supplied (or aggregator)
 * candle window and commits it to the pattern-accuracy store, so PPS
 * patterns appear on the Analytics page and feed the measured-win-rate
 * read-back. Append-only — call deliberately (batch/backfill), not per
 * refresh, or the counts inflate.
 */
router.post("/record", async (req, res, next) => {
  try {
    const { symbol, timeframe = "1D" } = req.body ?? {};
    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({ error: "symbol required" });
    }
    let bars: PpsBarIn[] | null = null;
    if (Array.isArray(req.body?.bars) && req.body.bars.length > 0) {
      bars = req.body.bars as PpsBarIn[];
    } else {
      const candles = getCandles(String(symbol).toUpperCase(), 500);
      if (candles.length < 50) {
        return res.json({ recorded: 0, reason: "not enough candle history" });
      }
      bars = candles.map((c) => ({
        date: new Date(c.t).toISOString().slice(0, 10),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
      }));
    }
    const data = await recordPpsOutcomes(String(symbol).toUpperCase(), String(timeframe), bars);
    if (!data) {
      return res.status(502).json({ error: "AI service unavailable" });
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
