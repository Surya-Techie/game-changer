import { Pattern } from "../models/Pattern.js";
import type { PipelineStage } from "mongoose";

/**
 * Pattern Analytics — Phase 10.
 *
 * Mongoose aggregation pipelines that drive the Pattern Analytics
 * dashboard. Each helper accepts the same filter set:
 *
 *   • since (Date)         — lower bound on detected_at
 *   • until (Date)         — upper bound on detected_at
 *   • symbols (string[])   — restrict to these tickers (empty = all)
 *   • timeframes (string[]) — restrict to these timeframes (empty = all)
 *   • directions (string[]) — bullish / bearish / continuation / neutral
 *
 * Everything is computed off the `patterns` Mongo collection (written by
 * both the AI service via mongo_store.save_pattern and by patternEngine
 * when it resolves outcomes). No new Mongo collections are added.
 */

export interface AnalyticsFilter {
  since: Date;
  until: Date;
  symbols?: string[];
  timeframes?: string[];
  directions?: string[];
}

function baseMatch(f: AnalyticsFilter): Record<string, unknown> {
  const q: Record<string, unknown> = {
    detected_at: { $gte: f.since, $lte: f.until },
  };
  if (f.symbols && f.symbols.length) q.symbol = { $in: f.symbols.map((s) => s.toUpperCase()) };
  if (f.timeframes && f.timeframes.length) q.timeframe = { $in: f.timeframes };
  if (f.directions && f.directions.length) q.direction = { $in: f.directions };
  return q;
}


// ─── Summary cards ────────────────────────────────────────────────────────

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

export async function summary(f: AnalyticsFilter): Promise<AnalyticsSummary> {
  const match = baseMatch(f);
  const [tot] = await Pattern.aggregate<{
    _id: null;
    total: number;
    wins: number;
    losses: number;
    breakevens: number;
    resolved: number;
    sum_rr: number;
    rr_count: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$outcome", "loss"] }, 1, 0] } },
        breakevens: { $sum: { $cond: [{ $eq: ["$outcome", "breakeven"] }, 1, 0] } },
        resolved: { $sum: { $cond: [{ $ne: ["$outcome", "pending"] }, 1, 0] } },
        sum_rr: { $sum: { $cond: [{ $ne: ["$risk_reward", null] }, "$risk_reward", 0] } },
        rr_count: { $sum: { $cond: [{ $ne: ["$risk_reward", null] }, 1, 0] } },
      },
    },
  ]);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last_24h_count = await Pattern.countDocuments({ detected_at: { $gte: since24h } });

  // Best pattern: highest win_rate among names with ≥10 resolved trades.
  const bestArr = await Pattern.aggregate<{
    _id: string;
    trades: number;
    wins: number;
    win_rate: number;
  }>([
    { $match: { ...match, outcome: { $in: ["win", "loss", "breakeven"] } } },
    {
      $group: {
        _id: "$pattern_name",
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
      },
    },
    { $match: { trades: { $gte: 10 } } },
    { $addFields: { win_rate: { $divide: ["$wins", "$trades"] } } },
    { $sort: { win_rate: -1, trades: -1 } },
    { $limit: 1 },
  ]);

  const total = tot?.total ?? 0;
  const wins = tot?.wins ?? 0;
  const losses = tot?.losses ?? 0;
  const breakevens = tot?.breakevens ?? 0;
  const resolved = tot?.resolved ?? 0;
  const overall_win_rate = resolved > 0 ? wins / resolved : 0;
  const avg_rr_achieved = (tot?.rr_count ?? 0) > 0 ? (tot!.sum_rr / tot!.rr_count) : 0;
  const best = bestArr[0];

  return {
    total_detected: total,
    resolved,
    wins,
    losses,
    breakevens,
    overall_win_rate: Number(overall_win_rate.toFixed(4)),
    avg_rr_achieved: Number(avg_rr_achieved.toFixed(3)),
    last_24h_count,
    best_pattern: best ? { pattern_name: best._id, win_rate: Number(best.win_rate.toFixed(4)), trades: best.trades } : null,
  };
}


