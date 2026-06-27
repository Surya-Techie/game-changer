import { env } from "../config/env.js";
import { Pattern } from "../models/Pattern.js";
import { PaperAccount } from "../models/PaperAccount.js";
import { Position } from "../models/Position.js";
import { PaperPosition } from "../models/PaperPosition.js";
import { Signal } from "../models/Signal.js";
import { Watchlist } from "../models/Watchlist.js";
import {
  detectPatterns as defaultDetectPatterns,
  postPatternFeedback,
  type PatternDetectResponse,
  type PatternDetectionResult,
  type PatternTimeframe,
} from "./aiClient.js";

// Indirection on detectPatterns so tests can substitute the AI call without
// monkey-patching the ES module export (which is immutable). The default
// binding is the real client.
type DetectFn = (symbol: string, tf: PatternTimeframe, lookback?: number) => Promise<PatternDetectResponse | null>;
let detectPatterns: DetectFn = defaultDetectPatterns;
import { bus, type PatternEvent, type PatternSignalEvent } from "./eventBus.js";
import { mockFeed } from "./mockFeed.js";
import { priceBook } from "./priceBook.js";
import { isMarketOpen, isTradingDay } from "./paper/marketHours.js";
import { logger } from "../utils/logger.js";

/**
 * Pattern Engine — Phase 5.
 *
 * Runs two periodic loops:
 *
 *  1. tick (default 60s) — during NSE market hours, collect the active
 *     symbol set (watchlists ∪ open positions ∪ paper positions ∪ mock-
 *     feed universe), and for each symbol × timeframe call the ai-service
 *     /patterns/detect endpoint. The AI service is the authoritative
 *     writer of Pattern documents (it persists through PyMongo). The Node
 *     side reads the response, dedupes against in-memory state, and emits
 *     the appropriate WebSocket events.
 *
 *  2. resolveTick (default 5min) — walk Pattern docs with outcome=pending
 *     that have a known entry/target/stop. For each, look at the current
 *     market price (priceBook); if the move has hit target or stop, mark
 *     the pattern resolved and POST feedback to the AI service so the
 *     PatternAccuracy rollup updates.
 *
 * Dedupe: an in-process Map keyed by `${symbol}:${tf}:${pattern_name}:${last_candle_idx}`
 * with a 30-minute TTL. Reflects the AI service's own 60s response cache
 * with a much longer ceiling so the same pattern on the same bar doesn't
 * spam the WebSocket every tick.
 *
 * Configuration (env):
 *   PATTERN_ENGINE_INTERVAL_MS       — default 60000
 *   PATTERN_ENGINE_RESOLVE_MS        — default 300000 (5 min)
 *   PATTERN_ENGINE_TIMEFRAMES        — comma-separated subset; default "M5,M15,H1,D1"
 *   PATTERN_ENGINE_MIN_EMIT_CONF     — default 75
 *   PATTERN_ENGINE_MIN_SIGNAL_CONF   — default 85
 *   PATTERN_ENGINE_REQUIRE_MARKET    — default "true" (set "false" so the
 *                                       mock-feed dev stack ticks 24/7)
 *   PATTERN_ENGINE_MAX_SYMBOLS       — safety cap, default 25
 */

const ALL_TFS: PatternTimeframe[] = ["M5", "M15", "H1", "D1"];

function parseTimeframes(): PatternTimeframe[] {
  const raw = (process.env.PATTERN_ENGINE_TIMEFRAMES ?? "").trim();
  if (!raw) return ALL_TFS;
  const want = new Set(raw.split(",").map((t) => t.trim().toUpperCase()));
  const out = ALL_TFS.filter((t) => want.has(t));
  return out.length > 0 ? out : ALL_TFS;
}

const TICK_MS = Number(process.env.PATTERN_ENGINE_INTERVAL_MS ?? 60_000);
const RESOLVE_MS = Number(process.env.PATTERN_ENGINE_RESOLVE_MS ?? 5 * 60_000);
const TIMEFRAMES = parseTimeframes();
const MIN_EMIT_CONF = Number(process.env.PATTERN_ENGINE_MIN_EMIT_CONF ?? 75);
const MIN_SIGNAL_CONF = Number(process.env.PATTERN_ENGINE_MIN_SIGNAL_CONF ?? 85);
const MAX_SYMBOLS = Number(process.env.PATTERN_ENGINE_MAX_SYMBOLS ?? 25);

// Read at call time so tests can flip it without import-order gymnastics.
function requireMarketOpen(): boolean {
  return (process.env.PATTERN_ENGINE_REQUIRE_MARKET ?? "true").toLowerCase() === "true";
}

