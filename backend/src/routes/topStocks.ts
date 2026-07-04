import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { mockFeed, SYMBOL_DISPLAY_NAME, SYMBOL_SECTOR } from "../services/mockFeed.js";
import { candleAggregator } from "../services/candleAggregator.js";
import { priceBook } from "../services/priceBook.js";
import { Signal } from "../models/Signal.js";
import { runComposite } from "../services/compositeClient.js";
import { buildPeerIndex, computeAdvanceDeclineRatio } from "../services/peerIndex.js";
import { getCandlestickPatterns, getPrediction } from "../services/aiClient.js";

const router = Router();
router.use(requireAuth);

interface TopStockRow {
  symbol: string;
  name: string;
  sector?: string;
  price: number | null;
  changePct: number | null;
  // Composite
  compositeScore: number | null;
  recommendation: "STRONG BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG SELL" | null;
  confidence: number | null;
  // Per-strategy contributions
  trendSignal: -1 | 0 | 1 | null;
  reversionSignal: -1 | 0 | 1 | null;
  breakoutSignal: -1 | 0 | 1 | null;
  // Latest base-strategy signal
  aiAction: "BUY" | "SELL" | "HOLD" | null;
  aiConfidence: number | null;
  aiReason?: string;
  // ML prediction
  mlDirection: "UP" | "DOWN" | "FLAT" | null;
  mlReturnPct: number | null;
  mlConfidence: number | null;
  // Candlestick pattern
  pattern: { name: string; bias: "BULL" | "BEAR" | "NEUTRAL"; reliability: number } | null;
  // Indicator snapshot
  rsi: number | null;
  adx: number | null;
  macdHist: number | null;
  // Slider position 0..100 — same as composite but exposed explicitly so the
  // UI doesn't need to recompute when composite returns null.
  sliderPct: number;
}

async function buildRow(symbol: string, adRatio: number | null): Promise<TopStockRow> {
  const candles = candleAggregator.getCandles(symbol, 500);
  const lastPrice = priceBook.price(symbol) ?? candles[candles.length - 1]?.c ?? null;
  const ref = candles[Math.max(0, candles.length - 30)]?.c ?? lastPrice;
  const changePct = ref && lastPrice ? ((lastPrice - ref) / ref) * 100 : null;

  const row: TopStockRow = {
    symbol,
    name: SYMBOL_DISPLAY_NAME[symbol] ?? symbol,
    sector: SYMBOL_SECTOR[symbol],
    price: lastPrice,
    changePct,
    compositeScore: null,
    recommendation: null,
    confidence: null,
    trendSignal: null,
    reversionSignal: null,
    breakoutSignal: null,
    aiAction: null,
    aiConfidence: null,
    mlDirection: null,
    mlReturnPct: null,
    mlConfidence: null,
    pattern: null,
    rsi: null,
    adx: null,
    macdHist: null,
    sliderPct: 50,
  };

  if (candles.length < 60) return row;

  // Composite (heaviest call — but parallelised across all 20 symbols).
  const peerIndex = buildPeerIndex(symbol, 500);
  const composite = await runComposite({
    symbol,
    candles,
    peer_candles: peerIndex.length ? peerIndex : undefined,
    sentiment: { ad_ratio: adRatio },
  });
  if (composite) {
    row.compositeScore = composite.composite_score;
    row.recommendation = composite.recommendation;
    row.confidence = composite.confidence;
    row.sliderPct = Math.max(0, Math.min(100, composite.composite_score));
    row.trendSignal = composite.signals.trend?.signal ?? null;
    row.reversionSignal = composite.signals.reversion?.signal ?? null;
    row.breakoutSignal = composite.signals.breakout?.signal ?? null;
    const ind = composite.signals.trend?.metadata ?? {};
    if (typeof ind.adx === "number") row.adx = ind.adx;
  }

  // Latest single-strategy AI signal (cheap — DB lookup).
  const latest = await Signal.findOne({ symbol }).sort({ createdAt: -1 }).lean();
  if (latest) {
    row.aiAction = latest.action;
    row.aiConfidence = latest.confidence;
    row.aiReason = latest.reason;
    const ind = (latest.indicators ?? {}) as Record<string, number>;
    if (typeof ind.rsi14 === "number") row.rsi = ind.rsi14;
    if (typeof ind.macdHist === "number") row.macdHist = ind.macdHist;
    if (typeof ind.adx14 === "number" && row.adx == null) row.adx = ind.adx14;
  }

  // Candlestick pattern (latest detected with highest reliability).
  const pat = (await getCandlestickPatterns(symbol, candles, 30)) as { patterns?: Array<{ name: string; bias: "BULL" | "BEAR" | "NEUTRAL"; reliability: number }> } | null;
  if (pat?.patterns?.length) {
    const best = [...pat.patterns].sort((a, b) => b.reliability - a.reliability)[0];
    if (best) row.pattern = { name: best.name, bias: best.bias, reliability: best.reliability };
  }

  // ML prediction (lazy-trains on first call per symbol).
  const pred = (await getPrediction(symbol, candles, 5)) as
    | { ready?: boolean; direction?: "UP" | "DOWN" | "FLAT"; predictedReturnPct?: number; confidence?: number }
    | null;
  if (pred?.ready && pred.direction) {
    row.mlDirection = pred.direction;
    row.mlReturnPct = pred.predictedReturnPct ?? null;
    row.mlConfidence = pred.confidence ?? null;
  }

  return row;
}

router.get("/", async (_req, res, next) => {
  try {
    const universe = mockFeed.symbols();
    const adRatio = computeAdvanceDeclineRatio();
    // Run all 20 in parallel — composite call dominates the time.
    const rows = await Promise.all(universe.map((s) => buildRow(s, adRatio)));
    rows.sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1));
    res.json({
      ts: Date.now(),
      count: rows.length,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/sliderbands", (_req, res) => {
  // Exposed so the UI can change band labels without redeploying — but the
  // recommendation itself is computed server-side from the composite score.
  res.json({
    bands: [
      { min: 0,  max: 25, label: "STRONG SELL", tone: "sell-strong" },
      { min: 25, max: 40, label: "SELL",        tone: "sell" },
      { min: 40, max: 60, label: "HOLD",        tone: "hold" },
      { min: 60, max: 75, label: "BUY",         tone: "buy" },
      { min: 75, max:100, label: "STRONG BUY",  tone: "buy-strong" },
    ],
  });
});

export default router;
