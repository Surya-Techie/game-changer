/**
 * Per-symbol measured-edge store, fed by POWER analysis responses.
 *
 * The auto-trader consults this before executing a signal: if the POWER
 * measurement says the engine LOSES on a symbol (enough resolved trades,
 * sub-45% win rate or negative net expectancy), auto-trading that symbol
 * is suppressed. The Pattern Analytics page already refuses to endorse
 * those arrows — the auto-trader must not take trades the analytics page
 * tells the user to avoid.
 *
 * Entries expire after EDGE_TTL_MS so a stale measurement can't gate (or
 * green-light) trading forever.
 */

export interface MeasuredEdge {
  resolved_signals: number;
  win_rate_pct: number;
  avg_per_trade_pct: number;
  measuredAt: number;
}

const EDGE_TTL_MS = 24 * 60 * 60 * 1000; // re-measure at least daily
const MIN_RESOLVED_FOR_GATE = 6;         // below this a sample is noise

const store = new Map<string, MeasuredEdge>();

export function recordMeasuredEdge(
  symbol: string,
  accuracy: { resolved_signals?: number; win_rate_pct?: number; avg_per_trade_pct?: number } | null | undefined,
): void {
  if (!accuracy || typeof accuracy.resolved_signals !== "number") return;
  store.set(symbol.toUpperCase(), {
    resolved_signals: accuracy.resolved_signals,
    win_rate_pct: accuracy.win_rate_pct ?? 0,
    avg_per_trade_pct: accuracy.avg_per_trade_pct ?? 0,
    measuredAt: Date.now(),
  });
}

/** Returns a human-readable reason when the symbol is a MEASURED loser
 *  (auto-trade should skip), else null (no data / edge OK / stale). */
export function measuredLossReason(symbol: string): string | null {
  const e = store.get(symbol.toUpperCase());
  if (!e || Date.now() - e.measuredAt > EDGE_TTL_MS) return null;
  if (e.resolved_signals < MIN_RESOLVED_FOR_GATE) return null;
  if (e.win_rate_pct < 45) {
    return `measured win rate ${e.win_rate_pct.toFixed(0)}% on ${e.resolved_signals} trades`;
  }
  if (e.avg_per_trade_pct < 0) {
    return `negative measured expectancy (${e.avg_per_trade_pct.toFixed(2)}%/trade on ${e.resolved_signals} trades)`;
  }
  return null;
}
