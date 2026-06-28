import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../utils/jwt.js";
import { env } from "../config/env.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: JwtPayload;
  }
}

// Default identity used when auth is disabled (login UI removed for now).
// userId is a valid 24-hex ObjectId so Mongoose casts cleanly on per-user
// queries. All un-authenticated requests share this single dev account.
// Exported so the WebSocket hub can route broadcasts to the same identity.
export const DEV_USER: JwtPayload = {
  userId: "000000000000000000000001",
  email: "dev@local",
};

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  // Honour a real token when one is supplied, even with auth disabled.
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length);
    try {
      req.user = verifyToken(token);
      return next();
    } catch {
      if (!env.authDisabled) return res.status(401).json({ error: "Invalid token" });
    }
  }

  if (env.authDisabled) {
    req.user = DEV_USER;
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}
