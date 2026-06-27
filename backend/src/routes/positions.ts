import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Position } from "../models/Position.js";
import { positionManager } from "../services/positionManager.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const status = (req.query.status as string | undefined)?.toUpperCase();
    const filter: Record<string, unknown> = { userId: req.user!.userId };
    if (status === "OPEN" || status === "CLOSED") filter.status = status;
    const positions = await Position.find(filter).sort({ entryAt: -1 }).limit(100).lean();
    res.json({ positions });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const pos = await Position.findOne({ _id: req.params.id, userId: req.user!.userId, status: "OPEN" });
    if (!pos) return res.status(404).json({ error: "Open position not found" });
    await positionManager.closePosition(String(pos._id), "MANUAL");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
