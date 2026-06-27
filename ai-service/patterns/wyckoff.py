"""Wyckoff Accumulation / Distribution — bridge to existing detectors.

Uses `detect_wyckoff_spring` (accumulation Phase C) and
`detect_wyckoff_upthrust` (distribution Phase C) from
`_institutional.py`, plus `detect_bullish_consolidation_breakout` /
`detect_bearish_consolidation_breakout` for Phase D (sign of strength).

Full 4-phase schematic tracking (PS → SC → AR → ST → SOW → Spring →
LPS → SOS → BU) is a follow-up. The current bridge catches the two
highest-value events: the Spring (best entry in accumulation) and the
Upthrust (best entry in distribution).
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from patterns._bridge_utils import run_aggregate
from patterns import _institutional as _inst


_BULLISH = [
    _inst.detect_wyckoff_spring,
    _inst.detect_bullish_consolidation_breakout,
    _inst.detect_bullish_liquidity_sweep,
]
_BEARISH = [
    _inst.detect_wyckoff_upthrust,
    _inst.detect_bearish_consolidation_breakout,
    _inst.detect_bearish_liquidity_sweep,
]


def detect_wyckoff(df: pd.DataFrame, *args, **kwargs) -> Optional[dict]:
    res = run_aggregate(
        df,
        [(_BULLISH, _BEARISH)],
        pattern_name="Wyckoff",
    )
    if res is None:
        return None
    # Tag the result with the schematic + phase so master_confluence can
    # use them for the TIER 2 "Wyckoff + SMC" rule.
    res["schematic"] = "accumulation" if res["direction"] == "bullish" else "distribution"
    res["current_phase"] = "C"  # Spring/Upthrust corresponds to Phase C
    return res
