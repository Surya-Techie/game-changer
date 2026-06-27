import { Router } from "express";
import { z } from "zod";
import { bus, type PatternTrainingProgressEvent } from "../services/eventBus.js";
import { logger } from "../utils/logger.js";

/**
 * Internal webhook receiver for the AI service's training_jobs runner.
 * The Python side POSTs every progress tick to this endpoint
 * (BACKEND_PROGRESS_WEBHOOK in the AI env). We translate the payload into
 * a typed `pattern_training_progress` event on the bus, which the
 * WebSocket layer fans out to admin connections (see marketSocket.ts).
 *
 * Auth model: NOT a user JWT route. Instead, when INTERNAL_WEBHOOK_SECRET
 * is configured we require an `X-Internal-Secret` header matching it.
 * Set both sides (Node env + AI env) to the same long random string.
 * When the env is unset (dev), the route is open — but it should never be
 * exposed to the public internet.
 */

const router = Router();

const progressSchema = z.object({
  job_id: z.string().min(8).max(64),
  status: z.string().min(1).max(40),
  percent: z.coerce.number().int().min(0).max(100).default(0),
  message: z.string().max(500).default(""),
  timeframe: z.string().max(8).optional(),
  finished_at: z.string().optional(),
  error: z.string().optional(),
});

router.post("/train-progress", (req, res) => {
  const secret = process.env.INTERNAL_WEBHOOK_SECRET?.trim();
  if (secret) {
    const provided = req.header("x-internal-secret") ?? "";
    if (provided !== secret) {
      return res.status(401).json({ error: "invalid internal secret" });
    }
  }
  const parsed = progressSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid payload", details: parsed.error.flatten() });
  }
  const ev: PatternTrainingProgressEvent = parsed.data;
  bus.emit("pattern_training_progress", ev);
  if (ev.status === "completed" || ev.status === "failed") {
    logger.info("PatternEngine training progress", ev);
  }
  res.json({ ok: true });
});

export default router;
