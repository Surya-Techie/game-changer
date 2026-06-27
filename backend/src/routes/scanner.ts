import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { PRESET_SCANS, runScan, type ScanCondition } from "../services/scanner.js";

const router = Router();
router.use(requireAuth);

const conditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["<", "<=", ">", ">=", "==", "!="]),
  value: z.number(),
});

const customSchema = z.object({
  conditions: z.array(conditionSchema).min(1).max(10),
  combinator: z.enum(["AND", "OR"]).default("AND"),
  universe: z.array(z.string()).optional(),
  includeComposite: z.boolean().optional(),
});

router.get("/presets", (_req, res) => {
  res.json({
    presets: Object.entries(PRESET_SCANS).map(([id, scan]) => ({
      id,
      label: id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      ...scan,
    })),
  });
});

router.post("/run", async (req, res, next) => {
  try {
    const body = customSchema.parse(req.body);
    const result = await runScan({
      conditions: body.conditions as ScanCondition[],
      combinator: body.combinator,
      universe: body.universe,
      includeComposite: body.includeComposite,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/preset/:id", async (req, res, next) => {
  try {
    const preset = PRESET_SCANS[req.params.id];
    if (!preset) return res.status(404).json({ error: "preset not found" });
    const universe = (req.body?.universe as string[] | undefined) ?? preset.universe;
    const result = await runScan({ ...preset, universe });
    res.json({ preset: req.params.id, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
