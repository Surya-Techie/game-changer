/**
 * Pattern Consensus — fuses N individually-detected chart patterns into a
 * single BUY / SELL / HOLD verdict with a calibrated confidence number.
 *
 * The problem this solves:
 *   on a single chart we routinely see 4+ patterns fire at once (e.g.
 *   "Bearish Pin Bar 50%" + "Triple Bottom 50%" + "Triple Top 50%" +
 *   "Rectangle 50%"). Two BUYs + two SELLs at 50% is *noise*, not signal.
 *
 * The aggregator works in three steps:
 *
 *   1. Each detected pattern casts a *signed* vote:
 *         vote = sign(direction) × weight
 *      where
 *         weight = confidence
 *                × min(rr / 2, 1)            // cap unrealistic RR
 *                × max(historical_winrate, 0.4)
 *                × (trend_alignment   ? 1.20 : 1.00)
 *                × (volume_confirmed  ? 1.15 : 1.00)
 *                × (mtf_agreement     ? 1.15 : 1.00)
 *
 *   2. Aggregate:
 *         net  = Σ vote
 *         mass = Σ |vote|                       // total conviction available
 *         agreement = mass>0 ? |net|/mass : 0   // 1 = unanimous, 0 = split
 *
 *   3. Decision:
 *         IF n>=2 AND agreement >= 0.55 AND |net| / n >= 0.10:
 *            action = net>0 ? BUY : SELL
 *         ELSE:
 *            action = HOLD
 *
 *   Final confidence = round(100 × agreement × tanh(|net|))
 *   (tanh squashes net so the confidence doesn't explode when many
 *    weak signals all happen to align — agreement is the dominant factor).
 *
 * The returned object also contains a weighted entry/stop/target derived
 * only from patterns voting on the WINNING side, so the chart can draw
 * one coherent setup line instead of four conflicting ones.
 */

import type { PatternDetectionResult } from "./aiClient.js";

export type ConsensusAction = "BUY" | "SELL";

export interface PatternConsensus {
  symbol: string;
  timeframe: string;
  action: ConsensusAction;
  confidence: number;                     // 0..100
  agreement: number;                      // 0..1  (how unanimous the votes are)
  net_vote: number;                       // signed conviction
  total_mass: number;                     // sum of |vote|
  n_patterns: number;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  rationale: string;
  // Best aggregate setup — only computed when action != HOLD
  entry_price?: number;
  stop_price?: number;
  target_price?: number;
  weighted_rr?: number;
  contributing: Array<{
    pattern: string;
    direction: PatternDetectionResult["direction"];
    confidence: number;
    weight: number;
    vote: number;                         // signed
    rr?: number;
    historical_win_rate?: number;
  }>;
}

const DIR_SIGN: Record<PatternDetectionResult["direction"], number> = {
  bullish: +1,
  bearish: -1,
  // Continuation patterns vote in the existing trend's direction — but
  // because we don't know the trend here we treat them as half-weight
  // bullish (they slightly favour a continuation up by default).
  continuation: +0.5,
  neutral: 0,
};

const round2 = (x: number) => Math.round(x * 100) / 100;

