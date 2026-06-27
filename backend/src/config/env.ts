import "dotenv/config";

const IS_PROD = (process.env.NODE_ENV ?? "development") === "production";
const DEV_JWT_FALLBACK = "dev-secret-change-me-32chars-minimum";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function requiredInProd(name: string, fallback: string): string {
  const v = process.env[name];
  if (v && v.length) return v;
  if (IS_PROD) {
    throw new Error(
      `${name} must be set in production — refusing to start with the dev fallback`
    );
  }
  return fallback;
}

const brokerModeRaw = (process.env.BROKER_MODE ?? "mock").toLowerCase();
const brokerMode: "mock" | "kite" = brokerModeRaw === "kite" ? "kite" : "mock";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  mongoUri: required("MONGO_URI", "mongodb://localhost:27017/qti"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  jwtSecret: requiredInProd("JWT_SECRET", DEV_JWT_FALLBACK),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  aiServiceUrl: process.env.AI_SERVICE_URL ?? "http://localhost:8000",
  signalIntervalMs: Number(process.env.SIGNAL_INTERVAL_MS ?? 15000),
  mockFeedEnabled: (process.env.MOCK_FEED_ENABLED ?? "true") === "true",
  useInmemMongo: (process.env.USE_INMEM_MONGO ?? "false") === "true",
  useInmemCache: (process.env.USE_INMEM_CACHE ?? "false") === "true",

  // Broker integration — defaults to "mock" so existing dev stacks are unaffected.
  brokerMode,
  kiteApiKey: process.env.KITE_API_KEY ?? "",
  kiteApiSecret: process.env.KITE_API_SECRET ?? "",
  kiteAccessToken: process.env.KITE_ACCESS_TOKEN ?? "",
  kiteRedirectUri: process.env.KITE_REDIRECT_URI ?? "",
} as const;
