import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth.js";
import twofaRoutes from "./routes/twofa.js";
import watchlistRoutes from "./routes/watchlist.js";
import marketRoutes from "./routes/market.js";
import signalRoutes from "./routes/signals.js";
import positionRoutes from "./routes/positions.js";
import tradeRoutes from "./routes/trades.js";
import orderRoutes from "./routes/orders.js";
import portfolioRoutes from "./routes/portfolio.js";
import autotradeRoutes from "./routes/autotrade.js";
import indicatorRoutes from "./routes/indicators.js";
import patternRoutes from "./routes/patterns.js";
import gainzAlphaRoutes from "./routes/gainzAlpha.js";
import chanAdvisorRoutes from "./routes/chanAdvisor.js";
import backtestRoutes from "./routes/backtest.js";
import adminRoutes from "./routes/admin.js";
import predictionRoutes from "./routes/prediction.js";
import ppsSignalsRoutes from "./routes/ppsSignals.js";
import powerAnalysisRoutes from "./routes/powerAnalysis.js";
import newsRoutes from "./routes/news.js";
import compositeRoutes from "./routes/composite.js";
import analysisRoutes from "./routes/analysis.js";
import scannerRoutes from "./routes/scanner.js";
import marketOverviewRoutes from "./routes/marketOverview.js";
import alertRoutes from "./routes/alerts.js";
import portfolioAnalyticsRoutes from "./routes/portfolioAnalytics.js";
import calendarRoutes from "./routes/calendar.js";
import bulkDealsRoutes from "./routes/bulkDeals.js";
import premiumRoutes from "./routes/premium.js";
import topStocksRoutes from "./routes/topStocks.js";
import mlRoutes from "./routes/ml.js";
import paperRoutes from "./routes/paper.js";
import brokerRoutes from "./routes/broker.js";
import chartLayoutRoutes from "./routes/chartLayouts.js";
import optionsRoutes from "./routes/options.js";
import internalPatternsRoutes from "./routes/internalPatterns.js";
import { audit } from "./middleware/audit.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { metrics, httpRequests, httpDurationMs } from "./utils/metrics.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("dev"));
  app.use(audit);

  // Per-request latency + count metrics. Route is taken from the
  // matched route path so /api/orders/123 collapses to /api/orders/:id.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const route =
        (req.route as { path?: string } | undefined)?.path ?? req.path ?? "/unknown";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequests.inc(labels);
      httpDurationMs.observeMs(Date.now() - start, labels);
    });
    next();
  });

  const authLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const tradeLimiter = rateLimit({ windowMs: 60_000, max: 120 });

  app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
  app.get("/metrics", (_req, res) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.send(metrics.render());
  });

  app.use("/api/auth", authLimiter, authRoutes);
  app.use("/api/2fa", authLimiter, twofaRoutes);
  app.use("/api/watchlist", watchlistRoutes);
  app.use("/api/market", marketRoutes);
  app.use("/api/signals", signalRoutes);
  app.use("/api/positions", tradeLimiter, positionRoutes);
  app.use("/api/trades", tradeRoutes);
  app.use("/api/orders", tradeLimiter, orderRoutes);
  app.use("/api/portfolio", portfolioRoutes);
  app.use("/api/autotrade", autotradeRoutes);
  app.use("/api/indicators", indicatorRoutes);
  app.use("/api/patterns", patternRoutes);
  app.use("/api/gainz-alpha", gainzAlphaRoutes);
  app.use("/api/chan-advisor", chanAdvisorRoutes);
  app.use("/api/backtest", backtestRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/prediction", predictionRoutes);
  app.use("/api/pps-signals", ppsSignalsRoutes);
  app.use("/api/power-analysis", powerAnalysisRoutes);
  app.use("/api/news", newsRoutes);
  app.use("/api/composite", compositeRoutes);
  app.use("/api/analysis", analysisRoutes);
  app.use("/api/scanner", scannerRoutes);
  app.use("/api/market-overview", marketOverviewRoutes);
  app.use("/api/alerts", alertRoutes);
  app.use("/api/portfolio-analytics", portfolioAnalyticsRoutes);
  app.use("/api/calendar", calendarRoutes);
  app.use("/api/bulk-deals", bulkDealsRoutes);
  app.use("/api/premium", premiumRoutes);
  app.use("/api/top-stocks", topStocksRoutes);
  app.use("/api/ml", mlRoutes);
  app.use("/api/paper", tradeLimiter, paperRoutes);
  app.use("/api/broker", tradeLimiter, brokerRoutes);
  app.use("/api/chart-layouts", chartLayoutRoutes);
  app.use("/api/options", optionsRoutes);
  // Internal webhook endpoints — no JWT, gated by INTERNAL_WEBHOOK_SECRET.
  // Used by the ai-service to forward training progress for WS fan-out.
  app.use("/internal/patterns", internalPatternsRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
