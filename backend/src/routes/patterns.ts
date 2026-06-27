import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { getCandles } from "../services/candleAggregator.js";
import {
  detectPatterns,
  fetchPatternAccuracy,
  fetchPatternOhlcv,
  getPatternTrainStatus,
  getPatterns,
  scanPatterns,
  submitPatternTrain,
  type PatternChartTimeframe,
  type PatternTimeframe,
} from "../services/aiClient.js";
import { Pattern, PATTERN_DIRECTIONS, PATTERN_TIMEFRAMES } from "../models/Pattern.js";
import { fullBundle, type AnalyticsFilter } from "../services/patternAnalytics.js";
import { consensus } from "../services/patternConsensus.js";

const router = Router();
router.use(requireAuth);

// ─── Zod schemas ──────────────────────────────────────────────────────────

const timeframeSchema = z.enum(PATTERN_TIMEFRAMES as unknown as [string, ...string[]]);

const symbolSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Z0-9.\-&]+$/i, "symbol contains illegal characters")
  .transform((s) => s.toUpperCase());

const detectQuerySchema = z.object({
  timeframe: timeframeSchema.default("D1"),
  lookback: z.coerce.number().int().min(20).max(300).default(100),
});

const scanQuerySchema = z.object({
  symbols: z.string().min(1, "symbols query is required"),
  timeframe: timeframeSchema.default("M15"),
  min_confidence: z.coerce.number().int().min(0).max(100).default(70),
  lookback: z.coerce.number().int().min(20).max(300).default(100),
});

const latestParamsSchema = z.object({ symbol: symbolSchema });

const trainBodySchema = z.object({
  timeframe: timeframeSchema.default("D1"),
  symbols: z.array(z.string().min(1).max(20)).max(60).optional(),
  fast: z.boolean().default(false),
});

// NOTE on Express route ordering: the legacy `/:symbol` route MUST live
// at the bottom of this file. Express matches routes in registration
// order, and `/:symbol` happily matches `scan`, `accuracy`, `analytics`,
// `admin`, etc. — so registering it first would shadow every literal
// path below. Sweep verified.

// ─── /api/patterns/latest/:symbol — Mongo: last N detected patterns ──────

router.get("/latest/:symbol", async (req, res, next) => {
  try {
    const { symbol } = latestParamsSchema.parse(req.params);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 200);
    const docs = await Pattern.find({ symbol })
      .sort({ detected_at: -1 })
      .limit(limit)
      .lean();
    res.json({ symbol, count: docs.length, patterns: docs });
  } catch (err) {
    next(err);
  }
});

// ─── /api/patterns/detect/:symbol — fresh detection pass via ai-service ───

