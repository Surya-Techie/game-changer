import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { PaperOrder } from "../models/PaperOrder.js";
import { PaperPosition } from "../models/PaperPosition.js";
import { PaperTrade } from "../models/PaperTrade.js";
import {
  listAccounts,
  createAccount,
  activateAccount,
  resetAccount,
  getActiveAccount,
  portfolioSummary,
  placeOrder,
  cancelOrder,
  modifyOrder,
  closePosition,
  modifyPosition,
  previewOrder,
} from "../services/paper/paperEngine.js";
import { paperPriceFeed } from "../services/paper/priceFeed.js";
import { marketStatus } from "../services/paper/marketHours.js";
import { buildAnalytics } from "../services/paper/analytics.js";
import { computeBadges } from "../services/paper/achievements.js";
import { reviewByTradeId } from "../services/paper/tradeReview.js";
import { buildWeeklyReview } from "../services/paper/weeklyReview.js";
import { buildLeaderboard } from "../services/paper/leaderboard.js";

const router = Router();
router.use(requireAuth);

function asyncH(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

function userId(req: Request): string {
  return req.user!.userId;
}

// ─────────────────────────────────────────────────────────────────────
// Market status — handy for the paper header
// ─────────────────────────────────────────────────────────────────────
router.get("/market-status", (_req, res) => {
  res.json(marketStatus());
});

// ─────────────────────────────────────────────────────────────────────
// ACCOUNTS
// ─────────────────────────────────────────────────────────────────────

const createAccountSchema = z.object({
  name: z.string().min(1).max(40),
  startingCapital: z.number().min(10_000).max(100_000_000).default(1_000_000),
});

router.get(
  "/accounts",
  asyncH(async (req, res) => {
    // Make sure there's at least one (auto-create on first hit).
    await getActiveAccount(userId(req));
    const accounts = await listAccounts(userId(req));
    res.json({ accounts });
  })
);

router.post(
  "/accounts",
  asyncH(async (req, res) => {
    const body = createAccountSchema.parse(req.body ?? {});
    const account = await createAccount(userId(req), body.name, body.startingCapital);
    res.status(201).json({ account });
  })
);

router.patch(
  "/accounts/:id/activate",
  asyncH(async (req, res) => {
    const account = await activateAccount(userId(req), req.params.id);
    res.json({ account });
  })
);

// POST style for the spec's reset (DELETE-with-side-effect is awkward in REST clients).
router.post(
  "/accounts/:id/reset",
  asyncH(async (req, res) => {
    const account = await resetAccount(userId(req), req.params.id);
    res.json({ account });
  })
);
router.delete(
  "/accounts/:id/reset",
  asyncH(async (req, res) => {
    const account = await resetAccount(userId(req), req.params.id);
    res.json({ account });
  })
);

// ─────────────────────────────────────────────────────────────────────
// PORTFOLIO
// ─────────────────────────────────────────────────────────────────────

async function resolveAccountId(req: Request): Promise<string> {
  const fromQuery = (req.query.accountId as string | undefined) || undefined;
  if (fromQuery) return fromQuery;
  const active = await getActiveAccount(userId(req));
  if (!active) throw httpError(404, "No paper account");
  return String(active._id);
}

router.get(
  "/portfolio",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const summary = await portfolioSummary(userId(req), accountId);
    res.json({ portfolio: summary });
  })
);

// ─────────────────────────────────────────────────────────────────────
// PRICE
// ─────────────────────────────────────────────────────────────────────
router.get(
  "/price/:symbol",
  asyncH(async (req, res) => {
    const q = await paperPriceFeed.fetch(req.params.symbol);
    if (!q) return res.status(503).json({ error: "Price unavailable" });
    res.json(q);
  })
);

// ─────────────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────────────

const placeOrderSchema = z.object({
  accountId: z.string().optional(),
  symbol: z.string().min(1).max(20),
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MARKET", "LIMIT", "SL_MARKET", "SL_LIMIT"]),
  qty: z.number().int().min(1).max(100_000),
  limitPrice: z.number().positive().optional(),
  triggerPrice: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  trailingStopPct: z.number().min(0.1).max(20).optional(),
  productType: z.enum(["MIS", "CNC"]).optional(),
  validity: z.enum(["DAY", "IOC", "GTC"]).optional(),
  strategyTag: z.string().max(40).optional(),
  acceptQueue: z.boolean().optional(),
});

router.post(
  "/orders/preview",
  asyncH(async (req, res) => {
    const body = z
      .object({
        symbol: z.string().min(1),
        side: z.enum(["BUY", "SELL"]),
        orderType: z.enum(["MARKET", "LIMIT", "SL_MARKET", "SL_LIMIT"]),
        qty: z.number().int().min(1),
        limitPrice: z.number().positive().optional(),
        triggerPrice: z.number().positive().optional(),
        stopLoss: z.number().positive().optional(),
        takeProfit: z.number().positive().optional(),
        productType: z.enum(["MIS", "CNC"]).default("MIS"),
      })
      .parse(req.body);
    const preview = await previewOrder(body);
    res.json({ preview });
  })
);

