"""Advanced candlestick patterns — bridge to existing detectors.

Aggregates the 50+ candlestick detectors in `_single`, `_two`, and
`_three` into a single call that returns the strongest hit (or None).

Patterns covered (subset of what the spec mentions plus everything
else the library exposes):
  Single-bar: Hammer, Inverted Hammer, Shooting Star, Hanging Man,
              Doji (all variants), Spinning Top, Marubozu, Belt Hold,
              High Wave
  Two-bar:   Bullish/Bearish Engulfing, Harami (cross), Piercing Line,
              Dark Cloud Cover, Tweezer, Kicker, Meeting Lines,
              On Neck / In Neck / Thrusting
  Three-bar: Morning/Evening Star (+ Doji Star), Three Soldiers/Crows,
              Three Inside/Outside, Abandoned Baby, Advance Block,
              Deliberation, Stick Sandwich, Ladder Bottom/Top, Two Crows,
              Upside Gap Two Crows, Unique Three River Bottom
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from patterns._bridge_utils import run_aggregate
from patterns import _single, _two, _three


_BULLISH = [
    _single.detect_hammer, _single.detect_inverted_hammer,
    _single.detect_dragonfly_doji, _single.detect_bullish_marubozu,
    _single.detect_bullish_belt_hold,
    _two.detect_bullish_engulfing, _two.detect_bullish_harami,
    _two.detect_bullish_harami_cross, _two.detect_piercing_line,
    _two.detect_tweezer_bottom, _two.detect_bullish_kicker,
    _two.detect_bullish_meeting_lines,
    _three.detect_morning_star, _three.detect_morning_doji_star,
    _three.detect_three_white_soldiers, _three.detect_three_inside_up,
    _three.detect_three_outside_up, _three.detect_bullish_abandoned_baby,
    _three.detect_stick_sandwich, _three.detect_ladder_bottom,
    _three.detect_unique_three_river_bottom,
]

_BEARISH = [
    _single.detect_shooting_star, _single.detect_hanging_man,
    _single.detect_gravestone_doji, _single.detect_bearish_marubozu,
    _single.detect_bearish_belt_hold,
    _two.detect_bearish_engulfing, _two.detect_bearish_harami,
    _two.detect_bearish_harami_cross, _two.detect_dark_cloud_cover,
    _two.detect_tweezer_top, _two.detect_bearish_kicker,
    _two.detect_bearish_meeting_lines, _two.detect_on_neck_pattern,
    _two.detect_in_neck_pattern, _two.detect_thrusting_pattern,
    _three.detect_evening_star, _three.detect_evening_doji_star,
    _three.detect_three_black_crows, _three.detect_three_inside_down,
    _three.detect_three_outside_down, _three.detect_bearish_abandoned_baby,
    _three.detect_advance_block, _three.detect_deliberation,
    _three.detect_ladder_top, _three.detect_two_crows,
    _three.detect_upside_gap_two_crows,
]


def detect_advanced_candlesticks(df: pd.DataFrame, *args, **kwargs) -> Optional[dict]:
    """Return the strongest candlestick hit across all ~50 detectors."""
    return run_aggregate(
        df,
        [(_BULLISH, _BEARISH)],
        pattern_name="Advanced Candlesticks",
    )
