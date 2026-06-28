import axios from "axios";
import { Alert } from "../models/Alert.js";
import { bus, type SignalEvent } from "./eventBus.js";
import { candleAggregator } from "./candleAggregator.js";
import { env } from "../config/env.js";
import { aiHeaders } from "../utils/aiHeaders.js";
import { logger } from "../utils/logger.js";

interface AlertEval {
  triggered: boolean;
  observed?: number;
}

function ema(arr: number[], period: number): number | null {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) val = arr[i]! * k + val * (1 - k);
  return val;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function evaluatePriceAlert(type: string, value: number | undefined, lastPrice: number, prevPrice: number): AlertEval {
  switch (type) {
    case "PRICE_ABOVE":
      return { triggered: value != null && lastPrice >= value, observed: lastPrice };
    case "PRICE_BELOW":
      return { triggered: value != null && lastPrice <= value, observed: lastPrice };
    case "PRICE_CHANGE_PCT": {
      if (value == null || prevPrice <= 0) return { triggered: false };
      const pct = ((lastPrice - prevPrice) / prevPrice) * 100;
      return { triggered: Math.abs(pct) >= Math.abs(value), observed: pct };
    }
    default:
      return { triggered: false };
  }
}

function evaluateIndicatorAlert(type: string, value: number | undefined, candles: { c: number; v: number }[]): AlertEval {
  const closes = candles.map((c) => c.c);
  if (closes.length < 30) return { triggered: false };
  switch (type) {
    case "RSI_ABOVE": {
      const r = rsi(closes, 14);
      return { triggered: r != null && value != null && r >= value, observed: r ?? undefined };
    }
    case "RSI_BELOW": {
      const r = rsi(closes, 14);
      return { triggered: r != null && value != null && r <= value, observed: r ?? undefined };
    }
    case "MACD_CROSS_BULL":
    case "MACD_CROSS_BEAR": {
      // 12/26 EMA crossover proxy
      const fast = ema(closes.slice(-30), 12);
      const slow = ema(closes.slice(-30), 26);
      const fastPrev = ema(closes.slice(-31, -1), 12);
      const slowPrev = ema(closes.slice(-31, -1), 26);
      if (fast == null || slow == null || fastPrev == null || slowPrev == null) return { triggered: false };
      const crossedUp = fastPrev <= slowPrev && fast > slow;
      const crossedDown = fastPrev >= slowPrev && fast < slow;
      const t = type === "MACD_CROSS_BULL" ? crossedUp : crossedDown;
      return { triggered: t, observed: fast - slow };
    }
    case "VOLUME_SPIKE": {
      if (candles.length < 20 || value == null) return { triggered: false };
      const last20 = candles.slice(-20);
      const avg = last20.reduce((s, c) => s + c.v, 0) / 20;
      const ratio = avg > 0 ? candles[candles.length - 1]!.v / avg : 0;
      return { triggered: ratio >= value, observed: ratio };
    }
    case "SUPERTREND_FLIP_BULL":
    case "SUPERTREND_FLIP_BEAR": {
      // Simple proxy: detect cross of close vs 21-EMA (Supertrend full calc lives in Python)
      const ema21 = ema(closes, 21);
      const ema21Prev = ema(closes.slice(0, -1), 21);
      if (ema21 == null || ema21Prev == null) return { triggered: false };
      const last = closes[closes.length - 1]!;
      const prev = closes[closes.length - 2]!;
      const flipUp = prev <= ema21Prev && last > ema21;
      const flipDown = prev >= ema21Prev && last < ema21;
      return { triggered: type === "SUPERTREND_FLIP_BULL" ? flipUp : flipDown };
    }
    default:
      return { triggered: false };
  }
}

const lastTickPriceMap = new Map<string, number>();

// Alert docs are hydrated Mongoose documents that get mutated and saved;
// Mongoose's find() return type collapses unhelpfully across versions, so
// this file deliberately treats them as `any` at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fireAlert(alert: any, observed: number | undefined) {
  alert.triggerCount += 1;
  alert.lastTriggeredAt = new Date();
  alert.lastTriggeredValue = observed;
  alert.history = [{ ts: new Date(), value: observed }, ...(alert.history ?? [])].slice(0, 20);
  await alert.save();
  // Custom event for alert UI — piggyback on the position channel via a tag.
  // (We deliberately do NOT emit a "portfolio" event here — an alert firing
  // must not overwrite the dashboard's equity/P&L with zeros.)
  bus.emit("position", {
    userId: String(alert.userId),
    positionId: `alert:${alert._id}`,
    symbol: alert.symbol,
    side: "LONG",
    qty: 0,
    entryPrice: observed ?? 0,
    status: "OPEN",
    exitReason: `ALERT:${alert.type}`,
    realisedPnl: 0,
  });
  logger.info("Alert fired", { id: String(alert._id), symbol: alert.symbol, type: alert.type, observed });
}

