import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getOrCreateAccountState } from "../services/riskManager.js";
import { logger } from "../utils/logger.js";

const router = Router();
router.use(requireAuth);

const settingsSchema = z.object({
  autoTradeMode: z.enum(["OFF", "SEMI", "AUTO"]).optional(),
  killSwitch: z.boolean().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  maxOpenPositions: z.number().int().min(1).max(20).optional(),
  riskPerTradePct: z.number().min(0.1).max(10).optional(),
  maxDailyLossPct: z.number().min(0.5).max(50).optional(),

  // Strategy switches
  stopMode: z.enum(["ATR", "FIXED_PCT"]).optional(),
  stopPct: z.number().min(0.1).max(20).optional(),
  targetRR: z.number().min(0.5).max(10).optional(),
  trailingStopEnabled: z.boolean().optional(),
  trailingStopPct: z.number().min(0.1).max(20).optional(),
  partialTpEnabled: z.boolean().optional(),
  regimeFilterEnabled: z.boolean().optional(),
  regimeMinAdx: z.number().min(5).max(60).optional(),
  mtfConfirmation: z.boolean().optional(),

  // UI / data prefs (Item 19)
  theme: z.enum(["dark", "light"]).optional(),
  autoRefreshSec: z.number().min(0).max(3600).optional(),
  brokerageFlat: z.number().min(0).max(10000).optional(),
  brokeragePct: z.number().min(0).max(1).optional(),
  taxStcgPct: z.number().min(0).max(50).optional(),
  scannerUniverse: z.enum(["watchlist", "nifty50", "nifty100"]).optional(),
  notificationPrefs: z.object({
    signal: z.boolean().optional(),
    fill: z.boolean().optional(),
    exit: z.boolean().optional(),
    alert: z.boolean().optional(),
    system: z.boolean().optional(),
  }).partial().optional(),
});

router.get("/", async (req, res, next) => {
  try {
    const state = await getOrCreateAccountState(req.user!.userId);
    res.json({ settings: state });
  } catch (err) {
    next(err);
  }
});

router.patch("/", async (req, res, next) => {
  try {
    const body = settingsSchema.parse(req.body);
    const state = await getOrCreateAccountState(req.user!.userId);
    Object.assign(state, body);
    await state.save();
    logger.info("Auto-trade settings updated", { userId: req.user!.userId, ...body });
    res.json({ settings: state });
  } catch (err) {
    next(err);
  }
});

export default router;