router.get("/detect/:symbol", async (req, res, next) => {
  try {
    const { symbol } = latestParamsSchema.parse(req.params);
    const { timeframe, lookback } = detectQuerySchema.parse(req.query);
    const data = await detectPatterns(symbol, timeframe as PatternTimeframe, lookback);
    if (!data) return res.status(502).json({ error: "ai service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── /api/patterns/consensus/:symbol ─────────────────────────────────────
// Runs the standard pattern detector then collapses ALL detected patterns
// into ONE BUY/SELL/HOLD verdict with calibrated confidence. Returns the
// individual votes in `contributing` for transparency.
router.get("/consensus/:symbol", async (req, res, next) => {
  try {
    const { symbol } = latestParamsSchema.parse(req.params);
    const { timeframe, lookback } = detectQuerySchema.parse(req.query);
    const data = await detectPatterns(symbol, timeframe as PatternTimeframe, lookback);
    if (!data) return res.status(502).json({ error: "ai service unavailable" });

    const verdict = consensus(symbol, data.timeframe ?? timeframe, data.patterns ?? []);
    res.json({
      ...verdict,
      // pass-through context for the UI
      candles_used: data.candles_used,
      served_at_ms: data.served_at_ms,
      cached:       data.cached,
    });
  } catch (err) {
    next(err);
  }
});

// ─── /api/patterns/scan — proxy to ai-service multi-symbol scan ──────────

router.get("/scan", async (req, res, next) => {
  try {
    const parsed = scanQuerySchema.parse(req.query);
    const symbols = parsed.symbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (symbols.length === 0) return res.status(400).json({ error: "no symbols" });
    if (symbols.length > 50) return res.status(400).json({ error: "max 50 symbols per scan" });

    const data = await scanPatterns(symbols, parsed.timeframe as PatternTimeframe, parsed.min_confidence, parsed.lookback);
    if (!data) return res.status(502).json({ error: "ai service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── /api/patterns/ohlcv/:symbol — yfinance OHLCV for the live chart ─────
// Proxies the ai-service /patterns/ohlcv endpoint so the live chart sees
// the same prices the pattern detector ran against — required for the
// entry/SL/TP price lines to land on-screen alongside the candles.

const CHART_TIMEFRAMES = ["M1", "M5", "M15", "H1", "D1", "Y1"] as const;
const ohlcvQuerySchema = z.object({
  timeframe: z.enum(CHART_TIMEFRAMES as unknown as [string, ...string[]]).default("D1"),
  limit: z.coerce.number().int().min(20).max(2000).default(300),
});

router.get("/ohlcv/:symbol", async (req, res, next) => {
  try {
    const { symbol } = latestParamsSchema.parse(req.params);
    const { timeframe, limit } = ohlcvQuerySchema.parse(req.query);
    const data = await fetchPatternOhlcv(symbol, timeframe as PatternChartTimeframe, limit);
    if (!data) return res.status(502).json({ error: "ai service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── /api/patterns/accuracy — Mongo rollups (via ai-service proxy) ───────

router.get("/accuracy", async (_req, res, next) => {
  try {
    const data = await fetchPatternAccuracy();
    if (!data) return res.status(502).json({ error: "ai service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── /api/patterns/train — admin: submit training job ────────────────────

router.post("/train", requireAdmin, async (req, res, next) => {
  try {
    const body = trainBodySchema.parse(req.body ?? {});
    const data = await submitPatternTrain(body.timeframe as PatternTimeframe, body.symbols, body.fast);
    if (!data) return res.status(502).json({ error: "ai service unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── /api/patterns/train/:jobId — poll training job state ────────────────

router.get("/train/:jobId", requireAdmin, async (req, res, next) => {
  try {
    const jobId = z.string().min(8).max(64).parse(req.params.jobId);
    const data = await getPatternTrainStatus(jobId);
    if (!data) return res.status(404).json({ error: "job not found or ai unavailable" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Phase 11 — admin: ai-service /patterns/status proxy (model registry +
// cache backend + mongo health).
router.get("/admin/status", requireAdmin, async (_req, res, next) => {
  try {
    const axios = (await import("axios")).default;
    const url = `${(await import("../config/env.js")).env.aiServiceUrl}/patterns/status`;
    const headers: Record<string, string> = {};
    const tok = process.env.AI_SERVICE_TOKEN ?? "";
    if (tok) headers["X-Service-Token"] = tok;
    const r = await axios.get(url, { headers, timeout: 5_000 });
    res.json(r.data);
  } catch (err) {
    const ax = err as { response?: { status?: number; data?: unknown } };
    if (ax.response?.status) return res.status(ax.response.status).json(ax.response.data ?? {});
    next(err);
  }
});

// ─── Admin: stale pattern cleanup ─────────────────────────────────────────
//
// Patterns store entry / target / stop prices that were valid at detection
// time. After corporate actions (splits, bonuses) or simply after months
// of price drift those prices become absurd relative to the current quote
// — the RELIANCE row showing entry=1349 while the stock trades at 2856 is
// the canonical example. Drawing such a row on the chart yanks the y-axis
// over a 1k-3k range and compresses real candles into a 1-px line.
//
// This route asks the ai-service for each symbol's latest D1 close,
// then deletes (or marks invalid) any pattern row whose entry/SL/TP
// deviates >tolerance%% from that latest close.
router.post("/admin/cleanup-stale", requireAdmin, async (req, res, next) => {
  try {
    const body = z.object({
      tolerance_pct: z.number().min(5).max(80).optional(),
      dry_run: z.boolean().optional(),
    }).parse(req.body ?? {});
    const tolerance = (body.tolerance_pct ?? 30) / 100;
    const dryRun = body.dry_run ?? false;

    const symbols: string[] = await Pattern.distinct("symbol");
    let inspected = 0;
    let stale = 0;
    const offenders: Array<{ symbol: string; latest: number; stale: number }> = [];

    for (const symbol of symbols) {
      const ohlcv = await fetchPatternOhlcv(symbol, "D1", 5);
      const latest = ohlcv?.candles?.[ohlcv.candles.length - 1]?.c;
      if (!latest || latest <= 0) continue;
      const lo = latest * (1 - tolerance);
      const hi = latest * (1 + tolerance);

      const docs = await Pattern.find({ symbol }).lean();
      inspected += docs.length;
      const staleIds: string[] = [];
      for (const d of docs) {
        const prices = [d.entry_price, d.target_price, d.stop_price].filter(
          (x): x is number => typeof x === "number" && isFinite(x) && x > 0,
        );
        if (prices.length === 0) continue;
        const offRange = prices.some((p) => p < lo || p > hi);
        if (offRange) staleIds.push(String(d._id));
      }
      if (staleIds.length > 0) {
        stale += staleIds.length;
        offenders.push({ symbol, latest, stale: staleIds.length });
        if (!dryRun) {
          await Pattern.deleteMany({ _id: { $in: staleIds } });
        }
      }
    }

    res.json({
      symbols_scanned: symbols.length,
      patterns_inspected: inspected,
      patterns_stale: stale,
      deleted: dryRun ? 0 : stale,
      dry_run: dryRun,
      tolerance_pct: Math.round(tolerance * 100),
      offenders: offenders.sort((a, b) => b.stale - a.stale).slice(0, 50),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Pattern Analytics — Phase 10 ─────────────────────────────────────────
//
// Reads the patterns collection directly (no AI service hop) so the
// dashboard refresh is cheap. All aggregation lives in
// services/patternAnalytics.ts. The query string is Zod-validated and the
// dates default to "last 30 days" when omitted.

const analyticsQuerySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  symbols: z.string().optional(),       // comma-separated
  timeframes: z.string().optional(),    // comma-separated
  directions: z.string().optional(),    // comma-separated
});

router.get("/analytics", async (req, res, next) => {
  try {
    const q = analyticsQuerySchema.parse(req.query);
    const since = q.since ? new Date(q.since) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = q.until ? new Date(q.until) : new Date();
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return res.status(400).json({ error: "invalid since/until" });
    }
    if (since.getTime() >= until.getTime()) {
      return res.status(400).json({ error: "since must be before until" });
    }
    const symbols = q.symbols
      ? q.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
      : [];
    const timeframes = q.timeframes
      ? q.timeframes.split(",").map((s) => s.trim().toUpperCase()).filter((s) => (PATTERN_TIMEFRAMES as readonly string[]).includes(s))
      : [];
    const directions = q.directions
      ? q.directions.split(",").map((s) => s.trim().toLowerCase()).filter((s) => (PATTERN_DIRECTIONS as readonly string[]).includes(s))
      : [];

    const filter: AnalyticsFilter = { since, until, symbols, timeframes, directions };
    const bundle = await fullBundle(filter);
    res.json(bundle);
  } catch (err) {
    next(err);
  }
});

// ─── Legacy endpoint (kept for CandlestickPatternsCard) ─────────────────
// MUST be last — `/:symbol` is greedy and would shadow any literal path
// declared after it.

router.get("/:symbol", async (req, res, next) => {
  try {
    const symbol = symbolSchema.parse(req.params.symbol);
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const candles = getCandles(symbol, limit);
    if (candles.length < 30) return res.json({ symbol, detections: [] });
    const detections = await getPatterns(symbol, candles);
    res.json({ symbol, candles: candles.map((c) => c.t), detections });
  } catch (err) {
    next(err);
  }
});

export default router;