router.post(
  "/orders",
  asyncH(async (req, res) => {
    const body = placeOrderSchema.parse(req.body);
    const accountId = body.accountId ?? (await resolveAccountId(req));
    const result = await placeOrder(userId(req), { ...body, accountId });
    res.status(201).json(result);
  })
);

router.get(
  "/orders",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const status = (req.query.status as string | undefined) ?? "PENDING,QUEUED";
    const orders = await PaperOrder.find({
      accountId,
      status: { $in: status.split(",") },
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ orders });
  })
);

const modifyOrderSchema = z.object({
  qty: z.number().int().min(1).optional(),
  limitPrice: z.number().positive().optional(),
  triggerPrice: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  trailingStopPct: z.number().min(0.1).max(20).optional(),
});

router.patch(
  "/orders/:id",
  asyncH(async (req, res) => {
    const body = modifyOrderSchema.parse(req.body);
    const order = await modifyOrder(userId(req), req.params.id, body);
    res.json({ order });
  })
);

router.delete(
  "/orders/:id",
  asyncH(async (req, res) => {
    const order = await cancelOrder(userId(req), req.params.id);
    res.json({ order });
  })
);

// ─────────────────────────────────────────────────────────────────────
// POSITIONS
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/positions",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const positions = await PaperPosition.find({ accountId }).sort({ openedAt: -1 }).lean();
    res.json({ positions });
  })
);

const closeSchema = z.object({
  qty: z.number().int().min(1).optional(),
  exitReason: z.enum(["MANUAL", "SL", "TP", "TRAILING", "SIGNAL_FLIP", "AUTO_SQUAREOFF_EOD", "PARTIAL_MANUAL"]).optional(),
});

router.post(
  "/positions/:id/close",
  asyncH(async (req, res) => {
    const body = closeSchema.parse(req.body ?? {});
    const result = await closePosition(userId(req), req.params.id, body);
    res.json(result);
  })
);

const modifyPositionSchema = z.object({
  stopLoss: z.number().positive().nullable().optional(),
  takeProfit: z.number().positive().nullable().optional(),
  trailingStopPct: z.number().min(0.1).max(20).nullable().optional(),
  notes: z.string().max(2000).optional(),
  strategyTag: z.string().max(40).optional(),
});

router.patch(
  "/positions/:id",
  asyncH(async (req, res) => {
    const body = modifyPositionSchema.parse(req.body);
    const position = await modifyPosition(userId(req), req.params.id, body);
    res.json({ position });
  })
);

// ─────────────────────────────────────────────────────────────────────
// TRADES
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/trades",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const until = req.query.until ? new Date(req.query.until as string) : undefined;
    const symbol = req.query.symbol as string | undefined;
    const direction = req.query.direction as "LONG" | "SHORT" | undefined;
    const result = (req.query.result as "WIN" | "LOSS" | undefined) ?? undefined;
    const strategy = req.query.strategy as string | undefined;

    const q: Record<string, unknown> = { accountId };
    if (since || until) {
      q.exitTime = {} as Record<string, Date>;
      if (since) (q.exitTime as Record<string, Date>).$gte = since;
      if (until) (q.exitTime as Record<string, Date>).$lte = until;
    }
    if (symbol) q.symbol = symbol.toUpperCase();
    if (direction) q.direction = direction;
    if (result) q.netPnl = result === "WIN" ? { $gt: 0 } : { $lt: 0 };
    if (strategy) q.strategyTag = strategy;

    const [trades, total] = await Promise.all([
      PaperTrade.find(q).sort({ exitTime: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PaperTrade.countDocuments(q),
    ]);
    res.json({ trades, total, page, limit });
  })
);

const tradeJournalSchema = z.object({
  preTradePlan: z.string().max(2000).optional(),
  mistake: z.string().max(2000).optional(),
  lesson: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  executionStars: z.number().int().min(0).max(5).optional(),
  emotionTagEntry: z.enum(["", "Calm", "Confident", "FOMO", "Anxious", "Revenge", "Bored", "Excited"]).optional(),
  emotionTagExit: z.enum(["", "Calm", "Confident", "FOMO", "Anxious", "Revenge", "Bored", "Excited"]).optional(),
  qualityTag: z.enum(["", "A+", "A", "B", "C", "Mistake"]).optional(),
  setupType: z.enum(["", "Trend", "Breakout", "Reversion", "Scalp", "News", "Other"]).optional(),
  screenshot: z.string().max(700_000).optional(), // base64-encoded, capped at ~500KB raw
});

