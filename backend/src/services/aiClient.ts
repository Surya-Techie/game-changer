import axios from "axios";
import { env } from "../config/env.js";
import type { Candle } from "../models/Candle.js";
import { logger } from "../utils/logger.js";

export interface StrategyToggles {
  regimeFilter?: boolean;
  regimeMinAdx?: number;
  mtfConfirmation?: boolean;
  stopMode?: "ATR" | "FIXED_PCT";
  stopPct?: number;
  targetRR?: number;
}

export interface AiSignal {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reason: string;
  indicators: Record<string, number | string>;
  filters?: Record<string, unknown>;
  suggestedEntry?: number;
  suggestedStop?: number;
  suggestedTarget?: number;
}

export interface PatternDetection {
  pattern: string;
  direction: "BULL" | "BEAR" | "NEUTRAL";
  start: number;
  end: number;
  score: number;
  notes: string;
  points: number[][];
}

const client = axios.create({
  baseURL: env.aiServiceUrl,
  timeout: 10_000,
});

// Attach the optional service-token to every outbound AI call so the
// ai-service /metrics gate accepts us. No-op when the env is unset.
const AI_TOKEN = process.env.AI_SERVICE_TOKEN ?? "";
if (AI_TOKEN) {
  client.interceptors.request.use((config) => {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>)["X-Service-Token"] = AI_TOKEN;
    return config;
  });
}

function candleArray(candles: Candle[]) {
  return candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
}

export async function getAiSignal(
  symbol: string,
  candles: Candle[],
  strategy?: StrategyToggles
): Promise<AiSignal | null> {
  if (candles.length < 30) return null;
  try {
    const { data } = await client.post<AiSignal>("/signal", {
      symbol,
      candles: candleArray(candles),
      strategy,
    });
    return data;
  } catch (err) {
    logger.warn("AI /signal failed", { symbol, err: (err as Error).message });
    return null;
  }
}

export async function getIndicators(
  symbol: string,
  candles: Candle[],
  families?: string[]
): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await client.post("/indicators", {
      symbol,
      candles: candleArray(candles),
      families: families ?? [
        "sma", "ema", "rsi", "macd", "bollinger", "stochastic", "supertrend", "vwap", "ichimoku", "atr",
      ],
    });
    return data as Record<string, unknown>;
  } catch (err) {
    logger.warn("AI /indicators failed", { symbol, err: (err as Error).message });
    return null;
  }
}

export async function getPatterns(symbol: string, candles: Candle[]): Promise<PatternDetection[]> {
  try {
    const { data } = await client.post("/patterns", { symbol, candles: candleArray(candles) });
    return ((data as { detections?: PatternDetection[] })?.detections ?? []) as PatternDetection[];
  } catch (err) {
    logger.warn("AI /patterns failed", { symbol, err: (err as Error).message });
    return [];
  }
}

export interface BacktestResult {
  summary?: Record<string, number | null>;
  equityCurve?: Array<{ t: number; equity: number; drawdownPct: number }>;
  trades?: Array<Record<string, unknown>>;
  error?: string;
}

export async function runBacktest(
  symbol: string,
  candles: Candle[],
  params: {
    capital?: number;
    riskPerTradePct?: number;
    minConfidence?: number;
    warmup?: number;
    strategy?: StrategyToggles;
    trailingStopPct?: number;
    partialTpEnabled?: boolean;
    brokerageFlat?: number;
    brokeragePct?: number;
  }
): Promise<BacktestResult | null> {
  try {
    const { data } = await client.post(
      "/backtest",
      { symbol, candles: candleArray(candles), ...params },
      { timeout: 60_000 }
    );
    return data as BacktestResult;
  } catch (err) {
    logger.warn("AI /backtest failed", { symbol, err: (err as Error).message });
    return null;
  }
}

