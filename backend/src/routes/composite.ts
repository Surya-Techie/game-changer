import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getCandles } from "../services/candleAggregator.js";
import { buildPeerIndex, computeAdvanceDeclineRatio } from "../services/peerIndex.js";
import { runComposite, runCompositeBacktest } from "../services/compositeClient.js";
import { fetchPatternOhlcv } from "../services/aiClient.js";
import type { Candle } from "../models/Candle.js";
import { Signal } from "../models/Signal.js";

// In-mem aggregator only knows about the mock-feed NSE symbols. For
// anything else (e.g. BSE `.BO` listings, foreign tickers, fresh symbols
// the warmup hasn't reached) fall back to the ai-service OHLCV API so
// composite/backtest endpoints don't 400 with "Not enough candles".
async function getCandlesWithFallback(symbol: string, bars: number): Promise<Candle[]> {
  const local = getCandles(symbol, bars);
  if (local.length >= 60) return local;
  const ohlcv = await fetchPatternOhlcv(symbol, "D1", Math.max(bars, 200));
  if (!ohlcv || !ohlcv.candles?.length) return local;
  return ohlcv.candles.map((c) => ({
    symbol,
    t: c.t,
    o: c.o, h: c.h, l: c.l, c: c.c,
    v: c.v ?? 0,
  }));
}

const router = Router();
router.use(requireAuth);

const sentimentSchema = z
  .object({
    fii_dii_net_cr: z.number().nullable().optional(),
    india_vix: z.number().nullable().optional(),
    ad_ratio: z.number().nullable().optional(),
    pcr: z.number().nullable().optional(),
    news_sentiment: z.number().min(-1).max(1).nullable().optional(),
  })
  .optional();

async function recentNewsSentimentForSymbol(symbol: string): Promise<number | undefined> {
  // No external news source plugged in yet — we approximate using the recent
  // BUY/SELL/HOLD signal distribution for this symbol as a weak proxy for
  // headline tone. Real news API integration replaces this when keys land.
  const recent = await Signal.find({ symbol }).sort({ createdAt: -1 }).limit(20).lean();
  if (!recent.length) return undefined;
  let score = 0;
  for (const s of recent) {
    score += s.action === "BUY" ? 1 : s.action === "SELL" ? -1 : 0;
  }
  return score / recent.length; // [-1, +1]
}

const compositeQuery = z.object({
  bars: z.coerce.number().int().min(100).max(1000).optional(),
});

async function runCompositeFlow(
  symbol: string,
  bars: number,
  weights?: Record<string, number>,
  sentimentOverrides?: Record<string, number | null>
) {
  const candles = await getCandlesWithFallback(symbol, bars);
  if (candles.length < 60) {
    return { error: "Not enough candles", have: candles.length };
  }
  const peerCandles = buildPeerIndex(symbol, bars);
  const adRatio = computeAdvanceDeclineRatio();
  const news = await recentNewsSentimentForSymbol(symbol);
  const result = await runComposite({
    symbol,
    candles,
    peer_candles: peerCandles.length ? peerCandles : undefined,
    sentiment: {
      ad_ratio: adRatio,
      news_sentiment: news,
      ...sentimentOverrides,
    },
    weights,
  });
  if (!result) return { error: "AI composite unavailable" };
  return {
    payload: {
      ...result,
      context: {
        peer_index_bars: peerCandles.length,
        ad_ratio: adRatio,
        news_proxy_score: news ?? null,
      },
    },
  };
}

const backtestSchema = z.object({
  symbol: z.string().min(1),
  bars: z.number().int().min(100).max(1000).optional(),
  warmup: z.number().int().min(30).max(500).optional(),
  entry_score: z.number().min(0).max(100).optional(),
  exit_score: z.number().min(0).max(100).optional(),
  sl_pct: z.number().min(0.001).max(0.5).optional(),
  tp_pct: z.number().min(0.001).max(2.0).nullable().optional(),
  allow_short: z.boolean().optional(),
  sentiment: sentimentSchema,
  weights: z.record(z.number()).optional(),
});

router.post("/backtest", async (req, res, next) => {
  try {
    const body = backtestSchema.parse(req.body);
    const symbol = body.symbol.toUpperCase();
    const candles = await getCandlesWithFallback(symbol, body.bars ?? 500);
    if (candles.length < (body.warmup ?? 60) + 20) {
      return res.status(400).json({ error: "Not enough candles", have: candles.length });
    }
    const peerCandles = buildPeerIndex(symbol, body.bars ?? 500);
    const adRatio = computeAdvanceDeclineRatio();
    const news = await recentNewsSentimentForSymbol(symbol);

    const sentiment = {
      ad_ratio: adRatio,
      news_sentiment: news ?? null,
      ...(body.sentiment ?? {}),
    };

    const result = await runCompositeBacktest({
      symbol,
      candles,
      peer_candles: peerCandles.length ? peerCandles : undefined,
      sentiment,
      weights: body.weights,
      warmup: body.warmup,
      entry_score: body.entry_score,
      exit_score: body.exit_score,
      sl_pct: body.sl_pct,
      tp_pct: body.tp_pct ?? undefined,
      allow_short: body.allow_short,
    });
    if (!result) return res.status(502).json({ error: "AI composite backtest unavailable" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// IMPORTANT: dynamic /:symbol routes must come AFTER specific paths like
// /backtest, otherwise Express matches /:symbol = "backtest".
router.get("/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const { bars } = compositeQuery.parse(req.query);
    const out = await runCompositeFlow(symbol, bars ?? 500);
    if (out.error) return res.status(out.error.includes("candles") ? 400 : 502).json(out);
    res.json(out.payload);
  } catch (err) {
    next(err);
  }
});

const recomputeSchema = z.object({
  weights: z.record(z.number().min(0).max(1)).optional(),
  bars: z.number().int().min(100).max(1000).optional(),
  sentiment: sentimentSchema,
});

router.post("/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const body = recomputeSchema.parse(req.body ?? {});
    const out = await runCompositeFlow(symbol, body.bars ?? 500, body.weights, body.sentiment);
    if (out.error) return res.status(out.error.includes("candles") ? 400 : 502).json(out);
    res.json(out.payload);
  } catch (err) {
    next(err);
  }
});

export default router;
