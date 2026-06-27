import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

let memServer: { stop: () => Promise<unknown> } | undefined;

// Connection options tuned for the trading workload: long-lived
// connection pool, fast server selection so we surface outages quickly,
// and explicit retryable-write semantics.
const CONNECT_OPTS = {
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  maxPoolSize: 20,
  minPoolSize: 2,
  retryWrites: true,
  retryReads: true,
};

// Reconnect attempts with capped exponential backoff. Bounded so we
// don't sit in an infinite spin if the URI is permanently wrong; after
// the cap we leave Mongoose's built-in retry loop in charge.
const MAX_INITIAL_RETRIES = 8;

export async function connectMongo(): Promise<void> {
  mongoose.set("strictQuery", true);

  if (env.useInmemMongo) {
    const mod = await import("mongodb-memory-server");
    const server = await mod.MongoMemoryServer.create({ instance: { dbName: "qti" } });
    memServer = server;
    const uri = server.getUri();
    await mongoose.connect(uri);
    logger.info("MongoDB connected (in-memory)", { uri });
    attachLifecycleListeners();
    return;
  }

  let attempt = 0;
  while (true) {
    try {
      await mongoose.connect(env.mongoUri, CONNECT_OPTS);
      logger.info("MongoDB connected", { uri: env.mongoUri, attempt });
      break;
    } catch (err) {
      attempt += 1;
      if (attempt > MAX_INITIAL_RETRIES) {
        logger.error("MongoDB connect failed after retries", {
          attempts: attempt,
          err: (err as Error).message,
        });
        throw err;
      }
      const backoffMs = Math.min(30_000, 500 * Math.pow(2, attempt));
      logger.warn("MongoDB connect failed — retrying", {
        attempt,
        backoffMs,
        err: (err as Error).message,
      });
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }
  attachLifecycleListeners();
}

function attachLifecycleListeners() {
  // Only attach once across hot-reloads.
  if ((globalThis as { __qtiMongoListenersAttached?: boolean }).__qtiMongoListenersAttached) return;
  (globalThis as { __qtiMongoListenersAttached?: boolean }).__qtiMongoListenersAttached = true;

  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected — driver will retry automatically");
  });
  mongoose.connection.on("reconnected", () => {
    logger.info("MongoDB reconnected");
  });
  mongoose.connection.on("error", (err) => {
    logger.error("MongoDB connection error", { err: (err as Error).message });
  });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
  if (memServer) await memServer.stop();
}