export async function getPrediction(symbol: string, candles: Candle[], horizon = 5): Promise<unknown | null> {
  // Prefer the trained ensemble (RF+GBM+MLP with OOS metrics). Fall back to
  // the original lazy-trained /predict if no trained model exists yet.
  try {
    const ensemble = await client.post("/ml/predict", { symbol, candles: candleArray(candles) });
    if ((ensemble.data as { ready?: boolean }).ready) return ensemble.data;
  } catch {
    // ignore — fall through to legacy /predict
  }
  try {
    const { data } = await client.post("/predict", { symbol, candles: candleArray(candles), horizon });
    return data;
  } catch (err) {
    logger.warn("AI /predict failed", { symbol, err: (err as Error).message });
    return null;
  }
}

export interface PpsBarIn {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface PpsSignalOut {
  bar_index: number;
  date: string;
  signal: "BUY" | "SELL" | "HOLD";
  pattern:
    | "symmetrical_triangle"
    | "ascending_triangle"
    | "descending_triangle"
    | "head_shoulders_continuation"
    | "double_bottom"
    | "double_top"
    | null;
  confidence: number;
  entry_price: number | null;
  stop_loss: number | null;
  target_price: number | null;
  risk_reward: number | null;
  trend_aligned: boolean;
}

export interface PpsSignalsResponse {
  symbol: string;
  timeframe: string;
  signals: PpsSignalOut[];
  summary: {
    total_signals: number;
    buy_count: number;
    sell_count: number;
    avg_confidence: number;
  };
}

export interface PowerSignal {
  bar_index: number;
  t: number;
  signal: "BUY" | "SELL" | "HOLD";
  composite_confidence?: number;
  agreement_count?: number;
  active_sources?: number;
  pattern?: string | null;
  entry_price?: number | null;
  stop_loss?: number | null;
  target_price?: number | null;
  risk_reward?: number | null;
  votes?: Array<{ strategy: string; direction: string; confidence: number }>;
  reason?: string;
}

export interface PowerAccuracy {
  method: string;
  horizon_bars: number;
  resolved_signals: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  avg_per_trade_pct: number;
  total_return_pct: number;
  unresolved_signals: number;
  honest_note?: string;
  note?: string;
}

export interface PowerAnalysisResponse {
  symbol: string;
  mode: "strict" | "loose";
  signals: PowerSignal[];
  summary: {
    total_signals: number;
    buy_count: number;
    sell_count: number;
    avg_confidence: number;
  };
  accuracy?: PowerAccuracy;
}

export interface CandleIn {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Proxy to AI service POST /power-analysis.
 * The AI service runs the super-composer over the full bar history and
 * returns per-bar verdicts. Caller plots BUY/SELL bars as arrow markers.
 */
export async function getPowerAnalysis(
  symbol: string,
  candles: CandleIn[],
  mode: "strict" | "loose" = "strict",
  useMl = false,
  targetR = 2.0,
  stopPct?: number,
  targetPct?: number
): Promise<PowerAnalysisResponse | null> {
  try {
    const body: Record<string, unknown> = {
      symbol, candles, mode, use_ml: useMl, target_r: targetR,
    };
    if (stopPct != null && stopPct > 0) body.stop_pct = stopPct;
    if (targetPct != null && targetPct > 0) body.target_pct = targetPct;
    const { data } = await client.post(
      "/power-analysis",
      body,
      // First-run ML auto-training adds ~3-8 s on top of the normal scan.
      { timeout: useMl ? 120_000 : 60_000 }
    );
    return data as PowerAnalysisResponse;
  } catch (err) {
    logger.warn("AI /power-analysis failed", { symbol, err: (err as Error).message });
    return null;
  }
}

/**
 * Proxy to AI service POST /pps-signals.
 * The AI service computes the entire engine; we just forward.
 */
export async function getPpsSignals(
  symbol: string,
  timeframe: string,
  bars: PpsBarIn[]
): Promise<PpsSignalsResponse | null> {
  try {
    const { data } = await client.post(
      "/pps-signals",
      { symbol, timeframe, bars },
      { timeout: 30_000 }
    );
    return data as PpsSignalsResponse;
  } catch (err) {
    logger.warn("AI /pps-signals failed", { symbol, err: (err as Error).message });
    return null;
  }
}

/**
 * Proxy to AI service POST /pps-signals/record (PPS → Analytics).
 * Resolves each PPS signal's outcome and commits it to the pattern-accuracy
 * store. Append-only — intended for deliberate batch/backfill use.
 */
export async function recordPpsOutcomes(
  symbol: string,
  timeframe: string,
  bars: PpsBarIn[]
): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await client.post(
      "/pps-signals/record",
      { symbol, timeframe, bars },
      { timeout: 30_000 }
    );
    return data as Record<string, unknown>;
  } catch (err) {
    logger.warn("AI /pps-signals/record failed", { symbol, err: (err as Error).message });
    return null;
  }
}

