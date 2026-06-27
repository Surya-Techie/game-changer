"""Narrow Range / Inside Bar / Outside Bar / WRB — bridge.

Uses `_institutional.detect_nr4`, `detect_nr7`, `detect_inside_bar`,
`detect_outside_bar`, and `detect_*_wide_range_bar`.

NR7-ID (NR7 + Inside Day) is the highest-compression setup — detected
here by requiring both NR7 and Inside Bar to fire on the same bar.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from patterns._bridge_utils import _lower, _shape
from patterns import _institutional as _inst


def detect_narrow_range(df: pd.DataFrame, *args, **kwargs) -> Optional[dict]:
    df_lc = _lower(df)
    if df_lc is None or df_lc.empty:
        return None
    try:
        nr7 = _inst.detect_nr7(df_lc)
    except Exception:
        nr7 = None
    try:
        nr4 = _inst.detect_nr4(df_lc)
    except Exception:
        nr4 = None
    try:
        inside = _inst.detect_inside_bar(df_lc)
    except Exception:
        inside = None
    try:
        wrb_bull = _inst.detect_bullish_wide_range_bar(df_lc)
    except Exception:
        wrb_bull = None
    try:
        wrb_bear = _inst.detect_bearish_wide_range_bar(df_lc)
    except Exception:
        wrb_bear = None

    nr7_id = bool(nr7 and nr7.get("detected") and inside and inside.get("detected"))

    # Decide which event to surface (prefer NR7-ID > NR7 > NR4 > WRB).
    best = None
    label = None
    if nr7_id:
        best, label = nr7, "NR7-ID (Inside Day)"
    elif nr7 and nr7.get("detected"):
        best, label = nr7, "NR7"
    elif nr4 and nr4.get("detected"):
        best, label = nr4, "NR4"
    elif wrb_bull and wrb_bull.get("detected"):
        best, label = wrb_bull, "Wide Range Bar (bullish)"
    elif wrb_bear and wrb_bear.get("detected"):
        best, label = wrb_bear, "Wide Range Bar (bearish)"
    else:
        return None

    # Direction: from underlying or fall back to recent trend.
    raw_dir = (best.get("direction") or "").lower()
    if "bull" in raw_dir:
        direction = "bullish"
    elif "bear" in raw_dir:
        direction = "bearish"
    else:
        # Use last 5-bar slope as proxy.
        if len(df_lc) >= 6:
            recent = float(df_lc["close"].iloc[-1] - df_lc["close"].iloc[-6])
            direction = "bullish" if recent >= 0 else "bearish"
        else:
            direction = "bullish"

    shaped = _shape(direction, best, df_lc)
    if shaped is None:
        return None
    shaped["pattern_name"] = f"Narrow Range — {label}"
    shaped["nr7_id"] = nr7_id
    return shaped
