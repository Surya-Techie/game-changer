import { Router } from "express";
import axios from "axios";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { redis } from "../db/redis.js";
import { aiHeaders } from "../utils/aiHeaders.js";

const router = Router();
router.use(requireAuth);

const CHAIN_TTL_SEC = 300; // 5 min — matches the ai-service in-process cache
const GREEKS_TTL_SEC = 60;

const symbolSchema = z.string().min(1).max(40).regex(/^[A-Za-z0-9.\-_]+$/);

router.get("/chain/:symbol", async (req, res, next) => {
  try {
    const symbol = symbolSchema.parse(req.params.symbol).toUpperCase();
    const cacheKey = `opt:chain:${symbol}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.setHeader("X-QTI-Cache", "HIT");
      return res.json(JSON.parse(cached));
    }
    const r = await axios.get(`${env.aiServiceUrl}/options/chain/${encodeURIComponent(symbol)}`, {
      timeout: 30_000,
      headers: aiHeaders(),
    });
    await redis.set(cacheKey, JSON.stringify(r.data), "EX", CHAIN_TTL_SEC);
    res.setHeader("X-QTI-Cache", "MISS");
    res.json(r.data);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      // 404 means "this symbol has no listed options" — common for Indian
      // single-stock equities on yfinance. Surface as a clean 200 with an
      // empty `expiries: []` payload so the frontend's optional Options
      // panel can short-circuit without lighting up the browser console
      // with red error lines. Cache the negative result for 5 min too.
      if (err.response.status === 404) {
        const empty = { symbol: req.params.symbol.toUpperCase(), expiries: [], note: "no listed options" };
        await redis.set(`opt:chain:${req.params.symbol.toUpperCase()}`, JSON.stringify(empty), "EX", CHAIN_TTL_SEC);
        res.setHeader("X-QTI-Cache", "MISS");
        return res.json(empty);
      }
      return res.status(err.response.status).json(err.response.data ?? { error: err.message });
    }
    next(err);
  }
});

const greeksParams = z.object({
  symbol: symbolSchema,
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strike: z.coerce.number().positive(),
  kind: z.enum(["CE", "PE"]),
});

router.get("/greeks/:symbol/:expiry/:strike/:kind", async (req, res, next) => {
  try {
    const parsed = greeksParams.parse(req.params);
    const symbol = parsed.symbol.toUpperCase();
    const ivOverride = req.query.iv_override ? Number(req.query.iv_override) : undefined;
    const rate = req.query.rate ? Number(req.query.rate) : undefined;
    const cacheKey = `opt:greeks:${symbol}:${parsed.expiry}:${parsed.strike}:${parsed.kind}:${ivOverride ?? ""}:${rate ?? ""}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.setHeader("X-QTI-Cache", "HIT");
      return res.json(JSON.parse(cached));
    }
    const r = await axios.get(
      `${env.aiServiceUrl}/options/greeks/${encodeURIComponent(symbol)}/${parsed.expiry}/${parsed.strike}/${parsed.kind}`,
      { params: { iv_override: ivOverride, rate }, timeout: 15_000, headers: aiHeaders() }
    );
    await redis.set(cacheKey, JSON.stringify(r.data), "EX", GREEKS_TTL_SEC);
    res.setHeader("X-QTI-Cache", "MISS");
    res.json(r.data);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      return res.status(err.response.status).json(err.response.data ?? { error: err.message });
    }
    next(err);
  }
});

export default router;
