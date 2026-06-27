import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { ChartLayout } from "../models/ChartLayout.js";

const router = Router();
router.use(requireAuth);

const MAX_LAYOUTS_PER_SYMBOL = 5;
const MAX_DATA_BYTES = 250_000; // ~ ample for a few hundred drawings

const saveSchema = z.object({
  symbol: z.string().min(1).max(40),
  name: z.string().min(1).max(40),
  data: z.unknown(),
});

router.get("/", async (req, res, next) => {
  try {
    const symbol = (req.query.symbol as string | undefined)?.toUpperCase();
    const q: Record<string, unknown> = { userId: req.user!.userId };
    if (symbol) q.symbol = symbol;
    const layouts = await ChartLayout.find(q).sort({ updatedAt: -1 }).lean();
    res.json({ layouts });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const body = saveSchema.parse(req.body);
    const symbol = body.symbol.toUpperCase();
    const size = Buffer.byteLength(JSON.stringify(body.data ?? null));
    if (size > MAX_DATA_BYTES) {
      return res.status(413).json({ error: `Layout exceeds ${MAX_DATA_BYTES} bytes` });
    }

    // Upsert by (user, symbol, name). If a brand-new name and the user is
    // already at the cap, reject — don't silently delete an older layout.
    const existing = await ChartLayout.findOne({
      userId: req.user!.userId,
      symbol,
      name: body.name,
    });

    if (!existing) {
      const count = await ChartLayout.countDocuments({ userId: req.user!.userId, symbol });
      if (count >= MAX_LAYOUTS_PER_SYMBOL) {
        return res.status(400).json({
          error: `Max ${MAX_LAYOUTS_PER_SYMBOL} layouts per symbol. Delete one before saving a new layout.`,
        });
      }
    }

    const layout = await ChartLayout.findOneAndUpdate(
      { userId: req.user!.userId, symbol, name: body.name },
      { $set: { data: body.data ?? {} } },
      { upsert: true, new: true }
    );
    res.status(201).json({ layout });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const r = await ChartLayout.findOneAndDelete({ _id: req.params.id, userId: req.user!.userId });
    if (!r) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
