import { api } from "./api";

export interface ChanRegime {
  band: "CALM" | "NORMAL" | "ELEVATED" | "CRISIS";
  trend: "UP" | "DOWN" | "RANGE";
  realized_vol_pct: number;
  adx_14: number;
  hurst: number;
  range_pct: number;
  is_stationary: boolean;
  leverage_haircut: number;
  favored_style: "MEAN_REVERSION" | "MOMENTUM" | "BALANCED" | "REDUCE";
  notes: string[];
}

export interface ChanScoredStrategy {
  code: string;
  title: string;
  category: "MEAN_REVERSION" | "MOMENTUM" | "HYBRID";
  fit_score: number;
  signal: string;
  when_to_use: string;
  risk_block: string;
}

export interface ChanRecommendation {
  symbol: string;
  regime: ChanRegime;
  primary: ChanScoredStrategy;
  alternates: ChanScoredStrategy[];
  sharpe_60d: number;
  kelly_half: number;
  years_for_significance: number;
  emotional_check: string;
  response_5section: string;
}

export async function fetchChanRecommendation(
  symbol: string,
  lookbackDays = 252,
): Promise<ChanRecommendation | { error: "no_data" | "unavailable" }> {
  try {
    const { data } = await api.post<ChanRecommendation>(
      `/api/chan-advisor/recommend/${encodeURIComponent(symbol.toUpperCase())}`,
      { lookback_days: lookbackDays },
    );
    return data;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    // 404 = the symbol has no usable Yahoo history (delisted / renamed /
    // partial ticker) — a data condition, not a service failure.
    return { error: status === 404 ? "no_data" : "unavailable" };
  }
}
