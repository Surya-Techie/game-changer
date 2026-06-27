"""Confidence Engine — produces a 0-100 score and A+/A/B/C grade for
each detected pattern, given the rule-engine evidence plus the ML
ensemble probability.

Components (sum = 100 max, but individual components can subtract):
  rule_strength      → up to 30 pts
  ML ensemble (agreeing class) → up to 25 pts
  volume confirmation → up to 15 pts
  trend alignment    → +15 pts (agree) / −10 pts (counter-trend)
  multi-timeframe   → up to 10 pts (when higher-tf is provided)
  S/R proximity     → up to 5 pts (within 0.5% of EMA50/EMA200/recent swing)
  historical win-rate bonus → up to 10 pts (proportional to baseline win-rate)

Grades:
  A+ ≥ 85, A ≥ 70, B ≥ 55, C otherwise.

The engine never throws on missing optional inputs (no MTF df, no ML
model, no S/R data); each missing piece simply contributes 0 to the
relevant component.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, List, Optional

import pandas as pd

from ._helpers import (
    adx,
    atr,
    ema,
    ensure_df,
    trend_classify,
    volume_ratio,
    baseline_win_rate,
)
from .ml_classifier import EnsembleProbabilities, predict_proba


@dataclass
class ConfidenceScore:
    score: int  # 0..100
    grade: str  # A+ | A | B | C
    reasoning: List[str] = field(default_factory=list)
    components: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "score": int(self.score),
            "grade": self.grade,
            "reasoning": list(self.reasoning),
            "components": self.components,
        }


def _grade(score: int) -> str:
    if score >= 85:
        return "A+"
    if score >= 70:
        return "A"
    if score >= 55:
        return "B"
    return "C"


def _component(value: float, max_pts: float) -> float:
    """Clamp value to [0, max_pts]."""
    return max(0.0, min(max_pts, value))


# ─── Public scorer ────────────────────────────────────────────────────────

def score_pattern(
    pattern: dict,
    df: pd.DataFrame,
    *,
    timeframe: str = "D1",
    ml_probs: Optional[EnsembleProbabilities] = None,
    higher_tf_df: Optional[pd.DataFrame] = None,
    ema_periods: Iterable[int] = (50, 200),
    historical_win_rate_override: Optional[float] = None,
) -> ConfidenceScore:
    """Score a single PatternResult dict.

    Parameters
    ----------
    pattern : dict
        Output from a detector (must contain `direction` and `strength`;
        extended patterns may add `entry_price` for tighter S/R checks).
    df : pd.DataFrame
        OHLCV used to derive the contextual signals (volume, trend, S/R).
    timeframe : str
        Used only to pick the ML model bucket.
    ml_probs : EnsembleProbabilities, optional
        If pre-computed, pass it in to avoid re-running predict_proba. If
        omitted, we call predict_proba(df, timeframe) here.
    higher_tf_df : pd.DataFrame, optional
        Higher-timeframe OHLCV for the MTF agreement component.
    ema_periods : iterable[int]
        Which EMAs count as S/R levels (default 50, 200).
    historical_win_rate_override : float, optional
        Pass through from PatternAccuracy when it has more samples than
        the static baseline.

    Returns
    -------
    ConfidenceScore with a stable `components` breakdown.
    """
    df = ensure_df(df)
    direction = pattern.get("direction", "neutral")
    name = str(pattern.get("pattern_name", "Unknown"))
    rule_strength = float(pattern.get("strength", 0.0))
    last = float(df["close"].iloc[-1]) if len(df) else 0.0
    reasoning: List[str] = []
    components: dict = {}

    # 1) Rule strength (0–30).
    rule_pts = _component(rule_strength * 30.0, 30.0)
    components["rule_strength"] = round(rule_pts, 2)
    reasoning.append(f"Pattern rule strength {rule_strength * 100:.0f}% → {rule_pts:.1f}/30")

    # 2) ML ensemble (0–25). 0 if neutral pattern OR no trained model.
    if ml_probs is None:
        ml_probs = predict_proba(df, timeframe)
    if direction in ("bullish", "bearish") and ml_probs.source == "ensemble":
        agree_p = ml_probs.for_direction(direction)
        ml_pts = _component(agree_p * 25.0, 25.0)
        reasoning.append(
            f"ML ensemble probability of {direction} = {agree_p * 100:.0f}% → {ml_pts:.1f}/25"
        )
    elif direction in ("bullish", "bearish"):
        ml_pts = 0.0
        reasoning.append("ML model not trained yet — 0/25 (rule-only mode)")
    else:
        ml_pts = 0.0
        reasoning.append("Pattern is neutral — ML component skipped (0/25)")
    components["ml"] = round(ml_pts, 2)
    components["ml_source"] = ml_probs.source

    # 3) Volume (0–15) — linear from vr=1.0 → 0 pts, vr=2.5+ → 15 pts.
    vr = volume_ratio(df, window=20, idx=len(df) - 1)
    if vr <= 1.0:
        vol_pts = 0.0
    elif vr >= 2.5:
        vol_pts = 15.0
    else:
        vol_pts = (vr - 1.0) / 1.5 * 15.0
    components["volume"] = round(vol_pts, 2)
    reasoning.append(f"Volume {vr:.2f}× 20-bar avg → {vol_pts:.1f}/15")

    # 4) Trend alignment (+15 / -10) — only for directional patterns.
    trend = trend_classify(df)
    adx_now = float(adx(df, 14).iloc[-1]) if len(df) >= 14 else 0.0
    if direction == "bullish":
        if trend == "uptrend":
            trend_pts = 15.0
            reasoning.append(f"Bullish pattern in uptrend (ADX {adx_now:.0f}) → +15")
        elif trend == "downtrend":
            trend_pts = -10.0
            reasoning.append(f"Bullish pattern against downtrend (ADX {adx_now:.0f}) → −10")
        else:
            trend_pts = 5.0
            reasoning.append("Bullish pattern in sideways market → +5")
    elif direction == "bearish":
        if trend == "downtrend":
            trend_pts = 15.0
            reasoning.append(f"Bearish pattern in downtrend (ADX {adx_now:.0f}) → +15")
        elif trend == "uptrend":
            trend_pts = -10.0
            reasoning.append(f"Bearish pattern against uptrend (ADX {adx_now:.0f}) → −10")
        else:
            trend_pts = 5.0
            reasoning.append("Bearish pattern in sideways market → +5")
    else:
        trend_pts = 0.0
        reasoning.append("Neutral pattern — trend alignment skipped")
    components["trend"] = round(trend_pts, 2)

    # 5) Multi-timeframe (0–10).
    if higher_tf_df is not None and direction in ("bullish", "bearish"):
        higher_work = ensure_df(higher_tf_df)
        if len(higher_work) >= 50:
            higher_trend = trend_classify(higher_work)
            if higher_trend == ("uptrend" if direction == "bullish" else "downtrend"):
                mtf_pts = 10.0
                reasoning.append(f"Higher-timeframe trend agrees ({higher_trend}) → +10")
            elif higher_trend == "sideways":
                mtf_pts = 5.0
                reasoning.append("Higher-timeframe is sideways → +5")
            else:
                mtf_pts = 0.0
                reasoning.append(f"Higher-timeframe disagrees ({higher_trend}) → 0")
        else:
            mtf_pts = 0.0
            reasoning.append("Higher-timeframe data too short to evaluate → 0")
    else:
        mtf_pts = 0.0
    components["mtf"] = round(mtf_pts, 2)

    # 6) Support/Resistance proximity (0–5).
    sr_pts = 0.0
    if last > 0:
        levels: List[float] = []
        for p in ema_periods:
            if len(df) >= p:
                lvl = float(ema(df["close"], int(p)).iloc[-1])
                levels.append(lvl)
        # Recent 20-bar swing high/low as horizontal S/R.
        if len(df) >= 20:
            levels.append(float(df["high"].tail(20).max()))
            levels.append(float(df["low"].tail(20).min()))
        nearest = min((abs(last - lvl) / last for lvl in levels), default=1.0)
        if nearest <= 0.005:
            sr_pts = 5.0
            reasoning.append(f"Price within 0.5% of a key level → +5")
        elif nearest <= 0.012:
            sr_pts = 3.0
            reasoning.append(f"Price within 1.2% of a key level → +3")
        else:
            reasoning.append("No nearby key level → 0")
    components["sr"] = round(sr_pts, 2)

    # 7) Historical win-rate bonus (0–10).
    base_wr = historical_win_rate_override if historical_win_rate_override is not None else baseline_win_rate(name)
    # Map 0.50 → 0 pts, 0.80+ → 10 pts.
    if base_wr <= 0.50:
        wr_pts = 0.0
    elif base_wr >= 0.80:
        wr_pts = 10.0
    else:
        wr_pts = (base_wr - 0.50) / 0.30 * 10.0
    components["historical_win_rate"] = round(wr_pts, 2)
    reasoning.append(f"Historical win rate {base_wr * 100:.0f}% → {wr_pts:.1f}/10")

    # Sum + clamp.
    total = rule_pts + ml_pts + vol_pts + trend_pts + mtf_pts + sr_pts + wr_pts
    total = max(0.0, min(100.0, total))
    score = int(round(total))
    grade = _grade(score)

    components["total"] = score
    return ConfidenceScore(score=score, grade=grade, reasoning=reasoning, components=components)


def score_many(
    patterns: List[dict],
    df: pd.DataFrame,
    *,
    timeframe: str = "D1",
    higher_tf_df: Optional[pd.DataFrame] = None,
    ml_probs: Optional[EnsembleProbabilities] = None,
) -> List[dict]:
    """Score a list of detector results, returning enriched dicts with
    `confidence_score`, `grade`, and `score_breakdown` set. ML probs are
    computed once and reused across all patterns (predict_proba is
    deterministic given the same df + timeframe)."""
    if ml_probs is None:
        ml_probs = predict_proba(df, timeframe)
    out: List[dict] = []
    for p in patterns:
        cs = score_pattern(p, df, timeframe=timeframe, ml_probs=ml_probs, higher_tf_df=higher_tf_df)
        enriched = dict(p)
        enriched["confidence_score"] = cs.score
        enriched["grade"] = cs.grade
        enriched["score_breakdown"] = cs.components
        enriched["score_reasoning"] = cs.reasoning
        enriched["ml_probs"] = ml_probs.to_dict()
        out.append(enriched)
    out.sort(key=lambda r: r.get("confidence_score", 0), reverse=True)
    return out
