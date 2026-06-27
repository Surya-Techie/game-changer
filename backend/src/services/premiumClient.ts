import axios from "axios";
import { env } from "../config/env.js";
import type { Candle } from "../models/Candle.js";
import { logger } from "../utils/logger.js";

const client = axios.create({ baseURL: env.aiServiceUrl, timeout: 15_000 });

function candleArray(candles: Candle[]) {
  return candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
}

async function call<T>(path: string, body: object, symbol: string): Promise<T | null> {
  try {
    const { data } = await client.post<T>(path, body);
    return data;
  } catch (err) {
    logger.warn(`AI ${path} failed`, { symbol, err: (err as Error).message });
    return null;
  }
}

export const premiumClient = {
  vwap: (symbol: string, candles: Candle[], anchorBars?: number[]) =>
    call<Record<string, unknown>>("/premium/vwap", {
      symbol, candles: candleArray(candles), anchor_bars: anchorBars,
    }, symbol),

  ichimoku: (symbol: string, candles: Candle[]) =>
    call<Record<string, unknown>>("/premium/ichimoku", {
      symbol, candles: candleArray(candles),
    }, symbol),

  smc: (symbol: string, candles: Candle[]) =>
    call<Record<string, unknown>>("/premium/smc", {
      symbol, candles: candleArray(candles),
    }, symbol),

  orderflow: (symbol: string, candles: Candle[]) =>
    call<Record<string, unknown>>("/premium/orderflow", {
      symbol, candles: candleArray(candles),
    }, symbol),

  profile: (symbol: string, candles: Candle[]) =>
    call<Record<string, unknown>>("/premium/profile", {
      symbol, candles: candleArray(candles),
    }, symbol),
};
