import { Router } from "express";
import axios from "axios";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Thin proxy onto the ai-service Gainz Alpha endpoint. The heavy lifting
 * (yfinance fetch + 23-pattern scan + 4-model ensemble) all happens
 * server-side in Python; this just forwards the JSON.
 *
 * The auth gate is the same as every other /api/* route. We don't add
 * extra caching here because the ai-service caches its own model load
 * and the underlying yfinance OHLCV is the slow part — caching would
 * make pattern detection stale.
 */
const router = Router();
router.use(requireAuth);

const scoreSchema = z.object({
  lookback_days: z.number().int().min(60).max(720).optional(),
  capital: z.number().positive().optional(),
});

router.post("/score/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const body = scoreSchema.parse(req.body ?? {});
    const url = `${env.aiServiceUrl}/gainz-alpha/score`;
    const headers: Record<string, string> = {};
    const tok = process.env.AI_SERVICE_TOKEN ?? "";
    if (tok) headers["X-Service-Token"] = tok;
    const r = await axios.post(
      url,
      { symbol, ...body },
      { headers, timeout: 30_000 },
    );
    res.json(r.data);
  } catch (err) {
    const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
    if (ax.response?.status) {
      return res.status(ax.response.status).json(ax.response.data ?? { error: ax.message });
    }
    logger.warn("gainz-alpha proxy failed", { err: ax.message });
    res.status(502).json({ error: ax.message ?? "ai-service unavailable" });
  }
});

router.get("/health", async (_req, res) => {
  try {
    const url = `${env.aiServiceUrl}/gainz-alpha/health`;
    const r = await axios.get(url, { timeout: 5_000 });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ engine_ready: false, error: (err as Error).message });
  }
});

router.post("/chart-patterns", async (req, res) => {
  try {
    const { candles, min_confidence = 0.4 } = req.body ?? {};
    if (!Array.isArray(candles) || candles.length < 60) {
      return res.json({ patterns: [], reason: "need >= 60 candles" });
    }
    const url = `${env.aiServiceUrl}/gainz-alpha/chart-patterns`;
    const headers: Record<string, string> = {};
    const tok = process.env.AI_SERVICE_TOKEN ?? "";
    if (tok) headers["X-Service-Token"] = tok;
    const r = await axios.post(
      url,
      { candles, min_confidence },
      { headers, timeout: 20_000 },
    );
    res.json(r.data);
  } catch (err) {
    const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
    if (ax.response?.status) {
      return res.status(ax.response.status).json(ax.response.data ?? { error: ax.message });
    }
    res.status(502).json({ error: ax.message ?? "ai-service unavailable" });
  }
});

router.get("/patterns/reliability", async (_req, res) => {
  try {
    const url = `${env.aiServiceUrl}/gainz-alpha/patterns/reliability`;
    const r = await axios.get(url, { timeout: 5_000 });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
