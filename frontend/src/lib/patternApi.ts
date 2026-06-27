import { api } from "./api";

/**
 * Pattern API client — Phase 6.
 *
 * Thin axios wrappers around /api/patterns/* on the Node backend, which
 * either proxies to ai-service or reads MongoDB directly depending on the
 * route. Each fetcher returns null on failure rather than throwing so the
 * UI degrades gracefully when the backend is mid-restart.
 */

export interface PatternTrendlinePoint {
  time: number;
  price: number;
}

export interface PatternDoc {
  _id?: string;
  symbol: string;
  timeframe: string;
  pattern_name: string;
  category?: string;
  direction: "bullish" | "bearish" | "continuation" | "neutral";
  detected_at?: string;
  candle_indices: number[];
  confidence_score: number;
  grade: string;
  rule_strength?: number;
  ml_source?: string;
  ml_probs?: Record<string, unknown>;
  volume_confirmation?: boolean;
  trend_alignment?: boolean;
  mtf_agreement?: boolean;
  entry_price?: number;
  target_price?: number;
  stop_price?: number;
  risk_reward?: number;
  trendline_points?: PatternTrendlinePoint[];
  outcome?: "pending" | "win" | "loss" | "breakeven";
  exit_price?: number;
  resolved_at?: string;
  ai_explanation?: string;
  description?: string;
  historical_win_rate?: number;
  score_breakdown?: Record<string, number | string>;
  score_reasoning?: string[];
}

export interface LatestPatternsResponse {
  symbol: string;
  count: number;
  patterns: PatternDoc[];
}

export async function fetchLatestPatterns(symbol: string, limit = 50): Promise<LatestPatternsResponse | null> {
  try {
    const { data } = await api.get<LatestPatternsResponse>(
      `/api/patterns/latest/${encodeURIComponent(symbol.toUpperCase())}?limit=${limit}`
    );
    return data;
  } catch {
    return null;
  }
}

export type PatternTimeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "D1";

// The chart picker exposes a wider set than the detector understands; the
// chart-only timeframe Y1 is accepted by /api/patterns/ohlcv but pattern
// detection only runs on the core TFs above.
export type PatternChartTimeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "D1" | "Y1";

export interface PatternOhlcvResponse {
  symbol: string;
  timeframe: string;
  candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
}

export async function fetchPatternOhlcv(
  symbol: string,
  timeframe: PatternChartTimeframe,
  limit = 300,
): Promise<PatternOhlcvResponse | null> {
  try {
    const { data } = await api.get<PatternOhlcvResponse>(
      `/api/patterns/ohlcv/${encodeURIComponent(symbol.toUpperCase())}`,
      { params: { timeframe, limit } },
    );
    return data;
  } catch {
    return null;
  }
}

export interface DetectResponse {
  symbol: string;
  timeframe: string;
  cached: boolean;
  served_at_ms: number;
  candles_used: number;
  higher_tf: string | null;
  patterns: PatternDoc[];
}

export async function detectPatternsLive(
  symbol: string,
  timeframe: PatternTimeframe = "D1",
  lookback = 100
): Promise<DetectResponse | null> {
  try {
    const { data } = await api.get<DetectResponse>(
      `/api/patterns/detect/${encodeURIComponent(symbol.toUpperCase())}?timeframe=${timeframe}&lookback=${lookback}`
    );
    return data;
  } catch {
    return null;
  }
}

// ─── Consensus — single fused BUY/SELL/HOLD across all patterns ──────────
export interface PatternConsensusContribution {
  pattern: string;
  direction: "bullish" | "bearish" | "continuation" | "neutral";
  confidence: number;
  weight: number;
  vote: number;
  rr?: number;
  historical_win_rate?: number;
}
export interface PatternConsensusResponse {
  symbol: string;
  timeframe: string;
  action: "BUY" | "SELL";
  confidence: number;          // 0..100
  agreement: number;           // 0..1
  net_vote: number;
  total_mass: number;
  n_patterns: number;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  rationale: string;
  entry_price?: number;
  stop_price?: number;
  target_price?: number;
  weighted_rr?: number;
  contributing: PatternConsensusContribution[];
}

export async function fetchPatternConsensus(
  symbol: string,
  timeframe: PatternTimeframe = "D1",
  lookback = 100
): Promise<PatternConsensusResponse | null> {
  try {
    const { data } = await api.get<PatternConsensusResponse>(
      `/api/patterns/consensus/${encodeURIComponent(symbol.toUpperCase())}?timeframe=${timeframe}&lookback=${lookback}`
    );
    return data;
  } catch {
    return null;
  }
}

