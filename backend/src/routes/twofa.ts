import { Router } from "express";
import crypto from "node:crypto";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { User } from "../models/User.js";

const router = Router();
router.use(requireAuth);

router.post("/enroll", async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    const secret = generateSecret();
    const otpauth = generateURI({ issuer: "QTI", label: user.email, secret });
    const qr = await QRCode.toDataURL(otpauth);
    user.twoFactorSecret = secret;
    user.twoFactorEnabled = false;
    await user.save();
    res.json({ otpauth, qr, secret });
  } catch (err) {
    next(err);
  }
});

const verifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

router.post("/verify", async (req, res, next) => {
  try {
    const { code } = verifySchema.parse(req.body);
    const user = await User.findById(req.user!.userId);
    if (!user?.twoFactorSecret) return res.status(400).json({ error: "Enroll first" });
    const result = verifySync({ token: code, secret: user.twoFactorSecret });
    if (!result.valid) return res.status(401).json({ error: "Invalid code" });
    user.twoFactorEnabled = true;
    const recovery = Array.from({ length: 6 }, () => crypto.randomBytes(5).toString("hex"));
    user.twoFactorRecoveryCodes = recovery.map((c) => crypto.createHash("sha256").update(c).digest("hex"));
    await user.save();
    res.json({ enabled: true, recoveryCodes: recovery });
  } catch (err) {
    next(err);
  }
});

router.post("/disable", async (req, res, next) => {
  try {
    const { code } = verifySchema.parse(req.body);
    const user = await User.findById(req.user!.userId);
    if (!user?.twoFactorEnabled || !user.twoFactorSecret)
      return res.status(400).json({ error: "Not enabled" });
    const result = verifySync({ token: code, secret: user.twoFactorSecret });
    if (!result.valid) return res.status(401).json({ error: "Invalid code" });
    user.twoFactorEnabled = false;
    user.twoFactorSecret = null;
    user.twoFactorRecoveryCodes = [];
    await user.save();
    res.json({ enabled: false });
  } catch (err) {
    next(err);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.userId).select("twoFactorEnabled").lean();
    res.json({ enabled: user?.twoFactorEnabled ?? false });
  } catch (err) {
    next(err);
  }
});

export default router;