export function startAlertWatcher() {
  bus.on("tick", async (tick) => {
    const prev = lastTickPriceMap.get(tick.symbol) ?? tick.price;
    lastTickPriceMap.set(tick.symbol, tick.price);
    // Cheap check: load only price-based enabled alerts on this symbol.
    const priceAlerts = await Alert.find({
      symbol: tick.symbol,
      enabled: true,
      type: { $in: ["PRICE_ABOVE", "PRICE_BELOW", "PRICE_CHANGE_PCT"] },
    });
    for (const a of priceAlerts) {
      const ev = evaluatePriceAlert(a.type, a.value ?? undefined, tick.price, prev);
      if (ev.triggered) {
        // Cooldown: don't re-fire within 30s.
        if (a.lastTriggeredAt && Date.now() - a.lastTriggeredAt.getTime() < 30_000) continue;
        await fireAlert(a, ev.observed);
      }
    }
  });

  // On every candle close, evaluate indicator alerts.
  candleAggregator.on("candle:closed", async (candle) => {
    const indAlerts = await Alert.find({
      symbol: candle.symbol,
      enabled: true,
      type: { $in: ["RSI_ABOVE", "RSI_BELOW", "MACD_CROSS_BULL", "MACD_CROSS_BEAR", "VOLUME_SPIKE", "SUPERTREND_FLIP_BULL", "SUPERTREND_FLIP_BEAR"] },
    });
    if (!indAlerts.length) return;
    const candles = candleAggregator.getCandles(candle.symbol, 60);
    for (const a of indAlerts) {
      const ev = evaluateIndicatorAlert(a.type, a.value ?? undefined, candles);
      if (ev.triggered) {
        if (a.lastTriggeredAt && Date.now() - a.lastTriggeredAt.getTime() < 30_000) continue;
        await fireAlert(a, ev.observed);
      }
    }
  });

  // Phase 11 — Pattern alerts. patternEngine emits 'pattern' for every
  // detection ≥ MIN_EMIT_CONF (75 by default). We match against any saved
  // PATTERN_ALERT whose patternNames whitelist (if set) and minConfidence
  // gate accept this event.
  bus.on("pattern", async (p) => {
    const candidates = await Alert.find({
      symbol: p.symbol.toUpperCase(),
      enabled: true,
      type: "PATTERN_ALERT",
    });
    if (!candidates.length) return;
    for (const a of candidates) {
      if (a.lastTriggeredAt && Date.now() - a.lastTriggeredAt.getTime() < 30_000) continue;
      const names = (a.patternNames ?? []) as string[];
      if (names.length && !names.includes(p.pattern_name)) continue;
      const dirs = (a.patternDirections ?? []) as string[];
      if (dirs.length && !dirs.includes(p.direction)) continue;
      const tfs = (a.patternTimeframes ?? []) as string[];
      if (tfs.length && !tfs.includes(p.timeframe)) continue;
      const minConf = a.patternMinConfidence ?? 75;
      if (p.confidence < minConf) continue;
      await fireAlert(a, p.confidence);
    }
  });

  // AI signal alerts.
  bus.on("signal", async (sig: SignalEvent) => {
    if (sig.action === "HOLD") return;
    const aiType = sig.action === "BUY" ? "AI_SIGNAL_BUY" : "AI_SIGNAL_SELL";
    const alerts = await Alert.find({
      symbol: sig.symbol,
      enabled: true,
      type: aiType,
    });
    for (const a of alerts) {
      if (a.lastTriggeredAt && Date.now() - a.lastTriggeredAt.getTime() < 30_000) continue;
      await fireAlert(a, sig.confidence);
    }
    // Composite alerts (we need to invoke the composite endpoint — but since
    // it's expensive, we skip composite-based alerts on every signal here).
    const compAlerts = await Alert.find({
      symbol: sig.symbol,
      enabled: true,
      type: { $in: ["COMPOSITE_ABOVE", "COMPOSITE_BELOW"] },
    });
    if (compAlerts.length) {
      // For now use confidence as a proxy (composite is recomputed off-loop).
      for (const a of compAlerts) {
        const observed = sig.confidence * 100;
        const triggered =
          (a.type === "COMPOSITE_ABOVE" && a.value != null && observed >= a.value) ||
          (a.type === "COMPOSITE_BELOW" && a.value != null && observed <= a.value);
        if (triggered) {
          if (a.lastTriggeredAt && Date.now() - a.lastTriggeredAt.getTime() < 30_000) continue;
          await fireAlert(a, observed);
        }
      }
    }
  });

  // INDICATOR_FORMULA evaluator runs on its own cadence (every 60s)
  // because it requires an out-of-process call to the ai-service.
  // Each formula's previously observed indicator values are stored on
  // the alert document so we can detect crosses between evaluations.
  startFormulaEvaluator();

  logger.info("AlertWatcher started");
}

