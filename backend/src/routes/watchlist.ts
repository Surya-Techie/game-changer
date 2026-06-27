import { Router } from "express";
import { z } from "zod";
import { Watchlist } from "../models/Watchlist.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const lists = await Watchlist.find({ userId: req.user!.userId }).lean();
    res.json({ watchlists: lists });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  symbols: z.array(z.string().min(1)).max(50).optional(),
});

router.patch("/:id", async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const list = await Watchlist.findOneAndUpdate(
      { _id: req.params.id, userId: req.user!.userId },
      body,
      { new: true }
    );
    if (!list) return res.status(404).json({ error: "Watchlist not found" });
    res.json({ watchlist: list });
  } catch (err) {
    next(err);
  }
});

export default router;
