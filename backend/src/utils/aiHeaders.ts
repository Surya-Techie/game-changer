// Shared helper for non-aiClient axios calls that target the FastAPI
// ai-service directly. Returns the headers object every call should
// merge in so the optional X-Service-Token gate accepts us.

const AI_TOKEN = process.env.AI_SERVICE_TOKEN ?? "";

export function aiHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (AI_TOKEN) h["X-Service-Token"] = AI_TOKEN;
  return h;
}
