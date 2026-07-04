import type { NextFunction, Request, Response } from "express";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { DEV_USER } from "./auth.js";

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  // With auth disabled (dev), the shared dev identity gets admin access —
  // there is no login flow to promote a user through, and the admin panel
  // (model training, pattern status) is part of the dev workflow.
  if (env.authDisabled && req.user.userId === DEV_USER.userId) return next();
  const user = await User.findById(req.user.userId).select("role").lean();
  if (user?.role !== "ADMIN") return res.status(403).json({ error: "Admin only" });
  next();
}
