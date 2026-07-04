import { api } from "./api";

/**
 * Power Analysis API client — POST /api/power-analysis.
 *
 * The Power Analysis super-composer fuses every available signal source
 * (PPS engine, classical strategy, composite layers, optional ML head)
 * and returns one verdict per historical bar. The frontend plots BUY/SELL
 * verdicts as chart markers.
 */

export type PowerAction = "BUY" | "SELL" | "HOLD";
/** Single POWER rule; "strict"/"loose" remain only as legacy aliases. */
export type PowerMode = "power" | "strict" | "loose";

export interface PowerVote {
  strategy: string;
  direction: string;
  confidence: number;
}

export interface PowerStageInfo {
  current_stage?: number | null;
  stage_label?: string | null;
  confidence?: number | null;
  warning?: string | null;
}

export interface PowerMasterConfluence {
  signal?: string | null;
  confluence_score?: number | null;
  top_reasons?: string[];
  institutional_footprint?: boolean;
}

export interface PowerSignal {
  bar_index: number;
  t: number;
  signal: PowerAction;
  composite_confidence?: number;
  agreement_count?: number;
  active_sources?: number;
  pattern?: string | null;
  entry_price?: number | null;
  stop_loss?: number | null;
  target_price?: number | null;
  risk_reward?: number | null;
  target_r?: number;
  votes?: PowerVote[];
  patterns_detected?: string[];
  filters?: string[];
  reason?: string;
  /** Stan Weinstein stage (1-4) + label + warning. */
  stage?: PowerStageInfo | null;
  /** True when stage != 2 forced every voter down to 0.40 confidence. */
  stage_cap_applied?: boolean;
  /** Master Confluence engine summary (TIER 1-4 scoring + top reasons). */
  master_confluence?: PowerMasterConfluence | null;
}

export interface PowerAccuracy {
  method: string;
  horizon_bars: number;
  resolved_signals: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  avg_per_trade_pct: number;
  total_return_pct: number;
  unresolved_signals: number;
  /** Round-trip cost (%) already deducted from every per-trade return. */
  round_trip_cost_pct?: number;
  honest_note?: string;
  note?: string;
}

export interface PowerAnalysisResponse {
  symbol: string;
  mode: PowerMode;
  target_r?: number;
  signals: PowerSignal[];
  summary: {
    total_signals: number;
    buy_count: number;
    sell_count: number;
    avg_confidence: number;
  };
  accuracy?: PowerAccuracy;
  reason?: string;
}

export interface CandleForPower {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// In-flight de-dupe: identical concurrent calls (double-mounted panels,
// a live rerun racing a slow response) share one request instead of
// stampeding the ai-service, whose scans are CPU-bound.
const _inflight = new Map<string, Promise<PowerAnalysisResponse | null>>();

/**
 * Call POST /api/power-analysis. Returns null on transport failure so the
 * UI can render an "AI service unavailable" state cleanly.
 */
export async function fetchPowerAnalysis(opts: {
  symbol: string;
  candles: CandleForPower[];
  mode?: PowerMode;
  useMl?: boolean;
  targetR?: number;
  /** Fixed stop as % of entry (e.g. 2 = 2% stop). When set, overrides
   *  the ATR-derived stop. */
  stopPct?: number;
  /** Fixed target as % of entry (e.g. 5 = 5% target). When set,
   *  overrides the R-multiple target. */
  targetPct?: number;
}): Promise<PowerAnalysisResponse | null> {
  const body: Record<string, unknown> = {
    symbol: opts.symbol.toUpperCase(),
    candles: opts.candles,
    mode: opts.mode ?? "power",
    useMl: opts.useMl ?? false,
    targetR: opts.targetR ?? 2,
  };
  if (opts.stopPct != null && opts.stopPct > 0) body.stopPct = opts.stopPct;
  if (opts.targetPct != null && opts.targetPct > 0) body.targetPct = opts.targetPct;

  const tail = opts.candles[opts.candles.length - 1];
  const key = [
    body.symbol, body.mode, body.useMl, body.targetR,
    body.stopPct ?? "", body.targetPct ?? "",
    opts.candles.length, tail?.t ?? 0, tail?.c ?? 0,
  ].join("|");
  const existing = _inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const { data } = await api.post<PowerAnalysisResponse>("/api/power-analysis", body);
      return data ?? null;
    } catch {
      return null;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}
