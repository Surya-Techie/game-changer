import { EventEmitter } from "node:events";
import { mockFeed, type Tick } from "./mockFeed.js";
import type { Candle } from "../models/Candle.js";
import { logger } from "../utils/logger.js";

const CANDLE_INTERVAL_MS = 60_000; // 1m candles
const MAX_CANDLES = 1000;

class CandleAggregator extends EventEmitter {
  private candles = new Map<string, Candle[]>();
  private current = new Map<string, Candle>();

  constructor() {
    super();
    mockFeed.on("tick", (tick: Tick) => this.onTick(tick));
  }

  private bucketStart(ts: number) {
    return ts - (ts % CANDLE_INTERVAL_MS);
  }

  private onTick(tick: Tick) {
    const bucket = this.bucketStart(tick.ts);
    let curr = this.current.get(tick.symbol);

    if (!curr || curr.t !== bucket) {
      if (curr) {
        const arr = this.candles.get(curr.symbol) ?? [];
        arr.push(curr);
        if (arr.length > MAX_CANDLES) arr.shift();
        this.candles.set(curr.symbol, arr);
        this.emit("candle:closed", curr);
      }
      curr = { symbol: tick.symbol, t: bucket, o: tick.price, h: tick.price, l: tick.price, c: tick.price, v: tick.volume };
    } else {
      curr.h = Math.max(curr.h, tick.price);
      curr.l = Math.min(curr.l, tick.price);
      curr.c = tick.price;
      curr.v += tick.volume;
    }

    this.current.set(tick.symbol, curr);
    this.emit("candle:update", curr);
  }

  getCandles(symbol: string, limit = 200): Candle[] {
    const arr = this.candles.get(symbol) ?? [];
    const curr = this.current.get(symbol);
    const out = curr ? [...arr, curr] : [...arr];
    return out.slice(-limit);
  }

  warmup(barsPerSymbol = 60) {
    // Seed historical candles so the chart has shape on first load.
    const now = Date.now();
    const start = this.bucketStart(now) - barsPerSymbol * CANDLE_INTERVAL_MS;
    for (const symbol of mockFeed.symbols()) {
      const arr: Candle[] = [];
      let price = 1000 + Math.random() * 3000;
      for (let i = 0; i < barsPerSymbol; i++) {
        const o = price;
        const drift = (Math.random() - 0.5) * 0.01;
        const c = round2(o * (1 + drift));
        const h = round2(Math.max(o, c) * (1 + Math.random() * 0.003));
        const l = round2(Math.min(o, c) * (1 - Math.random() * 0.003));
        arr.push({
          symbol,
          t: start + i * CANDLE_INTERVAL_MS,
          o: round2(o),
          h,
          l,
          c,
          v: Math.floor(1000 + Math.random() * 10000),
        });
        price = c;
      }
      this.candles.set(symbol, arr);
    }
    logger.info("Candle warmup done", { symbols: mockFeed.symbols().length, bars: barsPerSymbol });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const candleAggregator = new CandleAggregator();

export function getCandles(symbol: string, limit = 200): Candle[] {
  return candleAggregator.getCandles(symbol, limit);
}

export function listSymbols(): string[] {
  return mockFeed.symbols();
}
