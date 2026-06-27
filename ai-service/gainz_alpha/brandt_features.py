"""Brandt feature extraction.

Builds the 19-feature vector consumed by the Brandt ML model. Designed
to work on a daily OHLCV DataFrame plus the detected pattern dict
returned by ``pattern_detector.detect_best_brandt_pattern``.

OI / news sentiment inputs are optional — when absent we default to
neutral values so the feature vector is always well-formed.
"""

from __future__ import annotations

from typing import Dict, Optional

import numpy as np
import pandas as pd

# Order matters — the ML model is trained on this exact column order.
BRANDT_FEATURES = [
    "pattern_type_id",
    "pattern_boundary_type",
    "pattern_duration_weeks",
    "pattern_height_pct",
    "measured_move_target_pct",
    "reward_risk_ratio",
    "pattern_touches_upper",
    "pattern_touches_lower",
    "breakout_direction",
    "trend_direction_lt",
    "weekly_chart_alignment",
    "breakout_strength_pct",
    "gap_breakout",
    "last_day_rule_stop_pct",
    "oi_change_in_pattern_pct",
    "volume_breakout_vs_avg",
    "news_sentiment_vs_pattern",
    "pattern_obviousness_score",
]

# Columns that the ML model consumes (all of the above except
# breakout_direction, which is used only for the hard-filter check).
BRANDT_ML_FEATURES = [c for c in BRANDT_FEATURES if c != "breakout_direction"]


def _long_term_trend(df: pd.DataFrame, lookback: int = 50) -> int:
    """Sign of slope of the close-price SMA(lookback). +1/-1/0."""
    if len(df) < lookback + 5:
        return 0
    sma = df["close"].rolling(lookback).mean().dropna()
    if len(sma) < 5:
        return 0
    slope = (sma.iloc[-1] - sma.iloc[-5]) / max(abs(sma.iloc[-5]), 1e-9)
    if slope > 0.005:
        return 1
    if slope < -0.005:
        return -1
    return 0


def _count_touches(highs: pd.Series, lows: pd.Series, upper: float,
                   lower: float, tol_pct: float = 0.5) -> tuple[int, int]:
    upper_tol = upper * tol_pct / 100
    lower_tol = lower * tol_pct / 100
    touches_upper = int(((highs - upper).abs() <= upper_tol).sum())
    touches_lower = int(((lows - lower).abs() <= lower_tol).sum())
    return touches_upper, touches_lower


