import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AuditLog } from "../models/AuditLog.js";
import { logger } from "../utils/logger.js";

const SENSITIVE_KEYS = new Set(["password", "passwordHash", "token", "secret", "code", "otp", "twoFactorSecret"]);

function redact(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : redact(v);
  }
  return out;
}

function hashBody(body: unknown): string {
  try {
    const json = JSON.stringify(redact(body) ?? {});
    return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Persists an audit row for every state-changing request. Read-only GETs are
 * skipped to keep the table small. Sensitive fields are redacted before hashing.
 */
export function audit(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  const start = Date.now();

  res.on("finish", () => {
    AuditLog.create({
      userId: req.user?.userId,
      email: req.user?.email,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ip: req.ip,
      userAgent: req.get("user-agent")?.slice(0, 200),
      bodyHash: hashBody(req.body),
      durationMs: Date.now() - start,
    }).catch((err) => logger.warn("audit log write failed", { err: (err as Error).message }));
  });

  next();
}
