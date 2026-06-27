import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getCandles } from "../services/candleAggregator.js";
import { getCandlestickPatterns, getLevels, getMtfSummary } from "../services/aiClient.js";

const router = Router();
router.use(requireAuth);

router.get("/candlestick/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const lookback = Math.min(Math.max(Number(req.query.lookback ?? 30), 5), 200);
    const candles = getCandles(symbol, Math.max(lookback + 20, 100));
    if (candles.length < 5) return res.json({ symbol, patterns: [] });
    const out = await getCandlestickPatterns(symbol, candles, lookback);
    if (!out) return res.status(502).json({ error: "AI service unavailable" });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// POST variant — caller supplies the OHLCV directly. Used by the Power
// Analysis panel which already has yfinance-loaded candles in scope and
// would otherwise hit the in-memory aggregator (mockFeed-only).
router.post("/candlestick", async (req, res, next) => {
  try {
    const { symbol, candles, lookback = 30 } = req.body ?? {};
    if (!symbol || !Array.isArray(candles) || candles.length < 5) {
      return res.json({ symbol: symbol ?? "?", patterns: [] });
    }
    const lb = Math.min(Math.max(Number(lookback) || 30, 5), 200);
    const out = await getCandlestickPatterns(String(symbol).toUpperCase(), candles, lb);
    if (!out) return res.status(502).json({ error: "AI service unavailable" });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.get("/levels/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const candles = getCandles(symbol, 1000);
    if (candles.length < 30) return res.json({ symbol, error: "not enough history" });
    const out = await getLevels(symbol, candles);
    if (!out) return res.status(502).json({ error: "AI service unavailable" });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.get("/mtf/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const candles = getCandles(symbol, 1000);
    if (candles.length < 30) return res.json({ symbol, error: "not enough history" });
    const out = await getMtfSummary(symbol, candles);
    if (!out) return res.status(502).json({ error: "AI service unavailable" });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default router;