def extract_brandt_features(
    df: pd.DataFrame,
    pattern: Dict,
    *,
    oi_change_pct: Optional[float] = None,
    news_sentiment: Optional[float] = None,
) -> Dict[str, float]:
    """Build the 19-feature vector for a single detected pattern.

    Parameters
    ----------
    df : daily OHLCV DataFrame with columns ['open','high','low','close','volume'].
    pattern : output of ``detect_best_brandt_pattern``.
    oi_change_pct : optional OI %-change observed during the pattern window.
                    Negative values are bullish for the breakout.
    news_sentiment : optional headline-sentiment score in [-1, +1].

    Returns
    -------
    Dict keyed by ``BRANDT_FEATURES``.
    """
    if df is None or len(df) < 20 or pattern is None:
        return {k: 0.0 for k in BRANDT_FEATURES}

    indices = pattern.get("candle_indices") or []
    if not indices:
        # Fall back to "last 40 bars" as the pattern window.
        start_idx = max(0, len(df) - 40)
        end_idx = len(df) - 1
    else:
        start_idx = int(min(indices))
        end_idx = int(max(indices))

    window = df.iloc[start_idx : end_idx + 1]
    if len(window) < 5:
        return {k: 0.0 for k in BRANDT_FEATURES}

    duration_bars = end_idx - start_idx + 1
    duration_weeks = duration_bars / 5.0  # 5 trading days/week

    entry_price = float(pattern.get("entry_price") or df["close"].iloc[-1])
    last_close = float(df["close"].iloc[-1])
    last_bar = df.iloc[-1]

    upper = float(window["high"].max())
    lower = float(window["low"].min())
    height = upper - lower
    height_pct = (height / entry_price) * 100 if entry_price > 0 else 0.0
    # Brandt's measured-move rule: the target distance equals the height
    # of the pattern, projected from the breakout point.
    measured_move_pct = height_pct

    # Brandt's "Last Day Rule" stop: the stop sits just beyond the
    # extreme of the bar that completed the breakout, not at an arbitrary
    # % distance. For a bullish breakout that's the low of the breakout
    # bar; for a bearish breakout, the high. This is what gives Brandt
    # setups their characteristic ≥3:1 reward/risk.
    direction = int(pattern.get("direction") or 0)
    if direction > 0:
        last_extreme = float(last_bar["low"])
        stop_dist_pct = max(0.3, (entry_price - last_extreme) / entry_price * 100)
    elif direction < 0:
        last_extreme = float(last_bar["high"])
        stop_dist_pct = max(0.3, (last_extreme - entry_price) / entry_price * 100)
    else:
        # Sideways direction means we can't apply Last Day Rule; fall
        # back to a fraction of the pattern height.
        stop_dist_pct = max(height_pct * 0.2, 0.5)

    rr = measured_move_pct / stop_dist_pct if stop_dist_pct > 0 else 0.0

    touches_u, touches_l = _count_touches(window["high"], window["low"], upper, lower)
    trend_lt = _long_term_trend(df)
    weekly_alignment = 1 if (trend_lt != 0 and trend_lt == direction) else 0

    # Breakout strength: distance of last close from the pattern boundary
    # in the breakout direction.
    boundary = upper if direction > 0 else lower
    if boundary > 0:
        breakout_strength = (last_close - boundary) / boundary * 100 * direction
    else:
        breakout_strength = 0.0

    # Gap breakout: last bar opens beyond prior bar's high (bullish) or low (bearish).
    gap = 0
    if len(df) >= 2:
        prev = df.iloc[-2]
        last = df.iloc[-1]
        if direction > 0 and last["open"] > prev["high"]:
            gap = 1
        elif direction < 0 and last["open"] < prev["low"]:
            gap = 1

    avg_vol = float(window["volume"].mean()) if "volume" in window.columns else 0.0
    last_vol = float(df["volume"].iloc[-1]) if "volume" in df.columns else 0.0
    vol_ratio = (last_vol / avg_vol) if avg_vol > 0 else 1.0

    # Pattern obviousness: how "clean" the pattern is = ratio of pattern
    # height to the in-pattern noise (mean candle range). Cleaner = higher.
    candle_ranges = (window["high"] - window["low"]).abs()
    noise = float(candle_ranges.mean()) if len(candle_ranges) else 1.0
    obviousness = float(np.clip(height / (noise * 10 + 1e-9), 0, 1))

    # News-vs-pattern: +1 same direction (consensus), -1 contrarian, 0 neutral.
    news_vs_pattern = 0
    if news_sentiment is not None and direction != 0:
        if news_sentiment > 0.1 and direction > 0:
            news_vs_pattern = 1
        elif news_sentiment < -0.1 and direction < 0:
            news_vs_pattern = 1
        elif news_sentiment > 0.1 and direction < 0:
            news_vs_pattern = -1
        elif news_sentiment < -0.1 and direction > 0:
            news_vs_pattern = -1

    return {
        "pattern_type_id":          float(pattern["id"]),
        "pattern_boundary_type":    float(pattern["boundary_type"]),
        "pattern_duration_weeks":   float(round(duration_weeks, 2)),
        "pattern_height_pct":       float(round(height_pct, 3)),
        "measured_move_target_pct": float(round(measured_move_pct, 3)),
        "reward_risk_ratio":        float(round(rr, 3)),
        "pattern_touches_upper":    float(touches_u),
        "pattern_touches_lower":    float(touches_l),
        "breakout_direction":       float(direction),
        "trend_direction_lt":       float(trend_lt),
        "weekly_chart_alignment":   float(weekly_alignment),
        "breakout_strength_pct":    float(round(breakout_strength, 3)),
        "gap_breakout":             float(gap),
        "last_day_rule_stop_pct":   float(round(stop_dist_pct, 3)),
        "oi_change_in_pattern_pct": float(oi_change_pct if oi_change_pct is not None else 0.0),
        "volume_breakout_vs_avg":   float(round(vol_ratio, 3)),
        "news_sentiment_vs_pattern": float(news_vs_pattern),
        "pattern_obviousness_score": float(round(obviousness, 3)),
    }
