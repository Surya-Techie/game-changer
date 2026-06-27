"""Darvas Box — adapted from existing consolidation-breakout detectors.

Pure Darvas requires box-formation rules (top + 3 failed higher highs,
bottom + 3 failed lower lows, stacked-box continuation). The closest
existing detectors are the bullish/bearish consolidation-breakout
patterns in `_institutional.py` — semantically equivalent to a Darvas
box breakout. The bridge surfaces those with the Darvas naming.

A from-scratch box-rule implementation can replace this bridge later;
for now this is what feeds master_confluence's TIER 2 rule
"Breakaway Gap + Darvas Box = institutional breakout".
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from patterns._bridge_utils import run_pair
from patterns import _institutional as _inst


def detect_darvas_box(df: pd.DataFrame, *args, **kwargs) -> Optional[dict]:
    res = run_pair(
        df,
        bullish_fn=_inst.detect_bullish_consolidation_breakout,
        bearish_fn=_inst.detect_bearish_consolidation_breakout,
    )
    if res is None:
        return None
    res["pattern_name"] = "Darvas Box Breakout"
    return res
