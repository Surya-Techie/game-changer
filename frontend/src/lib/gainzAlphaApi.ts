import { api } from "./api";

/**
 * Gainz Alpha API client — Brandt classical pattern model + ensemble.
 *
 * Backend proxies `/api/gainz-alpha/*` onto the ai-service. Each helper
 * returns ``null`` on failure so the UI can render a placeholder
 * instead of crashing.
 */

export interface GainzAlphaComponentScores {
  brandt_pattern: number | null;
  model_1_rsi_macd: number | null;
  model_2_sentiment_volume: number | null;
  model_3_momentum: number | null;
}

export interface GainzAlphaPositionSizing {
  capital_inr?: number;
  max_risk_inr?: number;
  max_position_inr?: number;
  stop_pct?: number;
  rule?: string;
  note?: string;
}

export interface GainzAlphaRisk {
  stop_loss_pct?: number | null;
  target_pct?: number | null;
  reward_risk?: number | null;
  position_sizing?: GainzAlphaPositionSizing;
}

export interface GainzAlphaResponse {
  symbol: string;
  pattern_detected: string | null;
  pattern_tier?: number;
  pattern_duration_weeks?: number;
  pattern_obviousness?: number;
  gainz_alpha_score: number;
  signal: "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL" | "NO_TRADE" | "NO_PATTERN";
  component_scores?: GainzAlphaComponentScores;
  weights?: Record<string, number>;
  constraint_multiplier?: number;
  brandt_rule_score?: number;
  brandt_bonuses_applied?: string[];
  reject_reasons?: string[];
  risk_management?: GainzAlphaRisk;
  note?: string;
}

export async function fetchGainzAlphaScore(
  symbol: string,
  capital?: number,
  lookbackDays = 252,
): Promise<GainzAlphaResponse | null> {
  try {
    const { data } = await api.post<GainzAlphaResponse>(
      `/api/gainz-alpha/score/${encodeURIComponent(symbol.toUpperCase())}`,
      { lookback_days: lookbackDays, ...(capital ? { capital } : {}) },
    );
    return data;
  } catch {
    return null;
  }
}

export interface GainzAlphaHealth {
  engine_ready: boolean;
  models?: Record<string, { path: string; exists: boolean }>;
  error?: string;
}

export async function fetchGainzAlphaHealth(): Promise<GainzAlphaHealth | null> {
  try {
    const { data } = await api.get<GainzAlphaHealth>("/api/gainz-alpha/health");
    return data;
  } catch {
    return null;
  }
}
