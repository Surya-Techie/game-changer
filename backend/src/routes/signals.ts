import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Signal } from "../models/Signal.js";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const symbol = (req.query.symbol as string | undefined)?.toUpperCase();
    const filter = symbol ? { symbol } : {};
    const signals = await Signal.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ signals });
  } catch (err) {
    next(err);
  }
});

router.get("/latest/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const signal = await Signal.findOne({ symbol }).sort({ createdAt: -1 }).lean();
    res.json({ signal });
  } catch (err) {
    next(err);
  }
});

interface AccuracyBucket {
  symbol: string | "ALL";
  wins: number;
  losses: number;
  pending: number;
  expired: number;
  total: number;
  hitRate: number | null; // wins / (wins + losses); null if denom is 0
}

function bucket(symbol: string | "ALL"): AccuracyBucket {
  return { symbol, wins: 0, losses: 0, pending: 0, expired: 0, total: 0, hitRate: null };
}

function finalize(b: AccuracyBucket): AccuracyBucket {
  const denom = b.wins + b.losses;
  b.hitRate = denom > 0 ? b.wins / denom : null;
  return b;
}

router.get("/accuracy", async (req, res, next) => {
  try {
    // Rolling window over the most recent N non-HOLD signals (capped to keep
    // the response cheap). Defaults give roughly the last few hundred trades.
    const limit = Math.min(2000, Math.max(50, Number(req.query.limit) || 500));
    const symbolFilter = (req.query.symbol as string | undefined)?.toUpperCase();
    // ?source=live | synthetic | all (default all). "live" restricts the
    // hit rate to signals generated from real NSE ticks — synthetic dev-feed
    // signals say nothing about real-market accuracy.
    const source = ((req.query.source as string | undefined) ?? "all").toLowerCase();
    const filter: Record<string, unknown> = { action: { $in: ["BUY", "SELL"] } };
    if (symbolFilter) filter.symbol = symbolFilter;
    if (source === "live") filter.dataSource = "live";
    else if (source === "synthetic") filter.dataSource = { $ne: "live" };

    const rows = await Signal.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("symbol outcome dataSource")
      .lean();

    const overall = bucket("ALL");
    const liveOnly = bucket("ALL");
    const bySymbol = new Map<string, AccuracyBucket>();

    for (const r of rows) {
      overall.total++;
      const isLive = (r as { dataSource?: string }).dataSource === "live";
      if (isLive) liveOnly.total++;
      const sym = bySymbol.get(r.symbol) ?? bucket(r.symbol);
      sym.total++;
      switch (r.outcome) {
        case "WIN":
          overall.wins++;
          sym.wins++;
          if (isLive) liveOnly.wins++;
          break;
        case "LOSS":
          overall.losses++;
          sym.losses++;
          if (isLive) liveOnly.losses++;
          break;
        case "EXPIRED":
          overall.expired++;
          sym.expired++;
          if (isLive) liveOnly.expired++;
          break;
        default:
          overall.pending++;
          sym.pending++;
          if (isLive) liveOnly.pending++;
      }
      bySymbol.set(r.symbol, sym);
    }

    finalize(overall);
    finalize(liveOnly);
    const perSymbol = Array.from(bySymbol.values()).map(finalize);

    res.json({
      window: limit,
      source,
      overall,
      liveOnly,
      perSymbol,
      // Reminder for any UI/consumer that wants to display this honestly.
      disclaimer:
        "Measured hit rate on past signals only. No trading system is 100% accurate; this number does not predict future results.",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
