import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getCandlesSmart } from "../services/candleAggregator.js";
import { premiumClient } from "../services/premiumClient.js";

const router = Router();
router.use(requireAuth);

const symbolParam = z.object({ symbol: z.string().min(1) });

function load(symbol: string) {
  return getCandlesSmart(symbol.toUpperCase(), 500);
}

router.get("/vwap/:symbol", async (req, res, next) => {
  try {
    const { symbol } = symbolParam.parse(req.params);
    const candles = await load(symbol);
    if (candles.length < 30) return res.json({ error: "not enough candles" });
    const anchorBars = (req.query.anchor as string | undefined)?.split(",").map(Number).filter((n) => Number.isFinite(n));
    const data = await premiumClient.vwap(symbol, candles, anchorBars);
    if (!data) return res.status(502).json({ error: "AI service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/ichimoku/:symbol", async (req, res, next) => {
  try {
    const { symbol } = symbolParam.parse(req.params);
    const candles = await load(symbol);
    if (candles.length < 60) return res.json({ error: "need ≥60 bars" });
    const data = await premiumClient.ichimoku(symbol, candles);
    if (!data) return res.status(502).json({ error: "AI service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/smc/:symbol", async (req, res, next) => {
  try {
    const { symbol } = symbolParam.parse(req.params);
    const candles = await load(symbol);
    if (candles.length < 60) return res.json({ error: "need ≥60 bars" });
    const data = await premiumClient.smc(symbol, candles);
    if (!data) return res.status(502).json({ error: "AI service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/orderflow/:symbol", async (req, res, next) => {
  try {
    const { symbol } = symbolParam.parse(req.params);
    const candles = await load(symbol);
    if (candles.length < 30) return res.json({ error: "need ≥30 bars" });
    const data = await premiumClient.orderflow(symbol, candles);
    if (!data) return res.status(502).json({ error: "AI service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/profile/:symbol", async (req, res, next) => {
  try {
    const { symbol } = symbolParam.parse(req.params);
    const candles = await load(symbol);
    if (candles.length < 30) return res.json({ error: "need ≥30 bars" });
    const data = await premiumClient.profile(symbol, candles);
    if (!data) return res.status(502).json({ error: "AI service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