// ─── Win rate by pattern (horizontal bars) ───────────────────────────────

export interface WinRateRow {
  pattern_name: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  avg_rr: number;
}

export async function winRateByPattern(f: AnalyticsFilter, minTrades = 5): Promise<WinRateRow[]> {
  const match = baseMatch(f);
  const pipeline: PipelineStage[] = [
    { $match: { ...match, outcome: { $in: ["win", "loss", "breakeven"] } } },
    {
      $group: {
        _id: "$pattern_name",
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$outcome", "loss"] }, 1, 0] } },
        sum_rr: { $sum: { $cond: [{ $ne: ["$risk_reward", null] }, "$risk_reward", 0] } },
        rr_count: { $sum: { $cond: [{ $ne: ["$risk_reward", null] }, 1, 0] } },
      },
    },
    { $match: { trades: { $gte: minTrades } } },
    {
      $addFields: {
        win_rate: { $divide: ["$wins", "$trades"] },
        avg_rr: { $cond: [{ $gt: ["$rr_count", 0] }, { $divide: ["$sum_rr", "$rr_count"] }, 0] },
      },
    },
    { $sort: { win_rate: -1, trades: -1 } },
    { $limit: 50 },
  ];
  const rows = await Pattern.aggregate<{
    _id: string;
    trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    avg_rr: number;
  }>(pipeline);
  return rows.map((r) => ({
    pattern_name: r._id,
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    win_rate: Number(r.win_rate.toFixed(4)),
    avg_rr: Number(r.avg_rr.toFixed(3)),
  }));
}


// ─── P&L (proxy via RR sum) by timeframe ──────────────────────────────────

export interface TimeframePnl {
  timeframe: string;
  trades: number;
  wins: number;
  win_rate: number;
  // Net "RR units" — sum of risk_reward across wins minus equal-risk losses.
  // We treat each loss as -1R; each win earns its realised RR. This gives an
  // R-weighted P&L proxy without needing per-trade ₹ pnl.
  net_r: number;
}

