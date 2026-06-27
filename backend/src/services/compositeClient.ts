import axios from "axios";
import { env } from "../config/env.js";
import type { Candle } from "../models/Candle.js";
import { logger } from "../utils/logger.js";

export interface CompositeSignalEntry {
  name: string;
  signal: -1 | 0 | 1;
  confidence: number;
  reason: string;
  metadata: Record<string, unknown>;
}

export interface CompositeResponse {
  symbol: string;
  asof: string;
  bars: number;
  signals: Record<string, CompositeSignalEntry>;
  weighted_score: number;
  composite_score: number;
  recommendation: "STRONG BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG SELL";
  confidence: number;
  weights: Record<string, number>;
}

const client = axios.create({ baseURL: env.aiServiceUrl, timeout: 20_000 });

function candleArray(candles: Candle[]) {
  return candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
}

export interface CompositeRequestBody {
  symbol: string;
  candles: Candle[];
  peer_candles?: Candle[];
  sentiment?: {
    fii_dii_net_cr?: number | null;
    india_vix?: number | null;
    ad_ratio?: number | null;
    pcr?: number | null;
    news_sentiment?: number | null;
  };
  weights?: Record<string, number>;
}

export async function runComposite(body: CompositeRequestBody): Promise<CompositeResponse | null> {
  try {
    const { data } = await client.post("/composite", {
      symbol: body.symbol,
      candles: candleArray(body.candles),
      peer_candles: body.peer_candles ? candleArray(body.peer_candles) : undefined,
      sentiment: body.sentiment,
      weights: body.weights,
    });
    return data as CompositeResponse;
  } catch (err) {
    logger.warn("AI /composite failed", { symbol: body.symbol, err: (err as Error).message });
    return null;
  }
}

export async function runCompositeBacktest(
  body: CompositeRequestBody & {
    warmup?: number;
    entry_score?: number;
    exit_score?: number;
    sl_pct?: number;
    tp_pct?: number | null;
    allow_short?: boolean;
  }
): Promise<unknown | null> {
  try {
    const { data } = await client.post(
      "/composite/backtest",
      {
        symbol: body.symbol,
        candles: candleArray(body.candles),
        peer_candles: body.peer_candles ? candleArray(body.peer_candles) : undefined,
        sentiment: body.sentiment,
        weights: body.weights,
        warmup: body.warmup,
        entry_score: body.entry_score,
        exit_score: body.exit_score,
        sl_pct: body.sl_pct,
        tp_pct: body.tp_pct,
        allow_short: body.allow_short,
      },
      { timeout: 90_000 }
    );
    return data;
  } catch (err) {
    logger.warn("AI /composite/backtest failed", { symbol: body.symbol, err: (err as Error).message });
    return null;
  }
}