router.patch(
  "/trades/:id",
  asyncH(async (req, res) => {
    const body = tradeJournalSchema.parse(req.body);
    const trade = await PaperTrade.findOneAndUpdate(
      { _id: req.params.id, userId: userId(req) },
      { $set: body },
      { new: true }
    );
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    res.json({ trade });
  })
);

// ─────────────────────────────────────────────────────────────────────
// ANALYTICS + ACHIEVEMENTS
// ─────────────────────────────────────────────────────────────────────

router.get(
  "/analytics",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const data = await buildAnalytics(userId(req), accountId);
    res.json(data);
  })
);

router.get(
  "/achievements",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const badges = await computeBadges(userId(req), accountId);
    res.json({ badges });
  })
);

// ─────────────────────────────────────────────────────────────────────
// PAPER vs BACKTEST COMPARISON (Section 15)
// ─────────────────────────────────────────────────────────────────────
router.get(
  "/vs-backtest",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const trades = await PaperTrade.find({ accountId }).lean();
    const totalPnl = trades.reduce((a, t) => a + t.netPnl, 0);
    const winRate = trades.length ? (trades.filter((t) => t.netPnl > 0).length / trades.length) * 100 : 0;
    const avgHold = trades.length ? trades.reduce((a, t) => a + t.holdDurationMins, 0) / trades.length : 0;
    res.json({
      paper: {
        totalPnl: round2(totalPnl),
        winRate: round2(winRate),
        trades: trades.length,
        avgHoldMins: Math.round(avgHold),
      },
      // Backtest comparison is rendered against the user-selected baseline
      // on the frontend by calling the existing /api/backtest endpoint.
      // This endpoint returns the paper side only; the frontend joins them.
    });
  })
);

// Auto-review of a closed paper trade — heuristic commentary derived
// from the trade's own data + entry-signal snapshot.
router.get(
  "/trades/:id/review",
  asyncH(async (req, res) => {
    const review = await reviewByTradeId(userId(req), req.params.id);
    if (!review) return res.status(404).json({ error: "Trade not found" });
    res.json({ review });
  })
);

// Weekly journal template — last 7 IST days.
router.get(
  "/weekly-review",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const data = await buildWeeklyReview(userId(req), accountId);
    res.json(data);
  })
);

// Cross-user leaderboard, optionally scoped to since=<ISO>.
router.get(
  "/leaderboard",
  asyncH(async (req, res) => {
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const limit = req.query.limit ? Math.min(100, Number(req.query.limit)) : 50;
    const rows = await buildLeaderboard({ since, limit, meUserId: userId(req) });
    res.json({ rows, since: (since ?? new Date(Date.now() - 30 * 86_400_000)).toISOString(), limit });
  })
);

// Tax / capital-gains CSV export. Filters by Indian FY (Apr 1 → Mar 31)
// if `fy=2025-26` is provided; otherwise dumps all trades. Output is a
// streaming CSV with one row per closed trade so the user can paste it
// into ITR-2 or hand it to their CA.
router.get(
  "/trades/export.csv",
  asyncH(async (req, res) => {
    const accountId = await resolveAccountId(req);
    const fy = req.query.fy as string | undefined;
    const q: Record<string, unknown> = { accountId };
    if (fy && /^\d{4}-\d{2}$/.test(fy)) {
      const start = Number(fy.slice(0, 4));
      const end = 2000 + Number(fy.slice(5));
      q.exitTime = { $gte: new Date(`${start}-04-01T00:00:00+05:30`), $lte: new Date(`${end}-03-31T23:59:59+05:30`) };
    }
    const trades = await PaperTrade.find(q).sort({ exitTime: 1 }).lean();
    const headers = [
      "exit_time", "symbol", "direction", "qty", "entry_price", "exit_price",
      "hold_minutes", "gross_pnl", "brokerage", "net_pnl", "pnl_pct",
      "exit_reason", "product_type", "strategy_tag",
    ];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const lines: string[] = [headers.join(",")];
    for (const t of trades) {
      lines.push([
        new Date(t.exitTime).toISOString(),
        t.symbol,
        t.direction,
        t.qty,
        t.entryPrice,
        t.exitPrice,
        t.holdDurationMins,
        t.grossPnl,
        t.brokerage,
        t.netPnl,
        t.pnlPct,
        t.exitReason,
        t.productType,
        t.strategyTag ?? "",
      ].map(escape).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="qti-trades${fy ? `-${fy}` : ""}.csv"`);
    res.send(lines.join("\n"));
  })
);

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

interface HttpError extends Error {
  status: number;
}
function httpError(status: number, message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.status = status;
  return e;
}

export default router;