export async function pnlByTimeframe(f: AnalyticsFilter): Promise<TimeframePnl[]> {
  const match = baseMatch(f);
  const pipeline: PipelineStage[] = [
    { $match: { ...match, outcome: { $in: ["win", "loss", "breakeven"] } } },
    {
      $group: {
        _id: "$timeframe",
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
        sum_win_r: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ["$outcome", "win"] }, { $ne: ["$risk_reward", null] }] },
              "$risk_reward",
              0,
            ],
          },
        },
        sum_loss_r: { $sum: { $cond: [{ $eq: ["$outcome", "loss"] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ];
  const rows = await Pattern.aggregate<{ _id: string; trades: number; wins: number; sum_win_r: number; sum_loss_r: number }>(pipeline);
  return rows.map((r) => ({
    timeframe: r._id,
    trades: r.trades,
    wins: r.wins,
    win_rate: r.trades > 0 ? Number((r.wins / r.trades).toFixed(4)) : 0,
    net_r: Number(((r.sum_win_r ?? 0) - (r.sum_loss_r ?? 0)).toFixed(3)),
  }));
}


// ─── Symbol × pattern frequency heatmap ──────────────────────────────────

export interface FrequencyCell {
  symbol: string;
  pattern_name: string;
  count: number;
}

export async function frequencyHeatmap(f: AnalyticsFilter, topSymbols = 12, topPatterns = 18): Promise<FrequencyCell[]> {
  const match = baseMatch(f);
  // Find top N symbols and top N patterns first, to avoid an enormous grid.
  const symAgg = await Pattern.aggregate<{ _id: string; n: number }>([
    { $match: match },
    { $group: { _id: "$symbol", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: topSymbols },
  ]);
  const pattAgg = await Pattern.aggregate<{ _id: string; n: number }>([
    { $match: match },
    { $group: { _id: "$pattern_name", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: topPatterns },
  ]);
  const symbols = symAgg.map((r) => r._id);
  const patterns = pattAgg.map((r) => r._id);
  if (symbols.length === 0 || patterns.length === 0) return [];

  const cells = await Pattern.aggregate<{ _id: { s: string; p: string }; n: number }>([
    {
      $match: {
        ...match,
        symbol: { $in: symbols },
        pattern_name: { $in: patterns },
      },
    },
    { $group: { _id: { s: "$symbol", p: "$pattern_name" }, n: { $sum: 1 } } },
  ]);
  return cells.map((c) => ({ symbol: c._id.s, pattern_name: c._id.p, count: c.n }));
}


// ─── Confidence-bucket vs realised win rate ──────────────────────────────

export interface ConfidenceBucket {
  bucket: string;         // e.g. "70-79"
  bucket_lo: number;
  bucket_hi: number;
  trades: number;
  wins: number;
  win_rate: number;
}

export async function confidenceVsWinRate(f: AnalyticsFilter): Promise<ConfidenceBucket[]> {
  const match = baseMatch(f);
  // Bucket the confidence score into 10-point bands.
  const pipeline: PipelineStage[] = [
    { $match: { ...match, outcome: { $in: ["win", "loss", "breakeven"] } } },
    {
      $addFields: {
        bucket_lo: { $multiply: [{ $floor: { $divide: ["$confidence_score", 10] } }, 10] },
      },
    },
    {
      $group: {
        _id: "$bucket_lo",
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ];
  const rows = await Pattern.aggregate<{ _id: number; trades: number; wins: number }>(pipeline);
  return rows.map((r) => ({
    bucket_lo: r._id,
    bucket_hi: r._id + 9,
    bucket: `${r._id}-${r._id + 9}`,
    trades: r.trades,
    wins: r.wins,
    win_rate: r.trades > 0 ? Number((r.wins / r.trades).toFixed(4)) : 0,
  }));
}


// ─── Daily detection volume ───────────────────────────────────────────────

export interface DailyVolumePoint {
  date: string;  // YYYY-MM-DD
  count: number;
}

export async function dailyVolume(f: AnalyticsFilter): Promise<DailyVolumePoint[]> {
  const match = baseMatch(f);
  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$detected_at" } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: 365 },
  ];
  const rows = await Pattern.aggregate<{ _id: string; count: number }>(pipeline);
  return rows.map((r) => ({ date: r._id, count: r.count }));
}


// ─── Leaderboard table ────────────────────────────────────────────────────

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

export async function leaderboard(f: AnalyticsFilter, minTrades = 5): Promise<LeaderboardRow[]> {
  const match = baseMatch(f);
  const pipeline: PipelineStage[] = [
    { $match: { ...match, outcome: { $in: ["win", "loss", "breakeven"] } } },
    {
      $group: {
        _id: "$pattern_name",
        total: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$outcome", "loss"] }, 1, 0] } },
        breakevens: { $sum: { $cond: [{ $eq: ["$outcome", "breakeven"] }, 1, 0] } },
        sum_rr: { $sum: { $cond: [{ $ne: ["$risk_reward", null] }, "$risk_reward", 0] } },
        rr_count: { $sum: { $cond: [{ $ne: ["$risk_reward", null] }, 1, 0] } },
        // resolved_at - detected_at in ms, then converted to bar-count approximation.
        // Hold-bars per timeframe is hard to compute without bar size; we
        // surface the median ms-distance and let the UI convert if it wants.
        avg_hold_ms: {
          $avg: {
            $cond: [
              { $and: [{ $ne: ["$resolved_at", null] }, { $ne: ["$detected_at", null] }] },
              { $subtract: ["$resolved_at", "$detected_at"] },
              null,
            ],
          },
        },
      },
    },
    { $match: { total: { $gte: minTrades } } },
    {
      $addFields: {
        win_rate: { $divide: ["$wins", "$total"] },
        avg_rr: { $cond: [{ $gt: ["$rr_count", 0] }, { $divide: ["$sum_rr", "$rr_count"] }, 0] },
      },
    },
    { $sort: { win_rate: -1, total: -1 } },
    { $limit: 50 },
  ];
  const rows = await Pattern.aggregate<{
    _id: string;
    total: number;
    wins: number;
    losses: number;
    breakevens: number;
    win_rate: number;
    avg_rr: number;
    avg_hold_ms: number | null;
  }>(pipeline);

  // For each top pattern, look up the best symbol (highest wins on it).
  const out: LeaderboardRow[] = [];
  for (const r of rows) {
    const bestPerSymbol = await Pattern.aggregate<{ _id: string; wins: number; total: number }>([
      { $match: { ...match, pattern_name: r._id, outcome: { $in: ["win", "loss", "breakeven"] } } },
      {
        $group: {
          _id: "$symbol",
          wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      { $sort: { wins: -1, total: -1 } },
      { $limit: 1 },
    ]);

    // Trend: compare the win-rate in the recent half to the older half of the window.
    const mid = new Date((f.since.getTime() + f.until.getTime()) / 2);
    const halves = await Pattern.aggregate<{ _id: string; trades: number; wins: number }>([
      { $match: { ...match, pattern_name: r._id, outcome: { $in: ["win", "loss", "breakeven"] } } },
      {
        $group: {
          _id: { $cond: [{ $gte: ["$detected_at", mid] }, "recent", "older"] },
          trades: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
        },
      },
    ]);
    const recent = halves.find((h) => h._id === "recent");
    const older = halves.find((h) => h._id === "older");
    const rWr = recent && recent.trades > 0 ? recent.wins / recent.trades : null;
    const oWr = older && older.trades > 0 ? older.wins / older.trades : null;
    let trend: "rising" | "falling" | "flat" = "flat";
    if (rWr != null && oWr != null) {
      if (rWr - oWr > 0.05) trend = "rising";
      else if (oWr - rWr > 0.05) trend = "falling";
    }

    // avg_hold_ms → days (a coarse, timeframe-agnostic proxy).
    const avg_hold_bars = r.avg_hold_ms ? Number((r.avg_hold_ms / (24 * 60 * 60 * 1000)).toFixed(2)) : 0;

    out.push({
      pattern_name: r._id,
      total: r.total,
      wins: r.wins,
      losses: r.losses,
      breakevens: r.breakevens,
      win_rate: Number(r.win_rate.toFixed(4)),
      avg_rr: Number(r.avg_rr.toFixed(3)),
      avg_hold_bars,
      best_symbol: bestPerSymbol[0]
        ? { symbol: bestPerSymbol[0]._id, wins: bestPerSymbol[0].wins, total: bestPerSymbol[0].total }
        : null,
      trend,
    });
  }
  return out;
}


// ─── Convenience all-in-one (used by the route) ──────────────────────────

export interface AnalyticsBundle {
  filter: { since: string; until: string; symbols: string[]; timeframes: string[]; directions: string[] };
  summary: AnalyticsSummary;
  win_rate_by_pattern: WinRateRow[];
  pnl_by_timeframe: TimeframePnl[];
  frequency_heatmap: FrequencyCell[];
  confidence_vs_winrate: ConfidenceBucket[];
  daily_volume: DailyVolumePoint[];
  leaderboard: LeaderboardRow[];
}

export async function fullBundle(f: AnalyticsFilter): Promise<AnalyticsBundle> {
  const [s, wrbp, pbtf, fh, cv, dv, lb] = await Promise.all([
    summary(f),
    winRateByPattern(f),
    pnlByTimeframe(f),
    frequencyHeatmap(f),
    confidenceVsWinRate(f),
    dailyVolume(f),
    leaderboard(f),
  ]);
  return {
    filter: {
      since: f.since.toISOString(),
      until: f.until.toISOString(),
      symbols: f.symbols ?? [],
      timeframes: f.timeframes ?? [],
      directions: f.directions ?? [],
    },
    summary: s,
    win_rate_by_pattern: wrbp,
    pnl_by_timeframe: pbtf,
    frequency_heatmap: fh,
    confidence_vs_winrate: cv,
    daily_volume: dv,
    leaderboard: lb,
  };
}