export interface ScanResponse {
  timeframe: string;
  min_confidence: number;
  symbols_requested: number;
  symbols_scanned: number;
  patterns: Array<PatternDoc & { symbol: string; timeframe: string }>;
}

export async function scanPatterns(
  symbols: string[],
  timeframe: PatternTimeframe,
  minConfidence: number,
  lookback = 100
): Promise<ScanResponse | null> {
  try {
    const { data } = await api.get<ScanResponse>(`/api/patterns/scan`, {
      params: {
        symbols: symbols.map((s) => s.toUpperCase()).join(","),
        timeframe,
        min_confidence: minConfidence,
        lookback,
      },
    });
    return data;
  } catch {
    return null;
  }
}

export interface PatternAccuracyRollup {
  pattern_name: string;
  timeframe: string;
  total_detected: number;
  wins: number;
  losses: number;
  breakevens: number;
  win_rate: number;
  avg_rr: number;
  avg_hold_bars: number;
  last_updated?: string;
}

export interface AccuracyResponse {
  available: boolean;
  rollups: PatternAccuracyRollup[];
}

export async function fetchPatternAccuracy(): Promise<AccuracyResponse | null> {
  try {
    const { data } = await api.get<AccuracyResponse>(`/api/patterns/accuracy`);
    return data;
  } catch {
    return null;
  }
}

// Admin-only: submit a training job.
export interface SubmitTrainResponse {
  job_id: string;
  status: string;
  timeframe: string;
  estimated_seconds: number;
}
export async function submitPatternTrain(timeframe: PatternTimeframe, fast = false): Promise<SubmitTrainResponse | null> {
  try {
    const { data } = await api.post<SubmitTrainResponse>(`/api/patterns/train`, { timeframe, fast });
    return data;
  } catch {
    return null;
  }
}

export async function getTrainStatus(jobId: string): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await api.get(`/api/patterns/train/${encodeURIComponent(jobId)}`);
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Analytics — Phase 10 ────────────────────────────────────────────────

export interface AnalyticsSummary {
  total_detected: number;
  resolved: number;
  wins: number;
  losses: number;
  breakevens: number;
  overall_win_rate: number;
  avg_rr_achieved: number;
  last_24h_count: number;
  best_pattern: { pattern_name: string; win_rate: number; trades: number } | null;
}

export interface WinRateRow {
  pattern_name: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  avg_rr: number;
}

export interface TimeframePnl {
  timeframe: string;
  trades: number;
  wins: number;
  win_rate: number;
  net_r: number;
}

export interface FrequencyCell {
  symbol: string;
  pattern_name: string;
  count: number;
}

export interface ConfidenceBucket {
  bucket: string;
  bucket_lo: number;
  bucket_hi: number;
  trades: number;
  wins: number;
  win_rate: number;
}

export interface DailyVolumePoint {
  date: string;
  count: number;
}

export interface LeaderboardRow {
  pattern_name: string;
  total: number;
  wins: number;
  losses: number;
  breakevens: number;
  win_rate: number;
  avg_rr: number;
  avg_hold_bars: number;
  best_symbol: { symbol: string; wins: number; total: number } | null;
  trend: "rising" | "falling" | "flat";
}

export interface AnalyticsBundle {
  filter: {
    since: string;
    until: string;
    symbols: string[];
    timeframes: string[];
    directions: string[];
  };
  summary: AnalyticsSummary;
  win_rate_by_pattern: WinRateRow[];
  pnl_by_timeframe: TimeframePnl[];
  frequency_heatmap: FrequencyCell[];
  confidence_vs_winrate: ConfidenceBucket[];
  daily_volume: DailyVolumePoint[];
  leaderboard: LeaderboardRow[];
}

export interface AnalyticsParams {
  since?: string;       // ISO datetime
  until?: string;
  symbols?: string[];
  timeframes?: PatternTimeframe[];
  directions?: Array<"bullish" | "bearish" | "continuation" | "neutral">;
}

export async function fetchPatternAnalytics(params: AnalyticsParams = {}): Promise<AnalyticsBundle | null> {
  try {
    const q = new URLSearchParams();
    if (params.since) q.set("since", params.since);
    if (params.until) q.set("until", params.until);
    if (params.symbols?.length) q.set("symbols", params.symbols.map((s) => s.toUpperCase()).join(","));
    if (params.timeframes?.length) q.set("timeframes", params.timeframes.join(","));
    if (params.directions?.length) q.set("directions", params.directions.join(","));
    const { data } = await api.get<AnalyticsBundle>(`/api/patterns/analytics?${q.toString()}`);
    return data;
  } catch {
    return null;
  }
}
