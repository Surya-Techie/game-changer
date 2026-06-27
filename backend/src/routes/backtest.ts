import { Router } from "express";
import { z } from "zod";
import axios from "axios";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { getCandles } from "../services/candleAggregator.js";
import { runBacktest } from "../services/aiClient.js";
import { PATTERN_TIMEFRAMES } from "../models/Pattern.js";
import { logger } from "../utils/logger.js";

const router = Router();
router.use(requireAuth);

const strategySchema = z
  .object({
    regimeFilter: z.boolean().optional(),
    regimeMinAdx: z.number().optional(),
    mtfConfirmation: z.boolean().optional(),
    stopMode: z.enum(["ATR", "FIXED_PCT"]).optional(),
    stopPct: z.number().min(0.1).max(20).optional(),
    targetRR: z.number().min(0.5).max(10).optional(),
  })
  .optional();

const bodySchema = z.object({
  symbol: z.string().min(1),
  capital: z.number().positive().optional(),
  riskPerTradePct: z.number().min(0.1).max(10).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  warmup: z.number().int().min(30).max(500).optional(),
  bars: z.number().int().min(100).max(2000).optional(),
  strategy: strategySchema,
  trailingStopPct: z.number().min(0).max(20).optional(),
  partialTpEnabled: z.boolean().optional(),
  brokerageFlat: z.number().min(0).max(10000).optional(),
  brokeragePct: z.number().min(0).max(1).optional(),
});

router.post("/", async (req, res, next) => {
  try {
    const body = bodySchema.parse(req.body);
    const symbol = body.symbol.toUpperCase();
    const limit = body.bars ?? 500;
    const candles = getCandles(symbol, limit);
    if (candles.length < (body.warmup ?? 60) + 20) {
      return res.status(400).json({ error: "Not enough candles to backtest", have: candles.length });
    }
    const result = await runBacktest(symbol, candles, {
      capital: body.capital,
      riskPerTradePct: body.riskPerTradePct,
      minConfidence: body.minConfidence,
      warmup: body.warmup,
      strategy: body.strategy,
      trailingStopPct: body.trailingStopPct,
      partialTpEnabled: body.partialTpEnabled,
      brokerageFlat: body.brokerageFlat,
      brokeragePct: body.brokeragePct,
    });
    if (!result) return res.status(502).json({ error: "AI service unavailable" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Pattern backtest (Phase 7) ─────────────────────────────────────────────
//
// Proxies to the ai-service /backtest/patterns endpoint. The AI side fetches
// yfinance OHLCV for the date range, walks the rule engine bar-by-bar, and
// returns full trade log + equity curve + per-pattern rollup. We Zod-validate
// the body and forward the service-token header if configured.

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const patternBodySchema = z
  .object({
    symbol: z.string().min(1).max(20),
    start_date: dateString,
    end_date: dateString,
    pattern_names: z.array(z.string().min(1).max(80)).max(150).default([]),
    timeframe: z.enum(PATTERN_TIMEFRAMES as unknown as [string, ...string[]]).default("D1"),
    capital: z.number().positive().max(1_000_000_000).default(100_000),
    risk_per_trade_pct: z.number().min(0.1).max(10).default(1.0),
    min_confidence: z.number().int().min(0).max(100).default(60),
    lookback: z.number().int().min(20).max(300).default(100),
    max_hold_bars: z.number().int().min(1).max(300).default(30),
    slippage_bps: z.number().min(0).max(100).default(2.0),
    brokerage_pct: z.number().min(0).max(1).default(0.0),
  })
  .refine((b) => b.start_date < b.end_date, { message: "start_date must be before end_date" });

router.post("/patterns", async (req, res, next) => {
  try {
    const body = patternBodySchema.parse(req.body);
    const url = `${env.aiServiceUrl}/backtest/patterns`;
    const headers: Record<string, string> = {};
    const tok = process.env.AI_SERVICE_TOKEN ?? "";
    if (tok) headers["X-Service-Token"] = tok;

    const r = await axios.post(url, body, { headers, timeout: 120_000 });
    res.json(r.data);
  } catch (err) {
    const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
    if (ax.response?.status) {
      logger.warn("AI /backtest/patterns failed", { status: ax.response.status, body: ax.response.data });
      return res.status(ax.response.status).json(ax.response.data ?? { error: "ai service error" });
    }
    next(err);
  }
});

// ─── Pattern names (for the frontend multi-select) ────────────────────────

router.get("/patterns/names", async (_req, res, next) => {
  try {
    const url = `${env.aiServiceUrl}/patterns/names`;
    const headers: Record<string, string> = {};
    const tok = process.env.AI_SERVICE_TOKEN ?? "";
    if (tok) headers["X-Service-Token"] = tok;
    const r = await axios.get(url, { headers, timeout: 10_000 });
    res.json(r.data);
  } catch (err) {
    const ax = err as { response?: { status?: number; data?: unknown } };
    if (ax.response?.status) return res.status(ax.response.status).json(ax.response.data ?? {});
    next(err);
  }
});

export default router;
