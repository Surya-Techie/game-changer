"""Three-candle pattern detectors.

Operate on the last three candles (a, b, c). All reversal patterns require
a prior trend context to fire; continuation patterns require the trend to
already be in place. This avoids false-positive matches inside noise.
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
    gap_down,
    gap_up,
    is_bear,
    is_bull,
    is_doji,
    lower_shadow,
    make_result,
    upper_shadow,
    _val,
)
from ._single import _prior_trend, _idx


# ─── Stars (reversal) ───────────────────────────────────────────────────────

def detect_morning_star(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Morning Star", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bear(a) and abs_body(b) < 0.4 * abs_body(a) and is_bull(c)):
        return empty_result("Morning Star", "bullish")
    mid_a = (_val(a, "open") + _val(a, "close")) / 2
    if _val(c, "close") <= mid_a:
        return empty_result("Morning Star", "bullish")
    if _prior_trend(df, i - 2) != "downtrend":
        return empty_result("Morning Star", "bullish")
    penetration = (_val(c, "close") - mid_a) / max(abs_body(a), 1e-9)
    strength = 0.65 + 0.20 * min(penetration, 1.0)
    return make_result(
        "Morning Star",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=strength,
        description="Large bear, small-bodied middle, then large bull closing above the bear's midpoint — classic 3-bar reversal.",
    )


def detect_evening_star(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Evening Star", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bull(a) and abs_body(b) < 0.4 * abs_body(a) and is_bear(c)):
        return empty_result("Evening Star", "bearish")
    mid_a = (_val(a, "open") + _val(a, "close")) / 2
    if _val(c, "close") >= mid_a:
        return empty_result("Evening Star", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Evening Star", "bearish")
    penetration = (mid_a - _val(c, "close")) / max(abs_body(a), 1e-9)
    strength = 0.65 + 0.20 * min(penetration, 1.0)
    return make_result(
        "Evening Star",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=strength,
        description="Large bull, small-bodied middle, then large bear closing below the bull's midpoint — classic 3-bar reversal.",
    )


def detect_morning_doji_star(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Morning Doji Star", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bear(a) and is_doji(b) and is_bull(c)):
        return empty_result("Morning Doji Star", "bullish")
    mid_a = (_val(a, "open") + _val(a, "close")) / 2
    if _val(c, "close") <= mid_a:
        return empty_result("Morning Doji Star", "bullish")
    if _prior_trend(df, i - 2) != "downtrend":
        return empty_result("Morning Doji Star", "bullish")
    return make_result(
        "Morning Doji Star",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=0.72,
        description="Doji middle bar inside a 3-bar reversal — extreme indecision flipped into a bull bar.",
    )


def detect_evening_doji_star(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Evening Doji Star", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bull(a) and is_doji(b) and is_bear(c)):
        return empty_result("Evening Doji Star", "bearish")
    mid_a = (_val(a, "open") + _val(a, "close")) / 2
    if _val(c, "close") >= mid_a:
        return empty_result("Evening Doji Star", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Evening Doji Star", "bearish")
    return make_result(
        "Evening Doji Star",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.72,
        description="Doji middle bar inside a 3-bar reversal — extreme indecision flipped into a bear bar.",
    )


# ─── Three Soldiers / Crows ─────────────────────────────────────────────────

def detect_three_white_soldiers(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Three White Soldiers", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bull(a) and is_bull(b) and is_bull(c)):
        return empty_result("Three White Soldiers", "bullish")
    if not (_val(c, "close") > _val(b, "close") > _val(a, "close")):
        return empty_result("Three White Soldiers", "bullish")
    # Each opens within the prior body.
    if not (_val(a, "close") >= _val(b, "open") >= _val(a, "open")):
        return empty_result("Three White Soldiers", "bullish")
    if not (_val(b, "close") >= _val(c, "open") >= _val(b, "open")):
        return empty_result("Three White Soldiers", "bullish")
    # Solid bodies — upper shadows small.
    for r in (a, b, c):
        if abs_body(r) < 0.5 * candle_range(r) or upper_shadow(r) > 0.5 * abs_body(r):
            return empty_result("Three White Soldiers", "bullish")
    return make_result(
        "Three White Soldiers",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=0.78,
        description="Three consecutive large bull bars with higher closes — sustained, broad buying pressure.",
    )


def detect_three_black_crows(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Three Black Crows", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bear(a) and is_bear(b) and is_bear(c)):
        return empty_result("Three Black Crows", "bearish")
    if not (_val(c, "close") < _val(b, "close") < _val(a, "close")):
        return empty_result("Three Black Crows", "bearish")
    if not (_val(a, "close") <= _val(b, "open") <= _val(a, "open")):
        return empty_result("Three Black Crows", "bearish")
    if not (_val(b, "close") <= _val(c, "open") <= _val(b, "open")):
        return empty_result("Three Black Crows", "bearish")
    for r in (a, b, c):
        if abs_body(r) < 0.5 * candle_range(r) or lower_shadow(r) > 0.5 * abs_body(r):
            return empty_result("Three Black Crows", "bearish")
    return make_result(
        "Three Black Crows",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.78,
        description="Three consecutive large bear bars with lower closes — sustained, broad selling pressure.",
    )


# ─── Three Inside / Outside Up/Down ─────────────────────────────────────────

def detect_three_inside_up(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Three Inside Up", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    # Bar 1+2 = bullish harami
    if not (is_bear(a) and is_bull(b)):
        return empty_result("Three Inside Up", "bullish")
    if not (max(_val(b, "open"), _val(b, "close")) <= max(_val(a, "open"), _val(a, "close"))
            and min(_val(b, "open"), _val(b, "close")) >= min(_val(a, "open"), _val(a, "close"))):
        return empty_result("Three Inside Up", "bullish")
    # Bar 3 = bull closing above bar 1 high
    if not (is_bull(c) and _val(c, "close") > _val(a, "open")):
        return empty_result("Three Inside Up", "bullish")
    if _prior_trend(df, i - 2) != "downtrend":
        return empty_result("Three Inside Up", "bullish")
    return make_result(
        "Three Inside Up",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=0.68,
        description="Bullish harami confirmed by a third bar closing above the prior bear's open — reversal confirmed.",
    )


def detect_three_inside_down(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Three Inside Down", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bull(a) and is_bear(b)):
        return empty_result("Three Inside Down", "bearish")
    if not (max(_val(b, "open"), _val(b, "close")) <= max(_val(a, "open"), _val(a, "close"))
            and min(_val(b, "open"), _val(b, "close")) >= min(_val(a, "open"), _val(a, "close"))):
        return empty_result("Three Inside Down", "bearish")
    if not (is_bear(c) and _val(c, "close") < _val(a, "open")):
        return empty_result("Three Inside Down", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Three Inside Down", "bearish")
    return make_result(
        "Three Inside Down",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.66,
        description="Bearish harami confirmed by a third bar closing below the prior bull's open — reversal confirmed.",
    )


def detect_three_outside_up(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Three Outside Up", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    # Bar 1+2 = bullish engulfing
    if not (is_bear(a) and is_bull(b)
            and _val(b, "open") <= _val(a, "close")
            and _val(b, "close") >= _val(a, "open")
            and abs_body(b) > abs_body(a)):
        return empty_result("Three Outside Up", "bullish")
    if not (is_bull(c) and _val(c, "close") > _val(b, "close")):
        return empty_result("Three Outside Up", "bullish")
    if _prior_trend(df, i - 2) != "downtrend":
        return empty_result("Three Outside Up", "bullish")
    return make_result(
        "Three Outside Up",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=0.70,
        description="Bullish engulfing followed by a higher close — engulfing pattern receives third-bar confirmation.",
    )


def detect_three_outside_down(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Three Outside Down", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bull(a) and is_bear(b)
            and _val(b, "open") >= _val(a, "close")
            and _val(b, "close") <= _val(a, "open")
            and abs_body(b) > abs_body(a)):
        return empty_result("Three Outside Down", "bearish")
    if not (is_bear(c) and _val(c, "close") < _val(b, "close")):
        return empty_result("Three Outside Down", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Three Outside Down", "bearish")
    return make_result(
        "Three Outside Down",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.69,
        description="Bearish engulfing followed by a lower close — engulfing pattern receives third-bar confirmation.",
    )


# ─── Abandoned Baby ─────────────────────────────────────────────────────────

def detect_bullish_abandoned_baby(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bullish Abandoned Baby", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bear(a) and is_doji(b) and is_bull(c)):
        return empty_result("Bullish Abandoned Baby", "bullish")
    if not gap_down(a, b):
        return empty_result("Bullish Abandoned Baby", "bullish")
    if not gap_up(b, c):
        return empty_result("Bullish Abandoned Baby", "bullish")
    if _prior_trend(df, i - 2) != "downtrend":
        return empty_result("Bullish Abandoned Baby", "bullish")
    return make_result(
        "Bullish Abandoned Baby",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=0.78,
        description="Doji isolated by gaps on both sides at a low — extremely rare; very strong reversal signal.",
    )


def detect_bearish_abandoned_baby(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bearish Abandoned Baby", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bull(a) and is_doji(b) and is_bear(c)):
        return empty_result("Bearish Abandoned Baby", "bearish")
    if not gap_up(a, b):
        return empty_result("Bearish Abandoned Baby", "bearish")
    if not gap_down(b, c):
        return empty_result("Bearish Abandoned Baby", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Bearish Abandoned Baby", "bearish")
    return make_result(
        "Bearish Abandoned Baby",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.76,
        description="Doji isolated by gaps on both sides at a high — extremely rare; very strong reversal signal.",
    )


# ─── Advance Block / Deliberation (top reversal: weakening 3 bulls) ────────

def detect_advance_block(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Advance Block", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bull(a) and is_bull(b) and is_bull(c)):
        return empty_result("Advance Block", "bearish")
    if not (_val(c, "close") > _val(b, "close") > _val(a, "close")):
        return empty_result("Advance Block", "bearish")
    # Bodies SHRINK and upper shadows GROW.
    if not (abs_body(b) < abs_body(a) and abs_body(c) < abs_body(b)):
        return empty_result("Advance Block", "bearish")
    if not (upper_shadow(c) > upper_shadow(a) and upper_shadow(c) > 0.4 * abs_body(c)):
        return empty_result("Advance Block", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Advance Block", "bearish")
    return make_result(
        "Advance Block",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.62,
        description="Three rising bull bars with shrinking bodies and growing upper wicks — buying is losing steam.",
    )


def detect_deliberation(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Deliberation", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bull(a) and is_bull(b) and is_bull(c)):
        return empty_result("Deliberation", "bearish")
    if not (_val(b, "close") > _val(a, "close")):
        return empty_result("Deliberation", "bearish")
    # 3rd bar small (≤40% of bar 2 body) opening near/above prev close.
    if abs_body(c) > 0.4 * abs_body(b):
        return empty_result("Deliberation", "bearish")
    if _val(c, "open") < _val(b, "close"):
        return empty_result("Deliberation", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Deliberation", "bearish")
    return make_result(
        "Deliberation",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.58,
        description="Two large bulls then a small one near/above the second close — trend is stalling.",
    )


# ─── Stick Sandwich ─────────────────────────────────────────────────────────

def detect_stick_sandwich(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Stick Sandwich", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bear(a) and is_bull(b) and is_bear(c)):
        return empty_result("Stick Sandwich", "bullish")
    diff = abs(_val(a, "close") - _val(c, "close"))
    if diff > 0.0015 * _val(a, "close"):
        return empty_result("Stick Sandwich", "bullish")
    # Middle bar must close above both outer bars' closes.
    if _val(b, "close") <= max(_val(a, "close"), _val(c, "close")):
        return empty_result("Stick Sandwich", "bullish")
    if _prior_trend(df, i - 2) != "downtrend":
        return empty_result("Stick Sandwich", "bullish")
    return make_result(
        "Stick Sandwich",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=0.58,
        description="Two bear bars sandwich a bull bar that closed higher, with matching outer closes — bottom holding.",
    )


# ─── Ladder Bottom / Top ────────────────────────────────────────────────────

def detect_ladder_bottom(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 5:
        return empty_result("Ladder Bottom", "bullish")
    bars = [df.iloc[i - 4 + k] for k in range(5)]
    a, b, c, d, e = bars
    if not (is_bear(a) and is_bear(b) and is_bear(c)):
        return empty_result("Ladder Bottom", "bullish")
    if not (_val(c, "close") < _val(b, "close") < _val(a, "close")):
        return empty_result("Ladder Bottom", "bullish")
    # 4th bar: small bear with upper shadow (bears are tiring).
    if not (is_bear(d) and upper_shadow(d) > abs_body(d)):
        return empty_result("Ladder Bottom", "bullish")
    # 5th bar: bull that opens above d.close.
    if not (is_bull(e) and _val(e, "open") > _val(d, "close")):
        return empty_result("Ladder Bottom", "bullish")
    if _prior_trend(df, i - 4) != "downtrend":
        return empty_result("Ladder Bottom", "bullish")
    return make_result(
        "Ladder Bottom",
        direction="bullish",
        indices=[i - 4, i - 3, i - 2, i - 1, i],
        strength=0.62,
        description="Three falling bears, then a bear with upper wick, then a bull gap up — bottoming sequence completes.",
    )


def detect_ladder_top(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 5:
        return empty_result("Ladder Top", "bearish")
    bars = [df.iloc[i - 4 + k] for k in range(5)]
    a, b, c, d, e = bars
    if not (is_bull(a) and is_bull(b) and is_bull(c)):
        return empty_result("Ladder Top", "bearish")
    if not (_val(c, "close") > _val(b, "close") > _val(a, "close")):
        return empty_result("Ladder Top", "bearish")
    if not (is_bull(d) and lower_shadow(d) > abs_body(d)):
        return empty_result("Ladder Top", "bearish")
    if not (is_bear(e) and _val(e, "open") < _val(d, "close")):
        return empty_result("Ladder Top", "bearish")
    if _prior_trend(df, i - 4) != "uptrend":
        return empty_result("Ladder Top", "bearish")
    return make_result(
        "Ladder Top",
        direction="bearish",
        indices=[i - 4, i - 3, i - 2, i - 1, i],
        strength=0.60,
        description="Three rising bulls, then a bull with lower wick, then a bear gap down — topping sequence completes.",
    )


# ─── Unique Three River Bottom ──────────────────────────────────────────────

def detect_unique_three_river_bottom(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Unique Three River Bottom", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    # Bar 1: long bear
    if not (is_bear(a) and abs_body(a) > 0.5 * candle_range(a)):
        return empty_result("Unique Three River Bottom", "bullish")
    # Bar 2: bear with new low, but closes above bar1 close
    if not (is_bear(b) and _val(b, "low") < _val(a, "low") and _val(b, "close") >= _val(a, "close")):
        return empty_result("Unique Three River Bottom", "bullish")
    # Bar 3: small bull below bar 2 close
    if not (is_bull(c) and abs_body(c) < 0.4 * abs_body(a) and _val(c, "close") < _val(b, "close")):
        return empty_result("Unique Three River Bottom", "bullish")
    if _prior_trend(df, i - 2) != "downtrend":
        return empty_result("Unique Three River Bottom", "bullish")
    return make_result(
        "Unique Three River Bottom",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=0.60,
        description="Two bears, with the second printing a new low but closing higher, then a small bull — selling exhausted.",
    )


# ─── Two Crows / Upside Gap Two Crows ───────────────────────────────────────

def detect_two_crows(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Two Crows", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    # Bar 1 large bull, bar 2 bear that gaps up (open above bar1 high), bar 3 bear that closes inside bar 1.
    if not (is_bull(a) and abs_body(a) > 0.5 * candle_range(a)):
        return empty_result("Two Crows", "bearish")
    if not (is_bear(b) and _val(b, "open") > _val(a, "high")):
        return empty_result("Two Crows", "bearish")
    if not (is_bear(c) and _val(c, "open") > _val(b, "close") and _val(c, "open") < _val(b, "open")):
        return empty_result("Two Crows", "bearish")
    if not (_val(c, "close") < _val(a, "close") and _val(c, "close") > _val(a, "open")):
        return empty_result("Two Crows", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Two Crows", "bearish")
    return make_result(
        "Two Crows",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.60,
        description="Bull bar then two bears, the second closing inside the bull — uptrend losing grip.",
    )


def detect_upside_gap_two_crows(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Upside Gap Two Crows", "bearish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    # Bar 1 long bull; bar 2 small bear that gaps above bar 1; bar 3 bear that engulfs bar 2 but closes above bar 1 high.
    if not (is_bull(a) and abs_body(a) > 0.5 * candle_range(a)):
        return empty_result("Upside Gap Two Crows", "bearish")
    if not (is_bear(b) and _val(b, "low") > _val(a, "high")):
        return empty_result("Upside Gap Two Crows", "bearish")
    if not (is_bear(c) and _val(c, "open") > _val(b, "open") and _val(c, "close") < _val(b, "close")):
        return empty_result("Upside Gap Two Crows", "bearish")
    if _val(c, "close") <= _val(a, "high"):
        return empty_result("Upside Gap Two Crows", "bearish")
    if _prior_trend(df, i - 2) != "uptrend":
        return empty_result("Upside Gap Two Crows", "bearish")
    return make_result(
        "Upside Gap Two Crows",
        direction="bearish",
        indices=[i - 2, i - 1, i],
        strength=0.58,
        description="Long bull then two bears that gap above it — sellers regaining control above the bull's range.",
    )


# ─── Mat Hold (continuation) ────────────────────────────────────────────────

def detect_bullish_mat_hold(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 5:
        return empty_result("Bullish Mat Hold", "continuation")
    a, b, c, d, e = [df.iloc[i - 4 + k] for k in range(5)]
    if not is_bull(a) or abs_body(a) < 0.5 * candle_range(a):
        return empty_result("Bullish Mat Hold", "continuation")
    # Bars 2-4: small bars trending down but staying above a.low
    for r in (b, c, d):
        if _val(r, "low") < _val(a, "low"):
            return empty_result("Bullish Mat Hold", "continuation")
        if abs_body(r) > abs_body(a):
            return empty_result("Bullish Mat Hold", "continuation")
    # Bar 5: long bull closing above bar 4 high (and ideally above bar 1 close)
    if not (is_bull(e) and _val(e, "close") > _val(d, "high")):
        return empty_result("Bullish Mat Hold", "continuation")
    if _prior_trend(df, i - 4) != "uptrend":
        return empty_result("Bullish Mat Hold", "continuation")
    return make_result(
        "Bullish Mat Hold",
        direction="continuation",
        indices=[i - 4, i - 3, i - 2, i - 1, i],
        strength=0.72,
        description="Big bull, brief 3-bar pullback inside its range, then a strong bull breakout — high-probability continuation.",
    )


def detect_bearish_mat_hold(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 5:
        return empty_result("Bearish Mat Hold", "continuation")
    a, b, c, d, e = [df.iloc[i - 4 + k] for k in range(5)]
    if not is_bear(a) or abs_body(a) < 0.5 * candle_range(a):
        return empty_result("Bearish Mat Hold", "continuation")
    for r in (b, c, d):
        if _val(r, "high") > _val(a, "high"):
            return empty_result("Bearish Mat Hold", "continuation")
        if abs_body(r) > abs_body(a):
            return empty_result("Bearish Mat Hold", "continuation")
    if not (is_bear(e) and _val(e, "close") < _val(d, "low")):
        return empty_result("Bearish Mat Hold", "continuation")
    if _prior_trend(df, i - 4) != "downtrend":
        return empty_result("Bearish Mat Hold", "continuation")
    return make_result(
        "Bearish Mat Hold",
        direction="continuation",
        indices=[i - 4, i - 3, i - 2, i - 1, i],
        strength=0.70,
        description="Big bear, brief 3-bar rally inside its range, then a strong bear breakdown — high-probability continuation.",
    )


THREE_CANDLE_DETECTORS = [
    detect_morning_star,
    detect_evening_star,
    detect_morning_doji_star,
    detect_evening_doji_star,
    detect_three_white_soldiers,
    detect_three_black_crows,
    detect_three_inside_up,
    detect_three_inside_down,
    detect_three_outside_up,
    detect_three_outside_down,
    detect_bullish_abandoned_baby,
    detect_bearish_abandoned_baby,
    detect_advance_block,
    detect_deliberation,
    detect_stick_sandwich,
    detect_ladder_bottom,
    detect_ladder_top,
    detect_unique_three_river_bottom,
    detect_two_crows,
    detect_upside_gap_two_crows,
    detect_bullish_mat_hold,
    detect_bearish_mat_hold,
]
