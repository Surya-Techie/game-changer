import { createServer } from "node:http";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { connectMongo, disconnectMongo } from "./db/mongo.js";
import { seedPatternsIfEmpty } from "./db/seedPatterns.js";
import { migrateAccountDefaults } from "./db/migrateAccountDefaults.js";
import "./db/redis.js"; // initialises cache (in-mem or Redis)
import { mockFeed } from "./services/mockFeed.js";
import { candleAggregator } from "./services/candleAggregator.js";
import "./services/priceBook.js"; // attach to mockFeed
import { attachWebSocket } from "./ws/marketSocket.js";
import { startSignalEngine } from "./services/signalEngine.js";
import { signalOutcomeTracker } from "./services/signalOutcomeTracker.js";
import { autoTrader } from "./services/autoTrader.js";
import { positionManager } from "./services/positionManager.js";
import { startPortfolioBroadcaster } from "./services/portfolioBroadcaster.js";
import { startAlertWatcher } from "./services/alertWatcher.js";
import { paperPositionManager } from "./services/paper/paperPositionManager.js";
import { startNotifierBridge } from "./services/notifierBridge.js";
import { startPatternEngine, stopPatternEngine } from "./services/patternEngine.js";
import { logger } from "./utils/logger.js";

async function main() {
  await connectMongo();
  await migrateAccountDefaults();

  // Demo seed for the Pattern Analytics dashboard in dev / in-mem-Mongo
  // mode. Skips automatically when the collection already has documents,
  // so production deployments are untouched.
  if (env.useInmemMongo || process.env.SEED_PATTERN_ANALYTICS === "true") {
    try {
      await seedPatternsIfEmpty();
    } catch (err) {
      logger.warn("Pattern seeder failed (continuing)", { err: (err as Error).message });
    }
  }

  const app = createApp();
  const server = createServer(app);
  attachWebSocket(server);

  if (env.mockFeedEnabled) {
    // Seed candle history from REAL NSE bars (non-blocking — the signal
    // engine simply waits until a symbol has ≥30 candles). Falls back to
    // the synthetic seed only in offline dev mode.
    void candleAggregator.warmupReal(500);
    mockFeed.start(800);
  }

  startSignalEngine();
  await signalOutcomeTracker.start();
  autoTrader.start();
  positionManager.start();
  startPortfolioBroadcaster();
  startAlertWatcher();
  paperPositionManager.start();
  startNotifierBridge();
  startPatternEngine();

  server.listen(env.port, () => {
    logger.info(`QTI backend listening on :${env.port}`);
  });

  const shutdown = async (sig: string) => {
    logger.warn(`Received ${sig}, shutting down`);
    stopPatternEngine();
    mockFeed.stop();
    server.close();
    await disconnectMongo();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Fatal startup error", { err: (err as Error).message });
  process.exit(1);
});
