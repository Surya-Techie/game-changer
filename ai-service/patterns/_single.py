"""Single-candle pattern detectors.

Each detector inspects the last candle (or `idx` if provided) and returns a
PatternResult. Reversal-style patterns (Hammer/Hanging Man, Shooting Star)
require trend context from the preceding bars — without prior trend the
pattern degrades to its neutral cousin (e.g. Hammer without downtrend = just
a long-wick bar).
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from ._helpers import (
    PatternResult,
    abs_body,
    body,
    candle_range,
    empty_result,
    ensure_df,
    is_bear,
    is_bull,
    is_doji,
    lower_shadow,
    make_result,
    upper_shadow,
    _val,
)


def _prior_trend(df: pd.DataFrame, idx: int, lookback: int = 6) -> str:
    """Lightweight 'uptrend' / 'downtrend' / 'sideways' label from the last
    `lookback` closes prior to `idx`. Used only to flip patterns like
    Hammer ↔ Hanging Man based on context."""
    start = max(0, idx - lookback)
    window = df["close"].iloc[start:idx]
    if len(window) < 3:
        return "sideways"
    first = float(window.iloc[0])
    last = float(window.iloc[-1])
    change = (last - first) / max(abs(first), 1e-9)
    if change > 0.012:
        return "uptrend"
    if change < -0.012:
        return "downtrend"
    return "sideways"


def _idx(df: pd.DataFrame, idx: Optional[int]) -> int:
    return (len(df) - 1) if idx is None else (idx if idx >= 0 else len(df) + idx)


# ─── Hammer-family (small body at top of range, long lower wick) ───────────

def _is_hammer_geometry(row) -> bool:
    body_a = abs_body(row)
    rng = candle_range(row)
    if body_a == 0:
        return False
    return (
        body_a < 0.35 * rng
        and lower_shadow(row) >= 2.0 * body_a
        and upper_shadow(row) <= 0.5 * body_a
    )


def detect_hammer(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Hammer", "bullish")
    row = df.iloc[i]
    if not _is_hammer_geometry(row):
        return empty_result("Hammer", "bullish")
    trend = _prior_trend(df, i)
    if trend != "downtrend":
        return empty_result("Hammer", "bullish")
    rng = candle_range(row)
    body_a = abs_body(row)
    wick_ratio = lower_shadow(row) / max(body_a, 1e-9)
    strength = min(1.0, 0.45 + 0.10 * min(wick_ratio, 5.0) / 5.0 + 0.25 * (1 - body_a / rng))
    return make_result(
        "Hammer",
        direction="bullish",
        indices=[i],
        strength=strength,
        description=(
            "Small body at top of range with a long lower wick after a downtrend — "
            "buyers absorbed the selloff and pushed price back to the open."
        ),
    )


def detect_inverted_hammer(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Inverted Hammer", "bullish")
    row = df.iloc[i]
    body_a = abs_body(row)
    rng = candle_range(row)
    if body_a == 0:
        return empty_result("Inverted Hammer", "bullish")
    geometric = (
        body_a < 0.35 * rng
        and upper_shadow(row) >= 2.0 * body_a
        and lower_shadow(row) <= 0.5 * body_a
    )
    if not geometric or _prior_trend(df, i) != "downtrend":
        return empty_result("Inverted Hammer", "bullish")
    wick_ratio = upper_shadow(row) / max(body_a, 1e-9)
    strength = min(1.0, 0.40 + 0.10 * min(wick_ratio, 5.0) / 5.0 + 0.25 * (1 - body_a / rng))
    return make_result(
        "Inverted Hammer",
        direction="bullish",
        indices=[i],
        strength=strength,
        description=(
            "Small body at the low with a long upper wick after a downtrend — "
            "early bullish attempt; needs confirmation from the next bar."
        ),
    )


def detect_shooting_star(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Shooting Star", "bearish")
    row = df.iloc[i]
    body_a = abs_body(row)
    rng = candle_range(row)
    if body_a == 0:
        return empty_result("Shooting Star", "bearish")
    geometric = (
        body_a < 0.35 * rng
        and upper_shadow(row) >= 2.0 * body_a
        and lower_shadow(row) <= 0.5 * body_a
    )
    if not geometric or _prior_trend(df, i) != "uptrend":
        return empty_result("Shooting Star", "bearish")
    wick_ratio = upper_shadow(row) / max(body_a, 1e-9)
    strength = min(1.0, 0.45 + 0.10 * min(wick_ratio, 5.0) / 5.0 + 0.25 * (1 - body_a / rng))
    return make_result(
        "Shooting Star",
        direction="bearish",
        indices=[i],
        strength=strength,
        description=(
            "Small body at the low with a long upper wick after an uptrend — "
            "buyers exhausted; sellers reclaimed control by close."
        ),
    )


def detect_hanging_man(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Hanging Man", "bearish")
    row = df.iloc[i]
    if not _is_hammer_geometry(row):
        return empty_result("Hanging Man", "bearish")
    if _prior_trend(df, i) != "uptrend":
        return empty_result("Hanging Man", "bearish")
    rng = candle_range(row)
    body_a = abs_body(row)
    wick_ratio = lower_shadow(row) / max(body_a, 1e-9)
    strength = min(1.0, 0.45 + 0.10 * min(wick_ratio, 5.0) / 5.0 + 0.20 * (1 - body_a / rng))
    return make_result(
        "Hanging Man",
        direction="bearish",
        indices=[i],
        strength=strength,
        description=(
            "Hammer-shape after an uptrend — long lower wick signals sellers "
            "are testing demand; bearish reversal warning."
        ),
    )


# ─── Doji family (body is tiny relative to range) ───────────────────────────

def detect_doji(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if rng <= 0 or body_a > 0.10 * rng:
        return empty_result("Doji", "neutral")
    # Disqualify when one of the more specific doji variants would fire.
    upper = upper_shadow(row)
    lower = lower_shadow(row)
    if (upper > 2.5 * lower and lower < 0.10 * rng) or (lower > 2.5 * upper and upper < 0.10 * rng):
        return empty_result("Doji", "neutral")
    if upper > 1.5 * body_a and lower > 1.5 * body_a and (upper + lower) > 0.7 * rng:
        # Long-legged doji rules; let that detector own the result.
        return empty_result("Doji", "neutral")
    strength = 0.45 + 0.15 * (1 - body_a / max(rng, 1e-9))
    return make_result(
        "Doji",
        direction="neutral",
        indices=[i],
        strength=strength,
        description="Open and close nearly equal — supply and demand balanced; indecision bar.",
    )


def detect_long_legged_doji(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    if not is_doji(row):
        return empty_result("Long-Legged Doji", "neutral")
    rng = candle_range(row)
    upper = upper_shadow(row)
    lower = lower_shadow(row)
    if upper < 0.3 * rng or lower < 0.3 * rng:
        return empty_result("Long-Legged Doji", "neutral")
    strength = 0.50 + 0.25 * min((upper + lower) / max(rng, 1e-9), 1.0)
    return make_result(
        "Long-Legged Doji",
        direction="neutral",
        indices=[i],
        strength=strength,
        description="Doji body with long upper and lower shadows — sharp two-sided volatility, market searching for direction.",
    )


def detect_gravestone_doji(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    if not is_doji(row, body_to_range=0.10):
        return empty_result("Gravestone Doji", "bearish")
    rng = candle_range(row)
    upper = upper_shadow(row)
    lower = lower_shadow(row)
    if upper < 0.65 * rng or lower > 0.10 * rng:
        return empty_result("Gravestone Doji", "bearish")
    strength = 0.55 + 0.25 * (upper / max(rng, 1e-9))
    return make_result(
        "Gravestone Doji",
        direction="bearish",
        indices=[i],
        strength=strength,
        description=(
            "Open ≈ close ≈ low with a long upper shadow — buyers pushed price up but "
            "were rejected, closing at the low. Bearish at tops."
        ),
    )


def detect_dragonfly_doji(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    if not is_doji(row, body_to_range=0.10):
        return empty_result("Dragonfly Doji", "bullish")
    rng = candle_range(row)
    upper = upper_shadow(row)
    lower = lower_shadow(row)
    if lower < 0.65 * rng or upper > 0.10 * rng:
        return empty_result("Dragonfly Doji", "bullish")
    strength = 0.55 + 0.25 * (lower / max(rng, 1e-9))
    return make_result(
        "Dragonfly Doji",
        direction="bullish",
        indices=[i],
        strength=strength,
        description=(
            "Open ≈ close ≈ high with a long lower shadow — sellers tried but failed; "
            "buyers reclaimed the bar. Bullish at bottoms."
        ),
    )


# ─── Body-classification patterns ───────────────────────────────────────────

def detect_spinning_top(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if rng <= 0 or body_a > 0.35 * rng or body_a < 0.05 * rng:
        return empty_result("Spinning Top", "neutral")
    upper = upper_shadow(row)
    lower = lower_shadow(row)
    if upper < body_a or lower < body_a:
        return empty_result("Spinning Top", "neutral")
    strength = 0.40 + 0.20 * min((upper + lower) / max(rng, 1e-9), 1.0)
    return make_result(
        "Spinning Top",
        direction="neutral",
        indices=[i],
        strength=strength,
        description="Small body with shadows on both sides — momentum stall, indecision.",
    )


def detect_bullish_marubozu(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if not is_bull(row) or body_a < 0.90 * rng:
        return empty_result("Bullish Marubozu", "bullish")
    strength = 0.55 + 0.30 * (body_a / max(rng, 1e-9))
    return make_result(
        "Bullish Marubozu",
        direction="bullish",
        indices=[i],
        strength=strength,
        description="Strong bull bar with no shadows — opened at low, closed at high. Buyers in full control.",
    )


def detect_bearish_marubozu(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if not is_bear(row) or body_a < 0.90 * rng:
        return empty_result("Bearish Marubozu", "bearish")
    strength = 0.55 + 0.30 * (body_a / max(rng, 1e-9))
    return make_result(
        "Bearish Marubozu",
        direction="bearish",
        indices=[i],
        strength=strength,
        description="Strong bear bar with no shadows — opened at high, closed at low. Sellers in full control.",
    )


def detect_bullish_belt_hold(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Bullish Belt Hold", "bullish")
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if rng <= 0 or not is_bull(row):
        return empty_result("Bullish Belt Hold", "bullish")
    if lower_shadow(row) > 0.05 * rng or body_a < 0.7 * rng:
        return empty_result("Bullish Belt Hold", "bullish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("Bullish Belt Hold", "bullish")
    strength = 0.50 + 0.30 * (body_a / max(rng, 1e-9))
    return make_result(
        "Bullish Belt Hold",
        direction="bullish",
        indices=[i],
        strength=strength,
        description="Bull bar opening at session low with no lower wick after a downtrend — instant buying pressure.",
    )


def detect_bearish_belt_hold(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Bearish Belt Hold", "bearish")
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if rng <= 0 or not is_bear(row):
        return empty_result("Bearish Belt Hold", "bearish")
    if upper_shadow(row) > 0.05 * rng or body_a < 0.7 * rng:
        return empty_result("Bearish Belt Hold", "bearish")
    if _prior_trend(df, i) != "uptrend":
        return empty_result("Bearish Belt Hold", "bearish")
    strength = 0.50 + 0.30 * (body_a / max(rng, 1e-9))
    return make_result(
        "Bearish Belt Hold",
        direction="bearish",
        indices=[i],
        strength=strength,
        description="Bear bar opening at session high with no upper wick after an uptrend — instant selling pressure.",
    )


def detect_high_wave(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    """Doji-ish body with very long shadows on both sides — extreme volatility."""
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if rng <= 0 or body_a > 0.20 * rng:
        return empty_result("High Wave", "neutral")
    upper = upper_shadow(row)
    lower = lower_shadow(row)
    if upper < 3 * body_a or lower < 3 * body_a:
        return empty_result("High Wave", "neutral")
    if (upper + lower) < 0.80 * rng:
        return empty_result("High Wave", "neutral")
    strength = 0.45 + 0.25 * min((upper + lower) / max(rng, 1e-9), 1.0)
    return make_result(
        "High Wave",
        direction="neutral",
        indices=[i],
        strength=strength,
        description="Tiny body with extremely long shadows on both ends — violent two-way auction; major indecision.",
    )


SINGLE_CANDLE_DETECTORS = [
    detect_hammer,
    detect_inverted_hammer,
    detect_shooting_star,
    detect_hanging_man,
    detect_doji,
    detect_long_legged_doji,
    detect_gravestone_doji,
    detect_dragonfly_doji,
    detect_spinning_top,
    detect_bullish_marubozu,
    detect_bearish_marubozu,
    detect_bullish_belt_hold,
    detect_bearish_belt_hold,
    detect_high_wave,
]
