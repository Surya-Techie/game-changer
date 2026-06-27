import { Router } from "express";
import axios from "axios";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Proxy onto ai-service /chan-advisor/*.
 *
 * The Chan advisor is a pure-Python rule engine — no LLM, no API keys —
 * so the proxy is just an auth wrapper + token forwarder.
 */
const router = Router();
router.use(requireAuth);

const recommendSchema = z.object({
  lookback_days: z.number().int().min(60).max(1095).optional(),
  vix: z.number().optional(),
});

router.post("/recommend/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const body = recommendSchema.parse(req.body ?? {});
    const url = `${env.aiServiceUrl}/chan-advisor/recommend`;
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
    logger.warn("chan-advisor proxy failed", { err: ax.message });
    res.status(502).json({ error: ax.message ?? "ai-service unavailable" });
  }
});

router.get("/strategies", async (_req, res) => {
  try {
    const url = `${env.aiServiceUrl}/chan-advisor/strategies`;
    const r = await axios.get(url, { timeout: 5_000 });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
