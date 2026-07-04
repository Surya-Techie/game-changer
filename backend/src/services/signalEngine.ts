import { env } from "../config/env.js";
import { Signal } from "../models/Signal.js";
import { AccountState } from "../models/AccountState.js";
import { candleAggregator } from "./candleAggregator.js";
import { mockFeed } from "./mockFeed.js";
import {
  detectPatterns,
  getAiSignal,
  type PatternTimeframe,
  type StrategyToggles,
} from "./aiClient.js";
import { bus } from "./eventBus.js";
import { logger } from "../utils/logger.js";
import { redis } from "../db/redis.js";
import { isMarketOpen } from "./paper/marketHours.js";

/**
 * Phase 11 Layer-6 thresholds. Tunable via env so we can A/B the impact
 * of the pattern confirmation without redeploying.
 */
const PATTERN_LAYER_MIN_CONF = Number(process.env.SIGNAL_PATTERN_MIN_CONF ?? 75);
const PATTERN_AGREE_DELTA = Number(process.env.SIGNAL_PATTERN_AGREE_DELTA ?? 0.08);
const PATTERN_DISAGREE_DELTA = Number(process.env.SIGNAL_PATTERN_DISAGREE_DELTA ?? -0.05);
const PATTERN_LAYER_TIMEFRAME = (process.env.SIGNAL_PATTERN_TIMEFRAME ?? "M15") as PatternTimeframe;

let timer: NodeJS.Timeout | undefined;

export function startSignalEngine() {
  if (timer) return;
  logger.info("SignalEngine started", { intervalMs: env.signalIntervalMs });
  timer = setInterval(tick, env.signalIntervalMs);
  setTimeout(tick, 3_000);
}

export function stopSignalEngine() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

async function getMergedStrategyToggles(): Promise<StrategyToggles> {
  // Use the toggles of whichever account is currently configured to AUTO.
  // (Single-user-style — in a multi-tenant deployment you'd run signals per user
  // or expose per-user strategy slots and broadcast accordingly.)
  const state = await AccountState.findOne({ autoTradeMode: { $ne: "OFF" } }).lean();
  if (!state) return {};
  return {
    // Entry filters are shared with the auto-trader…
    regimeFilter: state.regimeFilterEnabled,
    regimeMinAdx: state.regimeMinAdx,
    mtfConfirmation: state.mtfConfirmation,
    // …but exit geometry is NOT: emitted signals always use the AI
    // service's accuracy-profile stop/target (what the measured hit rate
    // is tracked against). The auto-trader re-derives its own trade
    // target from the account's stopMode / stopPct / targetRR.
  };
}

/**
 * Layer 6: Pattern confirmation.
 *
 * After the indicator-based AI signal is produced, query the pattern engine
 * for the same symbol/timeframe. If a high-confidence pattern (≥ PATTERN_LAYER_MIN_CONF)
 * agrees with the signal direction, add a small positive delta to confidence;
 * if it disagrees, subtract a smaller delta as a conflict warning. Returns
 * the chosen pattern (best agreeing first, then any conflicting) plus the
 * adjusted confidence so the caller can persist both.
 */
