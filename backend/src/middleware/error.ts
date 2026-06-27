import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../utils/logger.js";

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "ValidationError", issues: err.issues });
  }
  const status = (err as { status?: number })?.status ?? 500;
  const message = (err as { message?: string })?.message ?? "Internal error";
  if (status >= 500) logger.error("Unhandled error", { message });
  res.status(status).json({ error: message });
}