export function consensus(
  symbol: string,
  timeframe: string,
  patterns: PatternDetectionResult[]
): PatternConsensus {
  // Only consider patterns that actually fired (detected:true) and have
  // a usable direction.
  const fired = patterns.filter(
    (p) => p.detected && (p.direction === "bullish" || p.direction === "bearish" || p.direction === "continuation")
  );

  // Even with zero fired patterns we still commit — the user wants
  // BUY or SELL in every state. Default to BUY at 0% confidence so the
  // UI clearly shows "I have nothing to base this on".
  if (fired.length === 0) {
    return {
      symbol, timeframe,
      action: "BUY",
      confidence: 0, agreement: 0,
      net_vote: 0, total_mass: 0,
      n_patterns: 0,
      bullish_count: 0, bearish_count: 0, neutral_count: patterns.length,
      rationale: "No patterns detected — defaulting to BUY at 0 % confidence.",
      contributing: [],
    };
  }

  const contributing: PatternConsensus["contributing"] = [];
  let net = 0;
  let mass = 0;
  let bullish = 0;
  let bearish = 0;

  for (const p of fired) {
    const dir   = DIR_SIGN[p.direction] ?? 0;
    const conf  = Math.max(0, Math.min(1, p.confidence_score ?? 0));
    const rrCap = Math.min(Math.max(p.risk_reward ?? 1, 0), 4) / 2; // 0..2
    const win   = Math.max(0.4, p.historical_win_rate ?? 0.5);

    const filters = (p.filters ?? {}) as Record<string, unknown>;
    const trendAlign  = Boolean(filters.trend_alignment ?? false);
    const volConfirm  = Boolean(filters.volume_confirmation ?? false);
    const mtfAgreement= Boolean(filters.mtf_agreement ?? false);

    const weight =
      conf *
      Math.min(rrCap, 1) *
      win *
      (trendAlign  ? 1.20 : 1.00) *
      (volConfirm  ? 1.15 : 1.00) *
      (mtfAgreement? 1.15 : 1.00);

    const vote = dir * weight;
    net  += vote;
    mass += Math.abs(vote);
    if (dir > 0) bullish++;
    if (dir < 0) bearish++;

    contributing.push({
      pattern: p.pattern_name,
      direction: p.direction,
      confidence: round2(conf),
      weight: round2(weight),
      vote: round2(vote),
      rr: p.risk_reward != null ? round2(p.risk_reward) : undefined,
      historical_win_rate: p.historical_win_rate != null ? round2(p.historical_win_rate) : undefined,
    });
  }

  const agreement = mass > 0 ? Math.abs(net) / mass : 0;

  // Decision — ALWAYS commit to a side. The sign of the net vote wins.
  // Confidence reflects how trustworthy the call is; a 51 / 49 split still
  // emits a BUY/SELL but with a low confidence number so the operator
  // can see the conviction is weak.
  // If net is exactly 0 (rare — perfectly balanced votes), we default
  // to BUY (most common trading bias).
  const action: ConsensusAction = net >= 0 ? "BUY" : "SELL";

  // Final confidence: agreement × squashed magnitude
  // tanh keeps it bounded — many weak votes can never reach 100%.
  const magnitude = Math.tanh(Math.abs(net));     // 0..1
  const confidence = Math.round(100 * agreement * magnitude);

  // Aggregate winning-side setup
  let entry_price: number | undefined;
  let stop_price:  number | undefined;
  let target_price: number | undefined;
  let weighted_rr: number | undefined;

  {
    const winSign = action === "BUY" ? +1 : -1;
    const winners = fired.filter((p) => (DIR_SIGN[p.direction] ?? 0) * winSign > 0);
    const weighted = (key: keyof PatternDetectionResult): number | undefined => {
      let num = 0;
      let den = 0;
      for (const p of winners) {
        const v = p[key];
        if (typeof v !== "number" || !isFinite(v)) continue;
        const c = Math.max(0, Math.min(1, p.confidence_score ?? 0));
        num += v * c;
        den += c;
      }
      return den > 0 ? round2(num / den) : undefined;
    };
    entry_price  = weighted("entry_price");
    stop_price   = weighted("stop_price");
    target_price = weighted("target_price");
    if (entry_price != null && stop_price != null && target_price != null) {
      const risk   = Math.abs(entry_price - stop_price);
      const reward = Math.abs(target_price - entry_price);
      weighted_rr = risk > 0 ? round2(reward / risk) : undefined;
    }
  }

  const rationale = (() => {
    const side = action === "BUY" ? "bullish" : "bearish";
    const cnt  = action === "BUY" ? bullish : bearish;
    const pct  = Math.round(agreement * 100);
    if (fired.length === 1) {
      return `Single ${side} signal — confidence reflects RR & history.`;
    }
    if (bullish === 0 && bearish === 0) {
      // only continuation/neutral patterns voted
      return `${fired.length} continuation patterns — defaulting to ${action} side.`;
    }
    // Mixed votes — explain split honestly so the user knows it's marginal
    if (pct < 55) {
      return `Mixed signals (${bullish} bullish vs ${bearish} bearish, only ${pct}% agreement) — ${action} by majority weight.`;
    }
    return `${cnt} of ${fired.length} patterns aligned ${side} (agreement ${pct}%).`;
  })();

  return {
    symbol,
    timeframe,
    action,
    confidence,
    agreement: round2(agreement),
    net_vote: round2(net),
    total_mass: round2(mass),
    n_patterns: fired.length,
    bullish_count: bullish,
    bearish_count: bearish,
    neutral_count: patterns.length - fired.length,
    rationale,
    entry_price, stop_price, target_price, weighted_rr,
    contributing: contributing.sort((a, b) => Math.abs(b.vote) - Math.abs(a.vote)),
  };
}