async function applyPatternLayer(
  symbol: string,
  action: "BUY" | "SELL" | "HOLD",
  baseConfidence: number,
): Promise<{
  confidence: number;
  pattern_confirmation: NonNullable<import("./eventBus.js").SignalEvent["pattern_confirmation"]> | null;
}> {
  if (action === "HOLD") {
    return { confidence: baseConfidence, pattern_confirmation: null };
  }
  let detect;
  try {
    detect = await detectPatterns(symbol, PATTERN_LAYER_TIMEFRAME, 100);
  } catch {
    detect = null;
  }
  if (!detect?.patterns?.length) {
    return { confidence: baseConfidence, pattern_confirmation: null };
  }

  const wantDir = action === "BUY" ? "bullish" : "bearish";
  // Only consider patterns that materially passed the engine.
  const eligible = detect.patterns.filter(
    (p) => p.detected && (p.confidence_score ?? 0) >= PATTERN_LAYER_MIN_CONF
  );
  if (eligible.length === 0) {
    return { confidence: baseConfidence, pattern_confirmation: null };
  }
  const agreeing = eligible
    .filter((p) => p.direction === wantDir)
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));
  const conflicting = eligible
    .filter((p) => (wantDir === "bullish" ? p.direction === "bearish" : p.direction === "bullish"))
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));

  if (agreeing[0]) {
    const top = agreeing[0];
    const newConf = Math.min(0.99, baseConfidence + PATTERN_AGREE_DELTA);
    return {
      confidence: Number(newConf.toFixed(3)),
      pattern_confirmation: {
        pattern_name: top.pattern_name,
        grade: top.grade,
        direction: top.direction,
        confidence: top.confidence_score,
        timeframe: PATTERN_LAYER_TIMEFRAME,
        agrees: true,
        delta: PATTERN_AGREE_DELTA,
      },
    };
  }
  if (conflicting[0]) {
    const top = conflicting[0];
    const newConf = Math.max(0.0, baseConfidence + PATTERN_DISAGREE_DELTA);
    return {
      confidence: Number(newConf.toFixed(3)),
      pattern_confirmation: {
        pattern_name: top.pattern_name,
        grade: top.grade,
        direction: top.direction,
        confidence: top.confidence_score,
        timeframe: PATTERN_LAYER_TIMEFRAME,
        agrees: false,
        delta: PATTERN_DISAGREE_DELTA,
      },
    };
  }
  return { confidence: baseConfidence, pattern_confirmation: null };
}


async function tick() {
  // Only generate signals from moving prices. During market hours the feed
  // carries real NSE ticks ("live"); in dev the synthetic walk can be enabled
  // ("synthetic"). Outside both, prices are frozen at the last close —
  // evaluating indicators on a flat line produces junk signals that then sit
  // PENDING for 2h and expire, so we skip entirely.
  const syntheticEnabled = (process.env.MOCK_FEED_SYNTHETIC ?? "false").toLowerCase() === "true";
  const live = mockFeed.isLive() && isMarketOpen();
  if (!live && !syntheticEnabled) return;
  const dataSource: "live" | "synthetic" = live ? "live" : "synthetic";

  const symbols = mockFeed.symbols();
  const strategy = await getMergedStrategyToggles();
  for (const symbol of symbols) {
    const candles = candleAggregator.getCandles(symbol, 500);
    if (candles.length < 30) continue;
    const ai = await getAiSignal(symbol, candles, strategy);
    if (!ai) continue;
    const last = candles[candles.length - 1]!;
    try {
      const layer6 = await applyPatternLayer(symbol, ai.action, ai.confidence);
      const finalConfidence = layer6.confidence;

      const doc = await Signal.create({
        symbol,
        action: ai.action,
        confidence: finalConfidence,
        price: last.c,
        reason: layer6.pattern_confirmation
          ? `${ai.reason}${layer6.pattern_confirmation.agrees ? " · " : " · ⚠ "}` +
            `Pattern ${layer6.pattern_confirmation.agrees ? "confirms" : "conflicts"}: ` +
            `${layer6.pattern_confirmation.pattern_name} (${layer6.pattern_confirmation.confidence}%)`
          : ai.reason,
        indicators: ai.indicators,
        suggestedEntry: ai.suggestedEntry,
        suggestedStop: ai.suggestedStop,
        suggestedTarget: ai.suggestedTarget,
        pattern_confirmation: layer6.pattern_confirmation ?? undefined,
        dataSource,
      });
      await redis.set(`signal:latest:${symbol}`, JSON.stringify(doc), "EX", 600);
      bus.emit("signal", {
        signalId: String(doc._id),
        symbol,
        action: ai.action,
        confidence: finalConfidence,
        price: last.c,
        suggestedEntry: ai.suggestedEntry,
        suggestedStop: ai.suggestedStop,
        suggestedTarget: ai.suggestedTarget,
        reason: ai.reason,
        dataSource,
        pattern_confirmation: layer6.pattern_confirmation ?? undefined,
      });
    } catch (err) {
      logger.error("Failed to persist signal", { symbol, err: (err as Error).message });
    }
  }
}
