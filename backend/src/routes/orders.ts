import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { Order } from "../models/Order.js";
import { Position } from "../models/Position.js";
import { paperBroker } from "../services/paperBroker.js";
import { positionManager } from "../services/positionManager.js";
import { evaluateNewPosition } from "../services/riskManager.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const orders = await Order.find({ userId: req.user!.userId }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

const manualOrderSchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  qty: z.number().int().positive().optional(),
  stop: z.number().positive().optional(),
  target: z.number().positive().optional(),
});

router.post("/", async (req, res, next) => {
  try {
    const body = manualOrderSchema.parse(req.body);
    const userId = req.user!.userId;
    const symbol = body.symbol.toUpperCase();

    let qty = body.qty;
    if (!qty && body.stop) {
      // Auto-size against the user's risk profile.
      const lastOrder = await Order.findOne({ symbol }).sort({ filledAt: -1 }).lean();
      const entry = lastOrder?.filledPrice ?? 0;
      if (entry > 0) {
        const decision = await evaluateNewPosition({ userId, symbol, entry, stop: body.stop });
        if (decision.allowed && decision.qty) qty = decision.qty;
      }
    }
    if (!qty || qty <= 0) return res.status(400).json({ error: "qty required when stop is omitted" });

    // Close any opposite open position first (flip).
    const desiredSide: "LONG" | "SHORT" = body.side === "BUY" ? "LONG" : "SHORT";
    const existing = await Position.findOne({ userId, symbol, status: "OPEN" });
    if (existing && existing.side !== desiredSide) {
      await positionManager.closePosition(String(existing._id), "FLIP");
    } else if (existing) {
      return res.status(409).json({ error: "Already long/short this symbol" });
    }

    const fill = await paperBroker.submitMarket({
      userId,
      symbol,
      side: body.side,
      qty,
      source: "MANUAL",
    });

    const pos = await Position.create({
      userId,
      symbol,
      side: desiredSide,
      qty,
      // originalQty is required by the schema (partial-TP bookkeeping);
      // omitting it made every manual order 500 while auto orders worked.
      originalQty: qty,
      entryPrice: fill.filledPrice,
      initialStopPrice: body.stop,
      stopPrice: body.stop,
      targetPrice: body.target,
      highWatermark: fill.filledPrice,
      lowWatermark: fill.filledPrice,
      partialTpDone: false,
    });

    await positionManager.broadcastPortfolio(userId);
    res.status(201).json({ order: { id: fill.orderId, filledPrice: fill.filledPrice }, position: pos });
  } catch (err) {
    next(err);
  }
});

export default router;
