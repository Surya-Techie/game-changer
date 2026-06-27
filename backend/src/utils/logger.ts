// Structured logger. Defaults to human-friendly text in development and
// flips to single-line JSON in production (so log aggregators like
// Loki / Cloudwatch / Datadog can parse cleanly). Toggle explicitly via
// LOG_FORMAT=json|text — overrides the NODE_ENV default.

type Level = "info" | "warn" | "error" | "debug";

const FORMAT =
  (process.env.LOG_FORMAT as "json" | "text" | undefined) ??
  (process.env.NODE_ENV === "production" ? "json" : "text");
const LEVEL = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldLog(level: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[LEVEL];
}

function fmtText(level: Level, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const tag = `[${ts}] [${level.toUpperCase()}]`;
  if (meta !== undefined) return `${tag} ${msg} ${JSON.stringify(meta)}`;
  return `${tag} ${msg}`;
}

function fmtJson(level: Level, msg: string, meta?: unknown) {
  const obj: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
  if (meta && typeof meta === "object") Object.assign(obj, meta);
  else if (meta !== undefined) obj.meta = meta;
  return JSON.stringify(obj);
}

function out(level: Level, msg: string, meta?: unknown) {
  if (!shouldLog(level)) return;
  const line = FORMAT === "json" ? fmtJson(level, msg, meta) : fmtText(level, msg, meta);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, meta?: unknown) => out("info", msg, meta),
  warn: (msg: string, meta?: unknown) => out("warn", msg, meta),
  error: (msg: string, meta?: unknown) => out("error", msg, meta),
  debug: (msg: string, meta?: unknown) => out("debug", msg, meta),
};
