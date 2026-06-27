import os from "node:os";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { User } from "../models/User.js";
import { AuditLog } from "../models/AuditLog.js";
import { Signal } from "../models/Signal.js";
import { Position } from "../models/Position.js";
import { Trade } from "../models/Trade.js";
import { mockFeed } from "../services/mockFeed.js";
import { priceBook } from "../services/priceBook.js";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/users", async (_req, res, next) => {
  try {
    const users = await User.find()
      .select("email name role capital lastLoginAt twoFactorEnabled createdAt")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

router.patch("/users/:id", async (req, res, next) => {
  try {
    const { role } = req.body as { role?: "ADMIN" | "USER" };
    if (role !== "ADMIN" && role !== "USER") return res.status(400).json({ error: "role must be ADMIN or USER" });
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true }).select("-passwordHash");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.get("/signals", async (req, res, next) => {
  try {
    const symbol = (req.query.symbol as string | undefined)?.toUpperCase();
    const filter = symbol ? { symbol } : {};
    const signals = await Signal.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ signals });
  } catch (err) {
    next(err);
  }
});

router.get("/audit", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

router.get("/system", async (_req, res, next) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [users, openPositions, closedTrades, signals, auditCount, signalsToday, activeUsers24h] = await Promise.all([
      User.estimatedDocumentCount(),
      Position.countDocuments({ status: "OPEN" }),
      Trade.estimatedDocumentCount(),
      Signal.estimatedDocumentCount(),
      AuditLog.estimatedDocumentCount(),
      Signal.countDocuments({ createdAt: { $gte: startOfToday } }),
      User.countDocuments({ lastLoginAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
    ]);

    const memory = process.memoryUsage();
    const load = os.loadavg();

    res.json({
      api: { ok: true, uptimeSec: Math.round(process.uptime()), node: process.version, pid: process.pid },
      feed: {
        type: "mock",
        running: mockFeed.symbols().length > 0,
        symbols: mockFeed.symbols(),
        lastPriceCount: Object.keys(priceBook.snapshot()).length,
      },
      memory: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      },
      cpu: { loadAvg1m: load[0], loadAvg5m: load[1], loadAvg15m: load[2], cores: os.cpus().length },
      counters: {
        users,
        activeUsers24h,
        openPositions,
        closedTrades,
        signals,
        signalsToday,
        auditEntries: auditCount,
      },
      universe: mockFeed.symbols(),
      lastPrices: priceBook.snapshot(),
      ts: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
