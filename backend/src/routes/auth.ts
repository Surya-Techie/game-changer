import { Router } from "express";
import bcrypt from "bcryptjs";
import { verifySync } from "otplib";
import { z } from "zod";
import { User } from "../models/User.js";
import { Watchlist } from "../models/Watchlist.js";
import { signToken } from "../utils/jwt.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

router.post("/register", async (req, res, next) => {
  try {
    const { email, password, name } = registerSchema.parse(req.body);
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const passwordHash = await bcrypt.hash(password, 10);
    // Become ADMIN if no admin currently exists — self-healing in dev mode
    // where in-memory Mongo resets, and a safe bootstrap path in prod.
    const adminExists = await User.exists({ role: "ADMIN" });
    const user = await User.create({
      email,
      passwordHash,
      name: name ?? "",
      role: adminExists ? "USER" : "ADMIN",
    });

    await Watchlist.create({
      userId: user._id,
      name: "Default",
      symbols: ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK"],
    });

    const token = signToken({ userId: String(user._id), email: user.email });
    res.status(201).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        capital: user.capital,
      },
    });
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  twoFactorCode: z.string().regex(/^\d{6}$/).optional(),
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password, twoFactorCode } = loginSchema.parse(req.body);
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    if (user.twoFactorEnabled) {
      if (!twoFactorCode) return res.status(401).json({ error: "2FA required", twoFactorRequired: true });
      const ok =
        user.twoFactorSecret &&
        verifySync({ token: twoFactorCode, secret: user.twoFactorSecret }).valid;
      if (!ok) return res.status(401).json({ error: "Invalid 2FA code" });
    }

    user.lastLoginAt = new Date();
    user.lastLoginIp = req.ip ?? "";
    await user.save();

    const token = signToken({ userId: String(user._id), email: user.email });
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        capital: user.capital,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Dev-mode admin bootstrap: promote the calling user to ADMIN if no admin
 * exists yet, OR if NODE_ENV !== production. Useful after in-memory DB resets.
 */
router.post("/bootstrap-admin", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.role === "ADMIN") return res.json({ ok: true, role: "ADMIN", reason: "already-admin" });
    const adminExists = await User.exists({ role: "ADMIN" });
    const inDev = (process.env.NODE_ENV ?? "development") !== "production";
    if (adminExists && !inDev) {
      return res.status(403).json({ error: "An admin already exists; bootstrap disabled in production" });
    }
    user.role = "ADMIN";
    await user.save();
    res.json({ ok: true, role: "ADMIN", reason: adminExists ? "dev-mode-promotion" : "no-admin-existed" });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.userId).select("-passwordHash -twoFactorSecret -twoFactorRecoveryCodes");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

export default router;
