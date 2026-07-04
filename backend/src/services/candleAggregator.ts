import { EventEmitter } from "node:events";
import axios from "axios";
import { mockFeed, type Tick } from "./mockFeed.js";
import type { Candle } from "../models/Candle.js";
import { env } from "../config/env.js";
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

    // Late tick (older bucket than the candle in progress) — merge it into
    // the current candle instead of "opening" an older one. Appending an
    // older candle after a newer one breaks the ascending-time invariant
    // and hard-crashes lightweight-charts on the frontend.
    if (curr && bucket < curr.t) {
      curr.h = Math.max(curr.h, tick.price);
      curr.l = Math.min(curr.l, tick.price);
      curr.v += tick.volume;
      this.current.set(tick.symbol, curr);
      this.emit("candle:update", curr);
      return;
    }

    if (!curr || curr.t !== bucket) {
      if (curr) {
        const arr = this.candles.get(curr.symbol) ?? [];
        // Same invariant on the closed list: drop anything that would land
        // at or before the last stored bucket (can happen when warmup
        // seeding replaced history while a candle was in flight).
        while (arr.length > 0 && arr[arr.length - 1]!.t >= curr.t) arr.pop();
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

  /**
   * Seed the candle store with REAL 1m history from the AI service
   * (yfinance). Signals computed right after a restart then see genuine
   * SMA50 / VWAP / ATR context instead of fabricated bars.
   *
   * Falls back to the synthetic seed ONLY in synthetic dev mode
   * (MOCK_FEED_SYNTHETIC=true) — there the random walk continues from a
   * random level anyway, and dev needs chart shape without network access.
   */
  async warmupReal(barsPerSymbol = 500): Promise<void> {
    const symbols = mockFeed.symbols();

    // The AI service usually boots in parallel with us (dev.sh starts both
    // at once) — wait for its /health before fetching, otherwise every
    // request dies on ECONNREFUSED and we silently run on synthetic bars.
    const deadline = Date.now() + 90_000;
    let aiUp = false;
    while (Date.now() < deadline) {
      try {
        await axios.get(`${env.aiServiceUrl}/health`, { timeout: 2_000 });
        aiUp = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    if (!aiUp) {
      logger.warn("Real warmup skipped — AI service unreachable", { url: env.aiServiceUrl });
      if ((process.env.MOCK_FEED_SYNTHETIC ?? "false").toLowerCase() === "true") {
        this.warmupSynthetic(barsPerSymbol);
      }
      return;
    }

    let seeded = 0;
    // Fetch in small batches to keep yfinance happy; one retry per symbol.
    const BATCH = 5;
    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch = symbols.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (symbol) => {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const { data } = await axios.get(`${env.aiServiceUrl}/history/${symbol}`, {
                params: { interval: "1m", period: "5d" },
                timeout: 20_000,
              });
              const candles = (data?.candles ?? []) as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
              if (candles.length < 30) return;
              // Exclude the in-progress minute from history and drop any
              // pre-seed "current" candle: it may contain synthetic ticks
              // (one 2843→1304 hybrid bar inflates ATR for 14 bars) and
              // would duplicate the last history timestamp. The next real
              // tick (≤2s away) starts a clean current candle.
              const nowBucket = this.bucketStart(Date.now());
              this.candles.set(
                symbol,
                candles
                  .slice(-barsPerSymbol)
                  .filter((c) => c.t < nowBucket)
                  .map((c) => ({ symbol, ...c }))
              );
              this.current.delete(symbol);
              // Re-anchor the synthetic walk at the real level so any
              // synthetic tick emitted before the first real poll doesn't
              // print thousands of rupees off-market.
              mockFeed.adoptPrice(symbol, candles[candles.length - 1]!.c);
              seeded++;
              return;
            } catch (err) {
              if (attempt === 1) {
                const e = err as Error & { code?: string };
                logger.warn("Real warmup failed for symbol", { symbol, err: e.message || e.code || "unknown" });
              } else {
                await new Promise((r) => setTimeout(r, 1_500));
              }
            }
          }
        })
      );
    }
    logger.info("Candle warmup (real history) done", { symbols: symbols.length, seeded });
    if (seeded === 0 && (process.env.MOCK_FEED_SYNTHETIC ?? "false").toLowerCase() === "true") {
      this.warmupSynthetic(barsPerSymbol);
    }
  }

  /** Dev-only fallback: fabricated candles so the chart has shape offline. */
  warmupSynthetic(barsPerSymbol = 60) {
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
    logger.info("Candle warmup (synthetic) done", { symbols: mockFeed.symbols().length, bars: barsPerSymbol });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const candleAggregator = new CandleAggregator();

export function getCandles(symbol: string, limit = 200): Candle[] {
  return candleAggregator.getCandles(symbol, limit);
}

// Short cache for off-universe symbol history so per-symbol AI panels
// (prediction, composite, indicators, …) don't re-fetch on every request.
const smartCache = new Map<string, { at: number; candles: Candle[] }>();
const SMART_TTL_MS = 120_000;

/**
 * Candles for ANY symbol. The in-memory aggregator only tracks the 20-symbol
 * live universe; every other listing (the 22k all-stocks browser, BSE lines)
 * falls back to real daily history via the AI service — which also handles
 * BSE↔NSE twin retries and rate-limit disk caching.
 */
export async function getCandlesSmart(symbol: string, limit = 500): Promise<Candle[]> {
  const sym = symbol.toUpperCase();
  const local = candleAggregator.getCandles(sym, limit);
  if (local.length >= 30) return local;

  const hit = smartCache.get(sym);
  if (hit && Date.now() - hit.at < SMART_TTL_MS) return hit.candles.slice(-limit);
  try {
    const { data } = await axios.get(`${env.aiServiceUrl}/history/${encodeURIComponent(sym)}`, {
      params: { interval: "1d", period: "1y" },
      timeout: 15_000,
    });
    const rows = (data?.candles ?? []) as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
    const candles: Candle[] = rows.map((c) => ({ symbol: sym, ...c }));
    if (candles.length >= 30) smartCache.set(sym, { at: Date.now(), candles });
    if (smartCache.size > 300) {
      const oldest = [...smartCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      for (const [k] of oldest) smartCache.delete(k);
    }
    return candles.length >= 30 ? candles.slice(-limit) : local;
  } catch {
    return local;
  }
}

export function listSymbols(): string[] {
  return mockFeed.symbols();
}