export async function trainMl(symbol: string, candles: Candle[], horizon = 5): Promise<unknown | null> {
  try {
    const { data } = await client.post(
      "/ml/train",
      { symbol, candles: candleArray(candles), horizon },
      { timeout: 60_000 }
    );
    return data;
  } catch (err) {
    logger.warn("AI /ml/train failed", { symbol, err: (err as Error).message });
    return null;
  }
}

export async function getMlRegistry(): Promise<unknown | null> {
  try {
    const { data } = await client.get("/ml/registry");
    return data;
  } catch (err) {
    logger.warn("AI /ml/registry failed", { err: (err as Error).message });
    return null;
  }
}

export async function getSentiment(items: Array<{ id: string; text: string }>): Promise<unknown | null> {
  try {
    const { data } = await client.post("/sentiment", { items });
    return data;
  } catch (err) {
    logger.warn("AI /sentiment failed", { err: (err as Error).message });
    return null;
  }
}

export async function getCandlestickPatterns(symbol: string, candles: Candle[], lookback = 30): Promise<unknown | null> {
  try {
    const { data } = await client.post("/candlestick", { symbol, candles: candleArray(candles), lookback });
    return data;
  } catch (err) {
    logger.warn("AI /candlestick failed", { symbol, err: (err as Error).message });
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Pattern detection engine — Phase 5 wrappers around the ai-service
// /patterns/* router. Each is a thin pass-through; the patternEngine
// service owns the orchestration logic.
// ────────────────────────────────────────────────────────────────────────

export type PatternTimeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "D1";

export interface PatternDetectionResult {
  pattern_name: string;
  detected: boolean;
  direction: "bullish" | "bearish" | "continuation" | "neutral";
  candle_indices: number[];
  strength: number;
  description: string;
  historical_win_rate: number;
  confidence_score: number;
  grade: string;
  category: string;
  score_breakdown: Record<string, number | string>;
  score_reasoning: string[];
  filters: Record<string, unknown>;
  ml_probs: Record<string, unknown>;
  entry_price?: number;
  target_price?: number;
  stop_price?: number;
  risk_reward?: number;
  trendline_points?: Array<{ time: number; price: number }>;
  _id?: string;
  ai_explanation?: string;
}

export interface PatternDetectResponse {
  symbol: string;
  timeframe: string;
  cached: boolean;
  served_at_ms: number;
  candles_used: number;
  higher_tf: string | null;
  patterns: PatternDetectionResult[];
}

export async function detectPatterns(symbol: string, timeframe: PatternTimeframe, lookback = 100): Promise<PatternDetectResponse | null> {
  try {
    const { data } = await client.post<PatternDetectResponse>(
      "/patterns/detect",
      { symbol, timeframe, lookback },
      { timeout: 20_000 }
    );
    return data;
  } catch (err) {
    logger.warn("AI /patterns/detect failed", { symbol, timeframe, err: (err as Error).message });
    return null;
  }
}

export interface PatternScanResponse {
  timeframe: string;
  min_confidence: number;
  symbols_requested: number;
  symbols_scanned: number;
  patterns: Array<PatternDetectionResult & { symbol: string; timeframe: string }>;
}

export async function scanPatterns(symbols: string[], timeframe: PatternTimeframe, minConfidence: number, lookback = 100): Promise<PatternScanResponse | null> {
  try {
    const { data } = await client.get<PatternScanResponse>("/patterns/scan", {
      params: {
        symbols: symbols.join(","),
        timeframe,
        min_confidence: minConfidence,
        lookback,
      },
      timeout: 60_000,
    });
    return data;
  } catch (err) {
    logger.warn("AI /patterns/scan failed", { err: (err as Error).message });
    return null;
  }
}

export interface PatternAccuracyResponse {
  available: boolean;
  rollups: Array<Record<string, unknown>>;
}

export async function fetchPatternAccuracy(): Promise<PatternAccuracyResponse | null> {
  try {
    const { data } = await client.get<PatternAccuracyResponse>("/patterns/accuracy");
    return data;
  } catch (err) {
    logger.warn("AI /patterns/accuracy failed", { err: (err as Error).message });
    return null;
  }
}

export type PatternChartTimeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "D1" | "Y1";

export interface PatternOhlcvResponse {
  symbol: string;
  timeframe: string;
  candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
}

export async function fetchPatternOhlcv(symbol: string, timeframe: PatternChartTimeframe, limit = 300): Promise<PatternOhlcvResponse | null> {
  // yfinance + the AI service's 15-second LRU cache occasionally combine
  // to make the FIRST request for a symbol slow (5–10 s for a cold fetch).
  // When several Dashboard cards fire simultaneously, that first request
  // can exceed the 12 s timeout and surface as a 502 in the browser.
  // A single retry with backoff catches the transient case without
  // pretending to be a circuit breaker.
  const attempt = async (timeoutMs: number) => {
    const { data } = await client.get<PatternOhlcvResponse>(
      `/patterns/ohlcv/${encodeURIComponent(symbol)}`,
      { params: { timeframe, limit }, timeout: timeoutMs },
    );
    return data;
  };
  try {
    return await attempt(12_000);
  } catch (err) {
    logger.warn("AI /patterns/ohlcv first attempt failed — retrying once", {
      symbol, err: (err as Error).message,
    });
    // Brief pause so a transient upstream burst settles.
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      return await attempt(18_000);             // longer fuse on the retry
    } catch (err2) {
      logger.warn("AI /patterns/ohlcv retry failed", {
        symbol, err: (err2 as Error).message,
      });
      return null;
    }
  }
}

export interface SubmitTrainResponse {
  job_id: string;
  status: string;
  timeframe: string;
  estimated_seconds: number;
}

export async function submitPatternTrain(timeframe: PatternTimeframe, symbols: string[] | undefined, fast: boolean): Promise<SubmitTrainResponse | null> {
  try {
    const { data } = await client.post<SubmitTrainResponse>(
      "/patterns/train",
      { timeframe, symbols, fast },
      { headers: { "X-User-Role": "admin" }, timeout: 10_000 }
    );
    return data;
  } catch (err) {
    logger.warn("AI /patterns/train failed", { err: (err as Error).message });
    return null;
  }
}

export async function getPatternTrainStatus(jobId: string): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await client.get(`/patterns/train/${encodeURIComponent(jobId)}`);
    return data as Record<string, unknown>;
  } catch (err) {
    logger.warn("AI /patterns/train/:jobId failed", { jobId, err: (err as Error).message });
    return null;
  }
}

export async function postPatternFeedback(patternId: string, outcome: "win" | "loss" | "breakeven", exitPrice: number): Promise<boolean> {
  try {
    await client.post(
      "/patterns/feedback",
      { pattern_id: patternId, outcome, exit_price: exitPrice },
      { headers: { "X-User-Role": "admin" }, timeout: 5_000 }
    );
    return true;
  } catch (err) {
    logger.warn("AI /patterns/feedback failed", { patternId, err: (err as Error).message });
    return false;
  }
}

export async function getLevels(symbol: string, candles: Candle[]): Promise<unknown | null> {
  try {
    const { data } = await client.post("/levels", { symbol, candles: candleArray(candles) });
    return data;
  } catch (err) {
    logger.warn("AI /levels failed", { symbol, err: (err as Error).message });
    return null;
  }
}

export async function getMtfSummary(symbol: string, candles: Candle[]): Promise<unknown | null> {
  try {
    const { data } = await client.post("/mtf", { symbol, candles: candleArray(candles) });
    return data;
  } catch (err) {
    logger.warn("AI /mtf failed", { symbol, err: (err as Error).message });
    return null;
  }
}