let tickTimer: NodeJS.Timeout | undefined;
let resolveTimer: NodeJS.Timeout | undefined;
let inFlight = false;

const dedupe = new Map<string, number>(); // key → expires_at epoch ms
const DEDUPE_TTL_MS = 30 * 60_000;

function rememberEmit(key: string): boolean {
  const now = Date.now();
  // GC opportunistically — cheap, no separate timer needed.
  if (dedupe.size > 5_000) {
    for (const [k, exp] of dedupe.entries()) if (exp <= now) dedupe.delete(k);
  }
  const exp = dedupe.get(key);
  if (exp && exp > now) return false; // already emitted recently
  dedupe.set(key, now + DEDUPE_TTL_MS);
  return true;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

export function startPatternEngine(): void {
  if (tickTimer || resolveTimer) return;
  logger.info("PatternEngine started", {
    tickMs: TICK_MS,
    resolveMs: RESOLVE_MS,
    timeframes: TIMEFRAMES,
    minEmitConf: MIN_EMIT_CONF,
    minSignalConf: MIN_SIGNAL_CONF,
    requireMarketOpen: requireMarketOpen(),
    aiServiceUrl: env.aiServiceUrl,
  });
  tickTimer = setInterval(() => void tick(), TICK_MS);
  resolveTimer = setInterval(() => void resolveTick(), RESOLVE_MS);
  // Kick first runs slightly after boot so dependent services (Mongo,
  // candleAggregator warmup) have time to settle.
  setTimeout(() => void tick(), 5_000);
  setTimeout(() => void resolveTick(), 30_000);
}

export function stopPatternEngine(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (resolveTimer) clearInterval(resolveTimer);
  tickTimer = undefined;
  resolveTimer = undefined;
  dedupe.clear();
  logger.info("PatternEngine stopped");
}

// ─── Symbol universe ──────────────────────────────────────────────────────

async function collectActiveSymbols(): Promise<string[]> {
  const out = new Set<string>();

  // Always include the mock-feed universe so dev environments without
  // watchlists / positions still exercise the engine.
  for (const s of mockFeed.symbols()) out.add(s.toUpperCase());

  try {
    const wls = await Watchlist.find({}, { symbols: 1 }).lean();
    for (const w of wls) for (const s of (w.symbols ?? [])) out.add(s.toUpperCase());
  } catch (err) {
    logger.warn("PatternEngine: watchlist scan failed", { err: (err as Error).message });
  }
  try {
    const pos = await Position.find({ status: "OPEN" }, { symbol: 1 }).lean();
    for (const p of pos) out.add(String(p.symbol).toUpperCase());
  } catch {
    /* ignore */
  }
  try {
    const pap = await PaperPosition.find({ status: "OPEN" }, { symbol: 1 }).lean();
    for (const p of pap) out.add(String(p.symbol).toUpperCase());
  } catch {
    /* ignore */
  }

  const arr = [...out];
  if (arr.length > MAX_SYMBOLS) {
    arr.length = MAX_SYMBOLS;
  }
  return arr;
}

async function paperTradingActive(): Promise<boolean> {
  try {
    const c = await PaperAccount.countDocuments({ isActive: true });
    return c > 0;
  } catch {
    return false;
  }
}

// ─── Tick: detect + emit ──────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (inFlight) return; // last tick still running — skip; we'd rather drop than overlap.
  if (requireMarketOpen() && !isMarketOpen()) return;

  inFlight = true;
  try {
    const symbols = await collectActiveSymbols();
    if (symbols.length === 0) return;
    const paperActive = await paperTradingActive();

    // Sequential to be polite with the AI service / yfinance. The Python
    // side does multi-symbol parallel scans for the explicit /scan endpoint
    // when the user clicks "scan now"; the background engine is the slow
    // friend that doesn't compete with user traffic.
    for (const symbol of symbols) {
      for (const tf of TIMEFRAMES) {
        const res = await detectPatterns(symbol, tf, 100);
        if (!res || !res.patterns) continue;
        for (const p of res.patterns) {
          if (!p.detected) continue;
          await maybeEmit(symbol, tf, p, paperActive);
        }
      }
    }
  } catch (err) {
    logger.error("PatternEngine tick failed", { err: (err as Error).message });
  } finally {
    inFlight = false;
  }
}

