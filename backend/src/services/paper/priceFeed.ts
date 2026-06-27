// Paper-trading price feed.
//
// Calls the FastAPI ai-service /price/{symbol} endpoint (which wraps
// yfinance with a 15-second server-side cache). We additionally cache
// here for 15s to absorb burst lookups from many concurrent requests.
//
// Falls back to the local mock-feed `priceBook` when yfinance is
// unreachable so dev without internet still works. Fallback responses
// are flagged with `source: "MOCK"` so the UI can warn the user.

import axios from "axios";
import { priceBook } from "../priceBook.js";
import { aiHeaders } from "../../utils/aiHeaders.js";
import { logger } from "../../utils/logger.js";

const AI_BASE = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
const CACHE_TTL_MS = 15_000;

export interface PriceQuote {
  symbol: string;
  price: number;
  ts: number;
  source: "YFINANCE" | "MOCK" | "CACHE";
  delayed: boolean;
}

interface CacheEntry {
  quote: PriceQuote;
  fetchedAt: number;
  inflight?: Promise<PriceQuote | null>;
}

class PaperPriceFeed {
  private cache = new Map<string, CacheEntry>();

  async fetch(symbol: string): Promise<PriceQuote | null> {
    const sym = symbol.toUpperCase();
    const now = Date.now();
    const entry = this.cache.get(sym);

    if (entry && now - entry.fetchedAt < CACHE_TTL_MS) {
      return { ...entry.quote, source: "CACHE", ts: entry.quote.ts };
    }
    if (entry?.inflight) return entry.inflight;

    const inflight = this.doFetch(sym).then((q) => {
      if (q) this.cache.set(sym, { quote: q, fetchedAt: Date.now() });
      else if (entry) {
        // Keep stale entry rather than dropping it — next caller will retry.
        this.cache.set(sym, { quote: entry.quote, fetchedAt: now - CACHE_TTL_MS + 5_000 });
      }
      return q ?? entry?.quote ?? null;
    });

    const slot: CacheEntry = entry
      ? { ...entry, inflight }
      : { quote: { symbol: sym, price: 0, ts: now, source: "MOCK", delayed: true }, fetchedAt: 0, inflight };
    this.cache.set(sym, slot);

    try {
      const result = await inflight;
      return result;
    } finally {
      const after = this.cache.get(sym);
      if (after) {
        after.inflight = undefined;
        this.cache.set(sym, after);
      }
    }
  }

  /** Batch fetch — used by the background position manager. */
  async fetchMany(symbols: string[]): Promise<Record<string, PriceQuote>> {
    const out: Record<string, PriceQuote> = {};
    await Promise.all(
      symbols.map(async (s) => {
        const q = await this.fetch(s);
        if (q) out[s.toUpperCase()] = q;
      })
    );
    return out;
  }

  /** Last known price (cache only, never blocks). */
  cached(symbol: string): PriceQuote | null {
    const entry = this.cache.get(symbol.toUpperCase());
    return entry?.quote ?? null;
  }

  private async doFetch(symbol: string): Promise<PriceQuote | null> {
    try {
      const res = await axios.get(`${AI_BASE}/price/${encodeURIComponent(symbol)}`, {
        timeout: 6_000,
        headers: aiHeaders(),
      });
      const data = res.data as { price?: number; delayed?: boolean; ts?: number };
      if (typeof data.price === "number" && data.price > 0) {
        return {
          symbol,
          price: data.price,
          ts: data.ts ?? Date.now(),
          source: "YFINANCE",
          delayed: data.delayed ?? true,
        };
      }
    } catch (err) {
      logger.warn("yfinance price fetch failed, falling back to mock", {
        symbol,
        err: (err as Error).message,
      });
    }
    // Fallback: mock feed (used in dev / offline mode).
    const mock = priceBook.price(symbol);
    if (mock != null && mock > 0) {
      return { symbol, price: mock, ts: Date.now(), source: "MOCK", delayed: false };
    }
    return null;
  }
}

export const paperPriceFeed = new PaperPriceFeed();
