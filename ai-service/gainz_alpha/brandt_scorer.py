"""Rule-based Brandt scorer.

Encodes Brandt's hard filters and bonus rules from the book. The
scorer is used in two places:

1. As a hard pre-filter on training data — we never label or learn from
   setups that violate Brandt's mandatory rules (RR < 3, duration < 4
   weeks, counter-trend trades).

2. At inference, as a sanity layer in front of the ML probability.
   Returning ``reject=True`` short-circuits the engine with NO_TRADE.
"""

from __future__ import annotations

from typing import Dict, Optional


# Brandt's high-reliability pattern_type_ids (mapping in pattern_detector.py).
HIGH_RELIABILITY_IDS = {0, 1, 2, 3, 4, 5, 6, 7, 8}


def compute_brandt_score(features: Dict[str, float]) -> Dict:
    """Score a detected pattern by Brandt's rules.

    Returns
    -------
    dict
        ``brandt_score`` (0..100), ``reject`` (bool), ``reasons`` (list).
        When ``reject=True``, the caller must NOT take the trade — the
        score is forced to 0.
    """
    f = features

    # ── Hard constraints ─────────────────────────────────────────────
    hard = {
        "pattern_duration_weeks_lt_4": f.get("pattern_duration_weeks", 0) < 4,
        "reward_risk_lt_3":            f.get("reward_risk_ratio", 0) < 3.0,
        "counter_trend":               f.get("trend_direction_lt", 0) != 0
                                       and f.get("breakout_direction", 0) != 0
                                       and f.get("trend_direction_lt", 0) != f.get("breakout_direction", 0),
    }
    failed = [k for k, v in hard.items() if v]
    if failed:
        return {
            "brandt_score": 0.0,
            "reject": True,
            "reasons": failed,
        }

    score = 50.0
    reasons = []

    # Horizontal patterns: Brandt's most reliable.
    if f.get("pattern_boundary_type", 1) == 0:
        score += 20
        reasons.append("horizontal_pattern_bonus")
    else:
        score -= 10
        reasons.append("diagonal_penalty")

    # Weekly + daily harmony.
    if f.get("weekly_chart_alignment", 0) == 1:
        score += 15
        reasons.append("weekly_alignment_bonus")

    # OI dynamics — declining OI in pattern = stronger eventual breakout.
    oi = f.get("oi_change_in_pattern_pct", 0.0)
    if oi < -5:
        score += 10
        reasons.append("oi_decline_bonus")
    elif oi > 10:
        # Rising OI alongside a bearish setup adds conviction.
        if f.get("breakout_direction", 0) < 0:
            score += 5
            reasons.append("oi_rising_in_downtrend")

    # Contrarian sentiment — news fights the pattern. Brandt's best trades
    # often go against consensus.
    if f.get("news_sentiment_vs_pattern", 0) == -1:
        score += 8
        reasons.append("contrarian_signal_bonus")

    # Decisive breakout.
    if f.get("breakout_strength_pct", 0) > 1.5:
        score += 7
        reasons.append("strong_breakout_bonus")

    # Gap breakout.
    if f.get("gap_breakout", 0) == 1:
        score += 5
        reasons.append("gap_breakout_bonus")

    # High-reliability pattern type.
    if int(f.get("pattern_type_id", -1)) in HIGH_RELIABILITY_IDS:
        score += 10
        reasons.append("high_reliability_pattern")

    # Pattern obviousness — "if you can't see it on the daily chart from
    # across the room, it isn't a pattern" (Brandt).
    if f.get("pattern_obviousness_score", 0) > 0.5:
        score += 5
        reasons.append("obvious_pattern_bonus")

    return {
        "brandt_score": float(max(0.0, min(100.0, score))),
        "reject": False,
        "reasons": reasons,
        "last_day_rule_stop_pct": f.get("last_day_rule_stop_pct"),
        "measured_move_target_pct": f.get("measured_move_target_pct"),
        "reward_risk_ratio": f.get("reward_risk_ratio"),
    }
