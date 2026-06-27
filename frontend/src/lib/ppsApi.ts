import { api } from "./api";

/**
 * PPS (Pattern Probability Strategy) API client.
 * Thin axios wrapper around POST /api/pps-signals. Returns null on failure
 * so the UI can render an empty state instead of throwing.
 */

export type PpsAction = "BUY" | "SELL" | "HOLD";

export type PpsPatternId =
  | "symmetrical_triangle"
  | "ascending_triangle"
  | "descending_triangle"
  | "head_shoulders_continuation"
  | "double_bottom"
  | "double_top";

export interface PpsBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface PpsSignal {
  bar_index: number;
  date: string;
  signal: PpsAction;
  pattern: PpsPatternId | null;
  confidence: number;
  entry_price: number | null;
  stop_loss: number | null;
  target_price: number | null;
  risk_reward: number | null;
  trend_aligned: boolean;
  // Analytics → PPS enrichment. measured_win_rate is the pattern's measured
  // historical win rate (0..1) when it has resolved samples, else null.
  // combined_confidence blends the engine confidence toward it by sample size.
  measured_win_rate?: number | null;
  measured_samples?: number;
  combined_confidence?: number;
}

export interface PpsSignalsResponse {
  symbol: string;
  timeframe: string;
  signals: PpsSignal[];
  summary: {
    total_signals: number;
    buy_count: number;
    sell_count: number;
    avg_confidence: number;
  };
  reason?: string;
}

/** Short tag rendered above/below the candle. */
export const PATTERN_SHORT: Record<PpsPatternId, string> = {
  symmetrical_triangle: "SYM▲",
  ascending_triangle: "ASC▲",
  descending_triangle: "DSC▲",
  head_shoulders_continuation: "H&S",
  double_bottom: "2Bot",
  double_top: "2Top",
};

/** Human-readable label for tables / panels. */
export const PATTERN_LABEL: Record<PpsPatternId, string> = {
  symmetrical_triangle: "Symmetrical Triangle",
  ascending_triangle: "Ascending Triangle",
  descending_triangle: "Descending Triangle",
  head_shoulders_continuation: "Head & Shoulders (continuation)",
  double_bottom: "Double Bottom",
  double_top: "Double Top",
};

/**
 * Call POST /api/pps-signals. Caller may pass `bars` explicitly or omit
 * them and let the backend pull the recent window from its aggregator.
 */
export async function fetchPpsSignals(opts: {
  symbol: string;
  timeframe?: string;
  bars?: PpsBar[];
}): Promise<PpsSignalsResponse | null> {
  try {
    const { data } = await api.post<PpsSignalsResponse>("/api/pps-signals", {
      symbol: opts.symbol.toUpperCase(),
      timeframe: opts.timeframe ?? "1D",
      bars: opts.bars,
    });
    return data ?? null;
  } catch {
    return null;
  }
}
