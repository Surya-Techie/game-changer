import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  Alert,
  ALERT_TYPE_VALUES,
  FORMULA_INDICATORS,
  FORMULA_OPERATORS,
  FORMULA_TIMEFRAMES,
} from "../models/Alert.js";

const router = Router();
router.use(requireAuth);

const formulaConditionSchema = z.object({
  indicator: z.enum(FORMULA_INDICATORS as unknown as [string, ...string[]]),
  operator: z.enum(FORMULA_OPERATORS as unknown as [string, ...string[]]),
  // Either a numeric literal or another indicator name. Cross-indicator
  // comparisons let users build alerts like "EMA_20 crosses_above EMA_50".
  rhs: z.union([
    z.number(),
    z.enum(FORMULA_INDICATORS as unknown as [string, ...string[]]),
  ]),
});

const createSchema = z
  .object({
    symbol: z.string().min(1),
    type: z.enum(ALERT_TYPE_VALUES as unknown as [string, ...string[]]),
    value: z.number().optional(),
    note: z.string().max(200).optional(),
    soundEnabled: z.boolean().optional(),
    formula: z.array(formulaConditionSchema).min(1).max(6).optional(),
    formulaTimeframe: z.enum(FORMULA_TIMEFRAMES as unknown as [string, ...string[]]).optional(),
    // Phase 11 — PATTERN_ALERT fields. All optional except minConfidence has a sane default.
    patternNames: z.array(z.string().min(1).max(80)).max(50).optional(),
    patternMinConfidence: z.number().int().min(0).max(100).optional(),
    patternDirections: z.array(z.enum(["bullish", "bearish", "continuation", "neutral"])).max(4).optional(),
    patternTimeframes: z.array(z.enum(FORMULA_TIMEFRAMES as unknown as [string, ...string[]])).max(4).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "INDICATOR_FORMULA") {
      if (!v.formula || v.formula.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "formula required for INDICATOR_FORMULA alerts" });
      }
      if (!v.formulaTimeframe) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "formulaTimeframe required for INDICATOR_FORMULA alerts" });
      }
    }
    // PATTERN_ALERT: no hard fields required beyond the defaults. Empty
    // patternNames means "any pattern", which is intentional.
  });

router.get("/", async (req, res, next) => {
  try {
    const alerts = await Alert.find({ userId: req.user!.userId }).sort({ createdAt: -1 }).lean();
    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const count = await Alert.countDocuments({ userId: req.user!.userId, enabled: true });
    if (count >= 20) return res.status(400).json({ error: "Max 20 active alerts per user" });
    const alert = await Alert.create({ ...body, userId: req.user!.userId, symbol: body.symbol.toUpperCase() });
    res.status(201).json({ alert });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const body = z.object({
      enabled: z.boolean().optional(),
      value: z.number().optional(),
      note: z.string().max(200).optional(),
      soundEnabled: z.boolean().optional(),
    }).parse(req.body);
    const alert = await Alert.findOneAndUpdate(
      { _id: req.params.id, userId: req.user!.userId },
      body,
      { new: true }
    );
    if (!alert) return res.status(404).json({ error: "not found" });
    res.json({ alert });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const r = await Alert.findOneAndDelete({ _id: req.params.id, userId: req.user!.userId });
    if (!r) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/history", async (req, res, next) => {
  try {
    const alerts = await Alert.find({
      userId: req.user!.userId,
      lastTriggeredAt: { $exists: true },
    })
      .sort({ lastTriggeredAt: -1 })
      .limit(100)
      .lean();
    const events: Array<{
      id: string;
      symbol: string;
      type: string;
      ts: Date;
      value?: number;
      // For INDICATOR_FORMULA alerts: snapshot of every indicator value
      // that contributed to the trigger so the user can see WHY it fired.
      formulaValues?: Record<string, number>;
    }> = [];
    for (const a of alerts) {
      for (const h of a.history ?? []) {
        events.push({
          id: String(a._id),
          symbol: a.symbol,
          type: a.type,
          ts: h.ts,
          value: h.value ?? undefined,
          formulaValues: (a as unknown as { lastFormulaValues?: Record<string, number> }).lastFormulaValues,
        });
      }
    }
    events.sort((x, y) => y.ts.getTime() - x.ts.getTime());
    res.json({ history: events.slice(0, 100) });
  } catch (err) {
    next(err);
  }
});

router.get("/types", (_req, res) => {
  res.json({
    types: ALERT_TYPE_VALUES,
    formula: {
      indicators: FORMULA_INDICATORS,
      operators: FORMULA_OPERATORS,
      timeframes: FORMULA_TIMEFRAMES,
    },
  });
});

export default router;
