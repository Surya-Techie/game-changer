import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getCandles, listSymbols } from "../services/candleAggregator.js";
import { fetchPatternOhlcv, type PatternChartTimeframe } from "../services/aiClient.js";
import fs from "node:fs";
import path from "node:path";

const router = Router();

router.use(requireAuth);

router.get("/symbols", (_req, res) => {
  res.json({ symbols: listSymbols() });
});

router.get("/all-stocks", (_req, res) => {
  try {
    const jsonPathSrc = path.resolve(process.cwd(), "src/data/stocks.json");
    const jsonPathDist = path.resolve(process.cwd(), "dist/data/stocks.json");
    const jsonPath = fs.existsSync(jsonPathSrc) ? jsonPathSrc : jsonPathDist;

    if (fs.existsSync(jsonPath)) {
      res.setHeader("Content-Type", "application/json");
      fs.createReadStream(jsonPath).pipe(res);
    } else {
      res.status(404).json({ error: "Stock database not ready" });
    }
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/candles/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const timeframe = (req.query.timeframe as string ?? "1m").toLowerCase();
    const mockSymbols = listSymbols();

    // Map timeframe names to backend/yfinance formats
    const tfMap: Record<string, PatternChartTimeframe> = {
      "1m": "M1",
      "5m": "M5",
      "15m": "M15",
      "1h": "H1",
      "1d": "D1",
      "1y": "Y1",
      "m1": "M1",
      "m5": "M5",
      "m15": "M15",
      "h1": "H1",
      "d1": "D1",
      "y1": "Y1",
    };
    const activeTf = tfMap[timeframe] ?? "M1";

    // Always pull from yfinance via the ai-service. The in-memory
    // candleAggregator is fed by tick events and was useful when the
    // mockFeed was the only data source; now that pollReal() emits real
    // NSE/yfinance prices, the aggregator's historical candles are
    // polluted by whatever synthetic walks ran earlier — making the
    // chart disagree with the topbar's LTP. yfinance is the single
    // source of truth for chart history; the aggregator still works
    // for downstream pattern / signal engines that need live ticks.
    void mockSymbols;
    const ohlcv = await fetchPatternOhlcv(symbol, activeTf, limit);
    if (ohlcv && ohlcv.candles?.length) {
      res.json({ symbol, candles: ohlcv.candles });
    } else {
      // Last-ditch fallback only if yfinance fails completely.
      const candles = getCandles(symbol, limit);
      res.json({ symbol, candles });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
