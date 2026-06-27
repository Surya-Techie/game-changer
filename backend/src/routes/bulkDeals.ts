import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getBulkDeals, watchlistSymbolsInDeals } from "../services/bulkDeals.js";
import { Watchlist } from "../models/Watchlist.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const data = await getBulkDeals(req.query.force === "true");
    // Surface which user-watchlist symbols appear, for the badge feature.
    const userWatchlists = await Watchlist.find({ userId: req.user!.userId }).select("symbols").lean();
    const watched = new Set<string>();
    for (const w of userWatchlists) for (const s of w.symbols ?? []) watched.add(s.toUpperCase());
    const matched = watchlistSymbolsInDeals([...watched], data.rows);
    res.json({
      ts: data.ts,
      fromNse: data.fromNse,
      note: data.note,
      rows: data.rows,
      watchlistMatches: [...matched],
    });
  } catch (err) {
    next(err);
  }
});

export default router;
