"""Smart Money Concepts — bridge to the 31 SMC detectors in _institutional.

Aggregates: Order Block, FVG, Liquidity Sweep, Breaker Block, Mitigation
Block, Inducement, OTE, Power of 3, Pin Bar, Wide Range Bar, Fakey.

Returns the strongest hit across all SMC detectors, with risk-capped
entry/stop/target. None if no SMC pattern fires.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from patterns._bridge_utils import run_aggregate
from patterns import _institutional as _inst


_BULLISH = [
    _inst.detect_bullish_order_block,
    _inst.detect_bullish_fair_value_gap,
    _inst.detect_bullish_liquidity_sweep,
    _inst.detect_bullish_breaker_block,
    _inst.detect_bullish_mitigation_block,
    _inst.detect_bullish_inducement,
    _inst.detect_bullish_ote,
    _inst.detect_bullish_power_of_3,
    _inst.detect_bullish_pin_bar,
    _inst.detect_bullish_fakey,
    _inst.detect_wyckoff_spring,
]

_BEARISH = [
    _inst.detect_bearish_order_block,
    _inst.detect_bearish_fair_value_gap,
    _inst.detect_bearish_liquidity_sweep,
    _inst.detect_bearish_breaker_block,
    _inst.detect_bearish_mitigation_block,
    _inst.detect_bearish_inducement,
    _inst.detect_bearish_ote,
    _inst.detect_bearish_power_of_3,
    _inst.detect_bearish_pin_bar,
    _inst.detect_bearish_fakey,
    _inst.detect_wyckoff_upthrust,
]


def detect_smc_patterns(df: pd.DataFrame, *args, **kwargs) -> Optional[dict]:
    return run_aggregate(
        df,
        [(_BULLISH, _BEARISH)],
        pattern_name="Smart Money Concepts",
    )
