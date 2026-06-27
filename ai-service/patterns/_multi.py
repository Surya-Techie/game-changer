"""Multi-candle complex pattern detectors (4–10 bars).

These detectors operate on a sliding window of up to ~10 bars and are
specifically the higher-bar Japanese reversal/continuation patterns.
Western chart patterns (flags, triangles, H&S, channels) live in `_western.py`
and have their own measured-move logic.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from ._helpers import (
    PatternResult,
    abs_body,
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
from ._single import _prior_trend, _idx


# ─── Rising / Falling Three Methods (continuation) ──────────────────────────

def detect_rising_three_methods(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 5:
        return empty_result("Rising Three Methods", "continuation")
    a, b, c, d, e = [df.iloc[i - 4 + k] for k in range(5)]
    if not is_bull(a) or abs_body(a) < 0.5 * candle_range(a):
        return empty_result("Rising Three Methods", "continuation")
    a_lo = min(_val(a, "open"), _val(a, "close"))
    a_hi = max(_val(a, "open"), _val(a, "close"))
    # Middle 3 bars: small bears (or any small bars) staying inside bar 1 body
    for r in (b, c, d):
        if _val(r, "high") > a_hi or _val(r, "low") < a_lo:
            return empty_result("Rising Three Methods", "continuation")
        if abs_body(r) > abs_body(a) * 0.6:
            return empty_result("Rising Three Methods", "continuation")
    # 3 of those bars should net downward (the pause)
    if not (_val(d, "close") < _val(b, "close") or _val(d, "close") < _val(a, "close")):
        return empty_result("Rising Three Methods", "continuation")
    # Bar 5: long bull closing above bar 1 close
    if not (is_bull(e) and _val(e, "close") > _val(a, "close") and abs_body(e) > 0.5 * candle_range(e)):
        return empty_result("Rising Three Methods", "continuation")
    if _prior_trend(df, i - 4) != "uptrend":
        return empty_result("Rising Three Methods", "continuation")
    return make_result(
        "Rising Three Methods",
        direction="continuation",
        indices=[i - 4, i - 3, i - 2, i - 1, i],
        strength=0.72,
        description="Long bull, 3-bar bearish pause inside its range, then another long bull — uptrend resumes after rest.",
    )


def detect_falling_three_methods(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 5:
        return empty_result("Falling Three Methods", "continuation")
    a, b, c, d, e = [df.iloc[i - 4 + k] for k in range(5)]
    if not is_bear(a) or abs_body(a) < 0.5 * candle_range(a):
        return empty_result("Falling Three Methods", "continuation")
    a_lo = min(_val(a, "open"), _val(a, "close"))
    a_hi = max(_val(a, "open"), _val(a, "close"))
    for r in (b, c, d):
        if _val(r, "high") > a_hi or _val(r, "low") < a_lo:
            return empty_result("Falling Three Methods", "continuation")
        if abs_body(r) > abs_body(a) * 0.6:
            return empty_result("Falling Three Methods", "continuation")
    if not (_val(d, "close") > _val(b, "close") or _val(d, "close") > _val(a, "close")):
        return empty_result("Falling Three Methods", "continuation")
    if not (is_bear(e) and _val(e, "close") < _val(a, "close") and abs_body(e) > 0.5 * candle_range(e)):
        return empty_result("Falling Three Methods", "continuation")
    if _prior_trend(df, i - 4) != "downtrend":
        return empty_result("Falling Three Methods", "continuation")
    return make_result(
        "Falling Three Methods",
        direction="continuation",
        indices=[i - 4, i - 3, i - 2, i - 1, i],
        strength=0.70,
        description="Long bear, 3-bar bullish pause inside its range, then another long bear — downtrend resumes after rest.",
    )


# ─── Three Stars in the South ──────────────────────────────────────────────

def detect_three_stars_in_the_south(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    """Bullish reversal: three bears with shrinking bodies and rising lows."""
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result("Three Stars in the South", "bullish")
    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    if not (is_bear(a) and is_bear(b) and is_bear(c)):
        return empty_result("Three Stars in the South", "bullish")
    # Bar 1: long bear with long lower wick.
    if not (abs_body(a) > 0.4 * candle_range(a) and lower_shadow(a) > 0.3 * candle_range(a)):
        return empty_result("Three Stars in the South", "bullish")
    # Bar 2: similar to bar 1 but smaller body, with low above bar 1 low.
    if not (abs_body(b) < abs_body(a) and _val(b, "low") > _val(a, "low") and lower_shadow(b) > 0.3 * candle_range(b)):
        return empty_result("Three Stars in the South", "bullish")
    # Bar 3: small marubozu-like bear inside bar 2 range, no wicks.
    if not (abs_body(c) < abs_body(b) and lower_shadow(c) < 0.15 * candle_range(c) and upper_shadow(c) < 0.15 * candle_range(c)):
        return empty_result("Three Stars in the South", "bullish")
    if not (_val(c, "high") < _val(b, "high") and _val(c, "low") > _val(b, "low")):
        return empty_result("Three Stars in the South", "bullish")
    if _prior_trend(df, i - 2) != "downtrend":
        return empty_result("Three Stars in the South", "bullish")
    return make_result(
        "Three Stars in the South",
        direction="bullish",
        indices=[i - 2, i - 1, i],
        strength=0.60,
        description="Three sequentially smaller bears with rising lows — selling pressure draining; reversal imminent.",
    )


# ─── Concealing Baby Swallow (rare 4-bar bullish reversal) ─────────────────

def detect_concealing_baby_swallow(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 4:
        return empty_result("Concealing Baby Swallow", "bullish")
    a, b, c, d = df.iloc[i - 3], df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    # Bars 1+2: two black marubozu (long bear with no wicks)
    for r in (a, b):
        if not is_bear(r) or abs_body(r) < 0.85 * candle_range(r):
            return empty_result("Concealing Baby Swallow", "bullish")
    # Bar 3: bear that gaps down and has an upper shadow into bar 2 body
    if not (is_bear(c) and _val(c, "open") < _val(b, "close") and _val(c, "high") > _val(b, "close")):
        return empty_result("Concealing Baby Swallow", "bullish")
    # Bar 4: long bear that completely engulfs bar 3 (open above c.high, close below c.low)
    if not (is_bear(d) and _val(d, "open") > _val(c, "high") and _val(d, "close") < _val(c, "low")):
        return empty_result("Concealing Baby Swallow", "bullish")
    if _prior_trend(df, i - 3) != "downtrend":
        return empty_result("Concealing Baby Swallow", "bullish")
    return make_result(
        "Concealing Baby Swallow",
        direction="bullish",
        indices=[i - 3, i - 2, i - 1, i],
        strength=0.62,
        description="Rare 4-bar pattern: two marubozu bears, a gap-down bear with rally into prior body, then an engulfing bear — selling climax.",
    )


# ─── Breakaway (5-bar exhaustion → reversal) ───────────────────────────────

def detect_bullish_breakaway(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 5:
        return empty_result("Bullish Breakaway", "bullish")
    a, b, c, d, e = [df.iloc[i - 4 + k] for k in range(5)]
    # Bar 1: long bear; bar 2: bear gapping down; bars 3-4: continuing lower bears; bar 5: long bull closing inside the gap.
    if not is_bear(a) or abs_body(a) < 0.5 * candle_range(a):
        return empty_result("Bullish Breakaway", "bullish")
    if not (is_bear(b) and _val(b, "high") < _val(a, "low")):
        return empty_result("Bullish Breakaway", "bullish")
    if not (_val(c, "close") < _val(b, "close") and _val(d, "close") < _val(c, "close")):
        return empty_result("Bullish Breakaway", "bullish")
    if not (is_bull(e) and abs_body(e) > 0.5 * candle_range(e)):
        return empty_result("Bullish Breakaway", "bullish")
    # Bar 5 close lands inside the gap between bar 1 and bar 2.
    if not (_val(a, "low") > _val(e, "close") > _val(b, "high")):
        return empty_result("Bullish Breakaway", "bullish")
    if _prior_trend(df, i - 4) != "downtrend":
        return empty_result("Bullish Breakaway", "bullish")
    return make_result(
        "Bullish Breakaway",
        direction="bullish",
        indices=[i - 4, i - 3, i - 2, i - 1, i],
        strength=0.62,
        description="Bear gap then continued selling, capped by a long bull that closes back inside the original gap — capitulation reversal.",
    )


def detect_bearish_breakaway(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 5:
        return empty_result("Bearish Breakaway", "bearish")
    a, b, c, d, e = [df.iloc[i - 4 + k] for k in range(5)]
    if not is_bull(a) or abs_body(a) < 0.5 * candle_range(a):
        return empty_result("Bearish Breakaway", "bearish")
    if not (is_bull(b) and _val(b, "low") > _val(a, "high")):
        return empty_result("Bearish Breakaway", "bearish")
    if not (_val(c, "close") > _val(b, "close") and _val(d, "close") > _val(c, "close")):
        return empty_result("Bearish Breakaway", "bearish")
    if not (is_bear(e) and abs_body(e) > 0.5 * candle_range(e)):
        return empty_result("Bearish Breakaway", "bearish")
    if not (_val(a, "high") < _val(e, "close") < _val(b, "low")):
        return empty_result("Bearish Breakaway", "bearish")
    if _prior_trend(df, i - 4) != "uptrend":
        return empty_result("Bearish Breakaway", "bearish")
    return make_result(
        "Bearish Breakaway",
        direction="bearish",
        indices=[i - 4, i - 3, i - 2, i - 1, i],
        strength=0.60,
        description="Bull gap then continued buying, capped by a long bear that closes back inside the original gap — euphoria reversal.",
    )


# ─── Eight New Price Lines (Sakata 8-bar exhaustion) ───────────────────────

def detect_bullish_eight_new_price_lines(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    """Eight consecutive higher highs — exhaustion warning even though direction
    'so far' is bullish. We label it `bearish` because Sakata calls for taking
    profits / expecting reversal."""
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 8:
        return empty_result("Bullish Eight New Price Lines", "bearish")
    highs = [_val(df.iloc[i - 7 + k], "high") for k in range(8)]
    for k in range(1, 8):
        if highs[k] <= highs[k - 1]:
            return empty_result("Bullish Eight New Price Lines", "bearish")
    if _prior_trend(df, i - 7) != "uptrend":
        return empty_result("Bullish Eight New Price Lines", "bearish")
    return make_result(
        "Bullish Eight New Price Lines",
        direction="bearish",
        indices=list(range(i - 7, i + 1)),
        strength=0.55,
        description="Eight consecutive higher highs — overextension warning; profit-taking / mean reversion historically follows.",
    )


def detect_bearish_eight_new_price_lines(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 8:
        return empty_result("Bearish Eight New Price Lines", "bullish")
    lows = [_val(df.iloc[i - 7 + k], "low") for k in range(8)]
    for k in range(1, 8):
        if lows[k] >= lows[k - 1]:
            return empty_result("Bearish Eight New Price Lines", "bullish")
    if _prior_trend(df, i - 7) != "downtrend":
        return empty_result("Bearish Eight New Price Lines", "bullish")
    return make_result(
        "Bearish Eight New Price Lines",
        direction="bullish",
        indices=list(range(i - 7, i + 1)),
        strength=0.55,
        description="Eight consecutive lower lows — overextension warning; bounce / mean reversion historically follows.",
    )


MULTI_CANDLE_DETECTORS = [
    detect_rising_three_methods,
    detect_falling_three_methods,
    detect_three_stars_in_the_south,
    detect_concealing_baby_swallow,
    detect_bullish_breakaway,
    detect_bearish_breakaway,
    detect_bullish_eight_new_price_lines,
    detect_bearish_eight_new_price_lines,
]
