// Heuristic auto-review of a closed paper trade. Generates the kind of
// "what went well / what could improve" commentary the spec asks for
// in Section 8, derived from the trade's own data (entry signal
// snapshot, MAE/MFE, hold time, R-multiple, exit reason).
//
// Stays heuristic (no LLM call) so it's free, deterministic, and
// always available. The on-disk format is plain text — the journal UI
// renders it as-is. If we ever want LLM commentary later, this is the
// single function to swap.

import { PaperTrade } from "../../models/PaperTrade.js";

export interface TradeReview {
  headline: string;
  bullets: string[];
  score: "A+" | "A" | "B" | "C" | "Mistake";
  byAi: boolean;            // false = pure heuristic; reserved for future LLM mode
}

interface TradeLike {
  symbol: string;
  direction: "LONG" | "SHORT";
  netPnl: number;
  pnlPct: number;
  rMultiple?: number;
  holdDurationMins: number;
  exitReason: string;
  entryPrice: number;
  exitPrice: number;
  maxAdverseExcursion?: number;
  maxFavorableExcursion?: number;
  entrySignal?: Record<string, unknown>;
}

function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function reviewTrade(t: TradeLike): TradeReview {
  const bullets: string[] = [];
  const won = t.netPnl > 0;
  const r = t.rMultiple ?? 0;

  // 1) Outcome framing.
  if (won) {
    bullets.push(
      r >= 2
        ? `Strong win at ${r.toFixed(2)}R — let the runner work.`
        : `Modest win at ${r.toFixed(2)}R.`
    );
  } else {
    bullets.push(
      r <= -1
        ? `Lost a full ${Math.abs(r).toFixed(2)}R on stop. Trade was sized correctly to the plan.`
        : `Loss smaller than 1R — exited before the stop or had a wide stop.`
    );
  }

  // 2) MAE vs SL — was the stop too tight or too generous?
  const sig = t.entrySignal ?? {};
  const aiSig = (sig.signal as Record<string, unknown> | undefined) ?? {};
  const composite = (sig.composite as Record<string, unknown> | undefined) ?? {};
  const aiAction = aiSig.action as string | undefined;
  const aiConf = asNum(aiSig.confidence);
  const compScore = asNum(composite.score);

  if (t.maxAdverseExcursion != null && t.entryPrice > 0) {
    const adversePct = Math.abs((t.maxAdverseExcursion - t.entryPrice) / t.entryPrice) * 100;
    if (t.exitReason === "SL" && adversePct < 1.0) {
      bullets.push(
        `Stop hit on a small adverse move (${adversePct.toFixed(2)}%). Stop may be tighter than needed.`
      );
    } else if (t.exitReason !== "SL" && adversePct > 2.0) {
      bullets.push(
        `Held through a ${adversePct.toFixed(2)}% drawdown intra-trade — discipline maintained.`
      );
    }
  }

  // 3) MFE vs TP — did the user cut a winner early?
  if (won && t.maxFavorableExcursion != null) {
    const favPct = Math.abs((t.maxFavorableExcursion - t.entryPrice) / t.entryPrice) * 100;
    const realisedPct = Math.abs(t.pnlPct);
    if (favPct > realisedPct * 1.5 && realisedPct > 0.2) {
      bullets.push(
        `Price moved ${favPct.toFixed(2)}% in your favour but you exited at ${realisedPct.toFixed(2)}%. Consider trailing further.`
      );
    }
  }

  // 4) AI alignment.
  if (aiAction && aiConf != null) {
    const expected = t.direction === "LONG" ? "BUY" : "SELL";
    if (aiAction === expected && aiConf >= 0.6) {
      bullets.push(`Aligned with AI signal (${aiAction} ${(aiConf * 100).toFixed(0)}% confidence).`);
    } else if (aiAction !== expected) {
      bullets.push(`Counter-trend: AI was ${aiAction} but you went ${t.direction}. ${won ? "Right call." : "Consider the AI take next time."}`);
    } else if (aiConf < 0.55) {
      bullets.push(`Entered on low AI confidence (${(aiConf * 100).toFixed(0)}%). Higher conviction setups historically perform better.`);
    }
  }

  // 5) Composite score gate.
  if (compScore != null) {
    if (compScore < 50 && !won) bullets.push(`Composite score was only ${compScore.toFixed(0)} at entry — below the 65+ "high-quality setup" band.`);
    if (compScore >= 70 && won) bullets.push(`High composite score (${compScore.toFixed(0)}) at entry validated the entry framework.`);
  }

  // 6) Hold time.
  if (t.holdDurationMins < 5 && t.exitReason === "MANUAL") {
    bullets.push(`Very short hold (${t.holdDurationMins}m) — was this a planned scalp or an emotional exit?`);
  } else if (won && t.holdDurationMins >= 240) {
    bullets.push(`Held the winner ${(t.holdDurationMins / 60).toFixed(1)}h — patient execution.`);
  }

  // Score.
  let score: TradeReview["score"] = "B";
  if (r >= 2 && won) score = "A+";
  else if (won && r >= 1) score = "A";
  else if (won) score = "B";
  else if (t.exitReason === "SL" && r >= -1.1) score = "B"; // planned loss
  else score = "C";

  const headline = won
    ? `✅ ${t.direction} ${t.symbol} closed +₹${t.netPnl.toFixed(0)} (${r.toFixed(2)}R)`
    : `❌ ${t.direction} ${t.symbol} closed -₹${Math.abs(t.netPnl).toFixed(0)} (${r.toFixed(2)}R)`;

  return { headline, bullets, score, byAi: false };
}

/** Build the auto-review for an existing PaperTrade by id. */
export async function reviewByTradeId(userId: string, tradeId: string): Promise<TradeReview | null> {
  const trade = await PaperTrade.findOne({ _id: tradeId, userId }).lean();
  if (!trade) return null;
  return reviewTrade(trade as unknown as TradeLike);
}
