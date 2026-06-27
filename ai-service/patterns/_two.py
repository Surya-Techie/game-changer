"""Two-candle pattern detectors.

Operate on the last two candles (prev, curr). Most are reversal patterns
that require prior trend context — without trend they're treated as
neutral failures so the upstream confidence engine doesn't double-count
random two-bar coincidences.
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


# ─── Engulfing ──────────────────────────────────────────────────────────────

def detect_bullish_engulfing(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bullish Engulfing", "bullish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bear(prev) and is_bull(curr)):
        return empty_result("Bullish Engulfing", "bullish")
    if not (_val(curr, "open") <= _val(prev, "close") and _val(curr, "close") >= _val(prev, "open")):
        return empty_result("Bullish Engulfing", "bullish")
    if abs_body(curr) < 1.10 * max(abs_body(prev), 1e-9):
        return empty_result("Bullish Engulfing", "bullish")
    if _prior_trend(df, i) == "uptrend":
        return empty_result("Bullish Engulfing", "bullish")
    ratio = abs_body(curr) / max(abs_body(prev), 1e-9)
    strength = min(1.0, 0.55 + 0.15 * (min(ratio, 3.0) - 1.0) / 2.0)
    return make_result(
        "Bullish Engulfing",
        direction="bullish",
        indices=[i - 1, i],
        strength=strength,
        description=(
            "Large bullish body fully engulfs the prior bearish body — buyers overwhelmed "
            "yesterday's sellers and seized control of the range."
        ),
    )


def detect_bearish_engulfing(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bearish Engulfing", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bull(prev) and is_bear(curr)):
        return empty_result("Bearish Engulfing", "bearish")
    if not (_val(curr, "open") >= _val(prev, "close") and _val(curr, "close") <= _val(prev, "open")):
        return empty_result("Bearish Engulfing", "bearish")
    if abs_body(curr) < 1.10 * max(abs_body(prev), 1e-9):
        return empty_result("Bearish Engulfing", "bearish")
    if _prior_trend(df, i) == "downtrend":
        return empty_result("Bearish Engulfing", "bearish")
    ratio = abs_body(curr) / max(abs_body(prev), 1e-9)
    strength = min(1.0, 0.55 + 0.15 * (min(ratio, 3.0) - 1.0) / 2.0)
    return make_result(
        "Bearish Engulfing",
        direction="bearish",
        indices=[i - 1, i],
        strength=strength,
        description=(
            "Large bearish body fully engulfs the prior bullish body — sellers overwhelmed "
            "yesterday's buyers and seized control of the range."
        ),
    )


# ─── Harami (inside body within prior body) ─────────────────────────────────

def _is_inside_body(prev, curr) -> bool:
    prev_hi = max(_val(prev, "open"), _val(prev, "close"))
    prev_lo = min(_val(prev, "open"), _val(prev, "close"))
    curr_hi = max(_val(curr, "open"), _val(curr, "close"))
    curr_lo = min(_val(curr, "open"), _val(curr, "close"))
    return curr_hi <= prev_hi and curr_lo >= prev_lo


def detect_bullish_harami(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bullish Harami", "bullish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bear(prev) and is_bull(curr) and _is_inside_body(prev, curr)):
        return empty_result("Bullish Harami", "bullish")
    if abs_body(curr) > 0.6 * abs_body(prev):
        return empty_result("Bullish Harami", "bullish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("Bullish Harami", "bullish")
    contraction = 1 - abs_body(curr) / max(abs_body(prev), 1e-9)
    strength = 0.45 + 0.20 * contraction
    return make_result(
        "Bullish Harami",
        direction="bullish",
        indices=[i - 1, i],
        strength=strength,
        description="Small bull body contained inside the prior large bear body — selling pressure has paused.",
    )


def detect_bearish_harami(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bearish Harami", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bull(prev) and is_bear(curr) and _is_inside_body(prev, curr)):
        return empty_result("Bearish Harami", "bearish")
    if abs_body(curr) > 0.6 * abs_body(prev):
        return empty_result("Bearish Harami", "bearish")
    if _prior_trend(df, i) != "uptrend":
        return empty_result("Bearish Harami", "bearish")
    contraction = 1 - abs_body(curr) / max(abs_body(prev), 1e-9)
    strength = 0.45 + 0.20 * contraction
    return make_result(
        "Bearish Harami",
        direction="bearish",
        indices=[i - 1, i],
        strength=strength,
        description="Small bear body contained inside the prior large bull body — buying pressure has paused.",
    )


def detect_bullish_harami_cross(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bullish Harami Cross", "bullish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bear(prev) and is_doji(curr) and _is_inside_body(prev, curr)):
        return empty_result("Bullish Harami Cross", "bullish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("Bullish Harami Cross", "bullish")
    strength = 0.55 + 0.20 * (1 - candle_range(curr) / max(candle_range(prev), 1e-9))
    return make_result(
        "Bullish Harami Cross",
        direction="bullish",
        indices=[i - 1, i],
        strength=strength,
        description="Inside-bar doji after a large bear candle — extreme contraction; reversal often follows.",
    )


def detect_bearish_harami_cross(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bearish Harami Cross", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bull(prev) and is_doji(curr) and _is_inside_body(prev, curr)):
        return empty_result("Bearish Harami Cross", "bearish")
    if _prior_trend(df, i) != "uptrend":
        return empty_result("Bearish Harami Cross", "bearish")
    strength = 0.55 + 0.20 * (1 - candle_range(curr) / max(candle_range(prev), 1e-9))
    return make_result(
        "Bearish Harami Cross",
        direction="bearish",
        indices=[i - 1, i],
        strength=strength,
        description="Inside-bar doji after a large bull candle — extreme contraction; reversal often follows.",
    )


# ─── Piercing line / Dark cloud ─────────────────────────────────────────────

def detect_piercing_line(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Piercing Line", "bullish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bear(prev) and is_bull(curr)):
        return empty_result("Piercing Line", "bullish")
    if _val(curr, "open") >= _val(prev, "low"):  # must gap down on open
        return empty_result("Piercing Line", "bullish")
    midpoint = (_val(prev, "open") + _val(prev, "close")) / 2
    if _val(curr, "close") <= midpoint or _val(curr, "close") >= _val(prev, "open"):
        return empty_result("Piercing Line", "bullish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("Piercing Line", "bullish")
    penetration = (_val(curr, "close") - _val(prev, "close")) / max(abs_body(prev), 1e-9)
    strength = 0.55 + 0.25 * min(penetration, 1.0)
    return make_result(
        "Piercing Line",
        direction="bullish",
        indices=[i - 1, i],
        strength=strength,
        description="Bear bar followed by a bull bar that opens below the prior low and closes above the midpoint of the prior body.",
    )


def detect_dark_cloud_cover(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Dark Cloud Cover", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bull(prev) and is_bear(curr)):
        return empty_result("Dark Cloud Cover", "bearish")
    if _val(curr, "open") <= _val(prev, "high"):  # must gap up on open
        return empty_result("Dark Cloud Cover", "bearish")
    midpoint = (_val(prev, "open") + _val(prev, "close")) / 2
    if _val(curr, "close") >= midpoint or _val(curr, "close") <= _val(prev, "open"):
        return empty_result("Dark Cloud Cover", "bearish")
    if _prior_trend(df, i) != "uptrend":
        return empty_result("Dark Cloud Cover", "bearish")
    penetration = (_val(prev, "close") - _val(curr, "close")) / max(abs_body(prev), 1e-9)
    strength = 0.55 + 0.25 * min(penetration, 1.0)
    return make_result(
        "Dark Cloud Cover",
        direction="bearish",
        indices=[i - 1, i],
        strength=strength,
        description="Bull bar followed by a bear bar that opens above the prior high and closes below the midpoint of the prior body.",
    )


# ─── Tweezers ───────────────────────────────────────────────────────────────

def detect_tweezer_bottom(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Tweezer Bottom", "bullish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not is_bear(prev) or not is_bull(curr):
        return empty_result("Tweezer Bottom", "bullish")
    low_diff = abs(_val(prev, "low") - _val(curr, "low"))
    avg_price = (_val(prev, "low") + _val(curr, "low")) / 2
    if avg_price <= 0 or (low_diff / avg_price) > 0.0015:  # ≤ 0.15% apart
        return empty_result("Tweezer Bottom", "bullish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("Tweezer Bottom", "bullish")
    match = 1.0 - (low_diff / max(avg_price, 1e-9)) / 0.0015
    strength = 0.55 + 0.20 * match
    return make_result(
        "Tweezer Bottom",
        direction="bullish",
        indices=[i - 1, i],
        strength=strength,
        description="Two consecutive bars with matching lows after a downtrend — clear support rejection.",
    )


def detect_tweezer_top(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Tweezer Top", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not is_bull(prev) or not is_bear(curr):
        return empty_result("Tweezer Top", "bearish")
    high_diff = abs(_val(prev, "high") - _val(curr, "high"))
    avg_price = (_val(prev, "high") + _val(curr, "high")) / 2
    if avg_price <= 0 or (high_diff / avg_price) > 0.0015:
        return empty_result("Tweezer Top", "bearish")
    if _prior_trend(df, i) != "uptrend":
        return empty_result("Tweezer Top", "bearish")
    match = 1.0 - (high_diff / max(avg_price, 1e-9)) / 0.0015
    strength = 0.55 + 0.20 * match
    return make_result(
        "Tweezer Top",
        direction="bearish",
        indices=[i - 1, i],
        strength=strength,
        description="Two consecutive bars with matching highs after an uptrend — clear resistance rejection.",
    )


# ─── Neck / Thrusting (bear-continuation family) ───────────────────────────

def _bear_continuation_geometry(prev, curr) -> tuple[bool, float]:
    """Common rule: bear `prev`, bull `curr` that opens below prev.low and
    closes back into prev body but not past midpoint. Returns (qualifies, close_pos)."""
    if not (is_bear(prev) and is_bull(curr)):
        return False, 0.0
    if _val(curr, "open") >= _val(prev, "low"):
        return False, 0.0
    body_lo = min(_val(prev, "open"), _val(prev, "close"))
    body_hi = max(_val(prev, "open"), _val(prev, "close"))
    rng = max(body_hi - body_lo, 1e-9)
    pos = (_val(curr, "close") - body_lo) / rng  # 0 = bottom of body, 1 = top
    return True, pos


def detect_on_neck_pattern(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("On-Neck Pattern", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    ok, _pos = _bear_continuation_geometry(prev, curr)
    if not ok:
        return empty_result("On-Neck Pattern", "bearish")
    # close near prev low
    diff = abs(_val(curr, "close") - _val(prev, "low"))
    if diff > 0.0015 * _val(prev, "low"):
        return empty_result("On-Neck Pattern", "bearish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("On-Neck Pattern", "bearish")
    return make_result(
        "On-Neck Pattern",
        direction="bearish",
        indices=[i - 1, i],
        strength=0.55,
        description="Bull bar barely recovers to the prior bar's low — bears still in command; downtrend likely resumes.",
    )


def detect_in_neck_pattern(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("In-Neck Pattern", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    ok, pos = _bear_continuation_geometry(prev, curr)
    if not ok:
        return empty_result("In-Neck Pattern", "bearish")
    # close marginally inside body (~lower 10%)
    if pos < 0.0 or pos > 0.15:
        return empty_result("In-Neck Pattern", "bearish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("In-Neck Pattern", "bearish")
    return make_result(
        "In-Neck Pattern",
        direction="bearish",
        indices=[i - 1, i],
        strength=0.55,
        description="Bull bar closes just inside the prior bear body but below its midpoint — weak bounce; bears retain control.",
    )


def detect_thrusting_pattern(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Thrusting Pattern", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    ok, pos = _bear_continuation_geometry(prev, curr)
    if not ok:
        return empty_result("Thrusting Pattern", "bearish")
    # close inside body, below midpoint (0.15..0.49)
    if pos < 0.15 or pos >= 0.50:
        return empty_result("Thrusting Pattern", "bearish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("Thrusting Pattern", "bearish")
    return make_result(
        "Thrusting Pattern",
        direction="bearish",
        indices=[i - 1, i],
        strength=0.55,
        description="Bull bar penetrates the bear body but stops below midpoint — bullish attempt failed.",
    )


# ─── Kickers (gap-driven reversal) ──────────────────────────────────────────

def detect_bullish_kicker(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 1:
        return empty_result("Bullish Kicker", "bullish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bear(prev) and is_bull(curr)):
        return empty_result("Bullish Kicker", "bullish")
    # Curr opens at or above prev open (gap above the prior body), creating a
    # shockingly bullish open.
    if _val(curr, "open") <= _val(prev, "open"):
        return empty_result("Bullish Kicker", "bullish")
    if abs_body(curr) < 0.6 * candle_range(curr):
        return empty_result("Bullish Kicker", "bullish")
    strength = 0.65 + 0.20 * min(abs_body(curr) / max(abs_body(prev), 1e-9), 2.0) / 2.0
    return make_result(
        "Bullish Kicker",
        direction="bullish",
        indices=[i - 1, i],
        strength=min(1.0, strength),
        description="Strong bull bar gaps above the prior bear bar's open — sentiment shock; one of the strongest single-bar reversals.",
    )


def detect_bearish_kicker(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 1:
        return empty_result("Bearish Kicker", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bull(prev) and is_bear(curr)):
        return empty_result("Bearish Kicker", "bearish")
    if _val(curr, "open") >= _val(prev, "open"):
        return empty_result("Bearish Kicker", "bearish")
    if abs_body(curr) < 0.6 * candle_range(curr):
        return empty_result("Bearish Kicker", "bearish")
    strength = 0.65 + 0.20 * min(abs_body(curr) / max(abs_body(prev), 1e-9), 2.0) / 2.0
    return make_result(
        "Bearish Kicker",
        direction="bearish",
        indices=[i - 1, i],
        strength=min(1.0, strength),
        description="Strong bear bar gaps below the prior bull bar's open — sentiment shock; one of the strongest single-bar reversals.",
    )


# ─── Meeting Lines ──────────────────────────────────────────────────────────

def detect_bullish_meeting_lines(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bullish Meeting Lines", "bullish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bear(prev) and is_bull(curr)):
        return empty_result("Bullish Meeting Lines", "bullish")
    # Closes equal (within 0.15%)
    close_diff = abs(_val(prev, "close") - _val(curr, "close"))
    if close_diff > 0.0015 * _val(prev, "close"):
        return empty_result("Bullish Meeting Lines", "bullish")
    if _val(curr, "open") >= _val(prev, "close"):  # curr must open lower
        return empty_result("Bullish Meeting Lines", "bullish")
    if _prior_trend(df, i) != "downtrend":
        return empty_result("Bullish Meeting Lines", "bullish")
    return make_result(
        "Bullish Meeting Lines",
        direction="bullish",
        indices=[i - 1, i],
        strength=0.58,
        description="Bear and bull bars close at the same price after a downtrend — first sign of seller exhaustion.",
    )


def detect_bearish_meeting_lines(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Bearish Meeting Lines", "bearish")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (is_bull(prev) and is_bear(curr)):
        return empty_result("Bearish Meeting Lines", "bearish")
    close_diff = abs(_val(prev, "close") - _val(curr, "close"))
    if close_diff > 0.0015 * _val(prev, "close"):
        return empty_result("Bearish Meeting Lines", "bearish")
    if _val(curr, "open") <= _val(prev, "close"):  # curr must open higher
        return empty_result("Bearish Meeting Lines", "bearish")
    if _prior_trend(df, i) != "uptrend":
        return empty_result("Bearish Meeting Lines", "bearish")
    return make_result(
        "Bearish Meeting Lines",
        direction="bearish",
        indices=[i - 1, i],
        strength=0.58,
        description="Bull and bear bars close at the same price after an uptrend — first sign of buyer exhaustion.",
    )


TWO_CANDLE_DETECTORS = [
    detect_bullish_engulfing,
    detect_bearish_engulfing,
    detect_bullish_harami,
    detect_bearish_harami,
    detect_bullish_harami_cross,
    detect_bearish_harami_cross,
    detect_piercing_line,
    detect_dark_cloud_cover,
    detect_tweezer_bottom,
    detect_tweezer_top,
    detect_on_neck_pattern,
    detect_in_neck_pattern,
    detect_thrusting_pattern,
    detect_bullish_kicker,
    detect_bearish_kicker,
    detect_bullish_meeting_lines,
    detect_bearish_meeting_lines,
]