async function maybeEmit(symbol: string, timeframe: PatternTimeframe, p: PatternDetectionResult, paperActive: boolean): Promise<void> {
  const conf = Math.max(0, Math.min(100, p.confidence_score ?? 0));
  if (conf < MIN_EMIT_CONF) return;

  // Anchor the dedupe key to the last detected candle index so each new
  // bar that re-triggers the same pattern still emits.
  const lastIdx = p.candle_indices.length ? p.candle_indices[p.candle_indices.length - 1] : -1;
  const key = `${symbol}:${timeframe}:${p.pattern_name}:${lastIdx}`;
  if (!rememberEmit(key)) return;

  // Cross-check the last AI signal: only fan out 'pattern' when the
  // directional bias agrees with the existing AI signal (or there's no
  // signal yet — in which case the pattern stands on its own).
  let signalDirection: "BUY" | "SELL" | "HOLD" | undefined;
  try {
    const sig = await Signal.findOne({ symbol }).sort({ createdAt: -1 }).select("action").lean();
    if (sig?.action) signalDirection = sig.action as "BUY" | "SELL" | "HOLD";
  } catch {
    /* ignore */
  }

  const directionMatches =
    !signalDirection ||
    signalDirection === "HOLD" ||
    (signalDirection === "BUY" && p.direction === "bullish") ||
    (signalDirection === "SELL" && p.direction === "bearish") ||
    p.direction === "continuation" ||
    p.direction === "neutral";

  if (!directionMatches) return;

  const event: PatternEvent = {
    patternId: p._id,
    symbol,
    timeframe,
    pattern_name: p.pattern_name,
    category: p.category,
    direction: p.direction,
    confidence: conf,
    grade: p.grade,
    candle_indices: p.candle_indices ?? [],
    trendline_points: p.trendline_points ?? [],
    entry: p.entry_price,
    target: p.target_price,
    stop: p.stop_price,
    rr: p.risk_reward,
    ai_explanation: p.ai_explanation,
    detected_at: Date.now(),
  };
  bus.emit("pattern", event);

  if (conf >= MIN_SIGNAL_CONF && paperActive && (p.direction === "bullish" || p.direction === "bearish")) {
    const signalEvent: PatternSignalEvent = {
      ...event,
      signal_action: p.direction === "bullish" ? "BUY" : "SELL",
    };
    bus.emit("pattern_signal", signalEvent);
  }
}

// ─── Resolve pending patterns ─────────────────────────────────────────────

async function resolveTick(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000); // resolve up to 24h after detection
    const pending = await Pattern.find({
      outcome: "pending",
      detected_at: { $gte: cutoff },
      entry_price: { $exists: true, $ne: null },
      target_price: { $exists: true, $ne: null },
      stop_price: { $exists: true, $ne: null },
    })
      .sort({ detected_at: 1 })
      .limit(200)
      .lean();

    for (const doc of pending) {
      const sym = String(doc.symbol);
      const price = priceBook.price(sym);
      if (price == null) continue;
      const entry = Number(doc.entry_price);
      const target = Number(doc.target_price);
      const stop = Number(doc.stop_price);
      if (!Number.isFinite(entry) || !Number.isFinite(target) || !Number.isFinite(stop)) continue;

      let outcome: "win" | "loss" | null = null;
      if (doc.direction === "bullish") {
        if (price >= target) outcome = "win";
        else if (price <= stop) outcome = "loss";
      } else if (doc.direction === "bearish") {
        if (price <= target) outcome = "win";
        else if (price >= stop) outcome = "loss";
      } else {
        // continuation / neutral — direction-agnostic: closer-of barrier wins.
        const distTarget = Math.abs(price - target);
        const distStop = Math.abs(price - stop);
        if (price === target || price === stop || distTarget < 1e-6 || distStop < 1e-6) {
          outcome = distTarget <= distStop ? "win" : "loss";
        }
      }
      if (!outcome) continue;

      await Pattern.updateOne(
        { _id: doc._id },
        { $set: { outcome, exit_price: price, resolved_at: new Date() } }
      );
      // Best-effort: tell the AI side so PatternAccuracy stays in sync.
      const id = String(doc._id);
      void postPatternFeedback(id, outcome, price);
      logger.info("PatternEngine resolved", { id, symbol: sym, outcome, price });
    }
  } catch (err) {
    logger.warn("PatternEngine resolve failed", { err: (err as Error).message });
  }
}

// ─── Test hooks — exported so unit tests can drive the loops without timers. ────

export const _internal = {
  tick,
  resolveTick,
  collectActiveSymbols,
  rememberEmit,
  isMarketOpen,
  isTradingDay,
  /** Test seam — swap the AI call. Pass `null` to restore the default. */
  setDetectFn(fn: DetectFn | null): void {
    detectPatterns = fn ?? defaultDetectPatterns;
  },
  /** Test seam — clear in-memory dedupe between tests. */
  clearDedupe(): void {
    dedupe.clear();
  },
};