// ────────────────────────────────────────────────────────────────────────
// INDICATOR_FORMULA evaluation
// ────────────────────────────────────────────────────────────────────────

interface FormulaCondition {
  indicator: string;
  operator: "crosses_above" | "crosses_below" | "is_above" | "is_below";
  rhs: number | string;
}

const FORMULA_EVAL_INTERVAL_MS = 60_000;
const FORMULA_COOLDOWN_MS = 60_000;

function startFormulaEvaluator() {
  const tick = async () => {
    // Mongoose's `find()` return type collapses to `unknown[]` here in some
    // versions, and the rest of this file already treats alert docs as
    // `any` (see fireAlert above). We follow the same pattern for consistency.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alerts: any[] = [];
    try {
      alerts = await Alert.find({ enabled: true, type: "INDICATOR_FORMULA" });
    } catch (err) {
      logger.warn("formula alert fetch failed", { err: (err as Error).message });
      return;
    }
    if (alerts.length === 0) return;
    // Group by (symbol, timeframe) so we only hit /indicators/snapshot once per group.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groups = new Map<string, any[]>();
    for (const a of alerts) {
      const tf = (a.formulaTimeframe as string | undefined) ?? "M15";
      const key = `${a.symbol}|${tf}`;
      const list = groups.get(key) ?? [];
      list.push(a);
      groups.set(key, list);
    }
    for (const [key, group] of groups.entries()) {
      const [symbol, tf] = key.split("|");
      let snapshot: Record<string, number | null> | null = null;
      try {
        const res = await axios.get(
          `${env.aiServiceUrl}/indicators/snapshot/${encodeURIComponent(symbol)}`,
          { params: { timeframe: tf }, timeout: 10_000, headers: aiHeaders() }
        );
        snapshot = (res.data?.values ?? {}) as Record<string, number | null>;
      } catch (err) {
        logger.warn("indicator snapshot fetch failed", { symbol, tf, err: (err as Error).message });
        continue;
      }
      if (!snapshot) continue;
      for (const a of group) {
        await evaluateFormulaAlert(a, snapshot);
      }
    }
  };
  setInterval(() => {
    void tick().catch((err) => logger.warn("formula tick error", { err: (err as Error).message }));
  }, FORMULA_EVAL_INTERVAL_MS);
}

async function evaluateFormulaAlert(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: any,
  snapshot: Record<string, number | null>
) {
  const formula: FormulaCondition[] | undefined = a.formula;
  if (!formula || formula.length === 0) return;
  const previous: Record<string, number> = a.lastFormulaValues ?? {};

  const cur: Record<string, number | undefined> = {};
  for (const cond of formula) {
    const v = snapshot[cond.indicator];
    if (v != null) cur[cond.indicator] = v;
    if (typeof cond.rhs === "string") {
      const rv = snapshot[cond.rhs];
      if (rv != null) cur[cond.rhs] = rv;
    }
  }

  // Every condition must be satisfied (AND) for the alert to fire.
  let allMet = true;
  const triggerDetails: Record<string, number> = {};
  for (const cond of formula) {
    const lhs = cur[cond.indicator];
    const rhs = typeof cond.rhs === "number" ? cond.rhs : cur[cond.rhs];
    if (lhs == null || rhs == null) {
      allMet = false;
      break;
    }
    const prevLhs = previous[cond.indicator];
    const prevRhs = typeof cond.rhs === "number" ? cond.rhs : previous[cond.rhs];
    let met = false;
    switch (cond.operator) {
      case "is_above":
        met = lhs > rhs;
        break;
      case "is_below":
        met = lhs < rhs;
        break;
      case "crosses_above":
        met = prevLhs != null && prevRhs != null && prevLhs <= prevRhs && lhs > rhs;
        break;
      case "crosses_below":
        met = prevLhs != null && prevRhs != null && prevLhs >= prevRhs && lhs < rhs;
        break;
    }
    if (!met) {
      allMet = false;
      break;
    }
    triggerDetails[cond.indicator] = lhs;
  }

  // Always persist the latest values so the next pass has prior state for crosses.
  a.lastFormulaValues = cur as Record<string, number>;
  try {
    await a.save();
  } catch (err) {
    logger.warn("formula alert state save failed", { err: (err as Error).message });
  }

  if (!allMet) return;
  if (a.lastTriggeredAt && Date.now() - a.lastTriggeredAt.getTime() < FORMULA_COOLDOWN_MS) return;

  // Use the first condition's LHS as the "observed" surface for the
  // existing fireAlert pipeline. The full breakdown is persisted via
  // lastFormulaValues on the document.
  const observedKey = formula[0].indicator;
  await fireAlert(a, triggerDetails[observedKey]);
}
