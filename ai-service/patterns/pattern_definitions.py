"""Pattern definitions registry.

This is the spec-required entry-point module. All detectors live in the
per-category submodules (`_single.py`, `_two.py`, `_three.py`, `_multi.py`,
`_western.py`, `_institutional.py`) and are re-exported here as a single
flat list.

The rule engine (Phase 2) and FastAPI router (Phase 3) consume
`ALL_DETECTORS` to iterate every detector generically, while the
per-category lists are kept available for category filtering on the
Scanner page (Phase 8).

Detector contract:
    detect_*(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult

Standard PatternResult keys (always present):
    pattern_name, detected, direction, candle_indices, strength,
    description, historical_win_rate

Extended keys (Western + institutional detectors):
    trendline_points, entry_price, target_price, stop_price, risk_reward
"""

from __future__ import annotations

from typing import Callable, List

import pandas as pd

from ._helpers import (
    HISTORICAL_WIN_RATE,
    PatternResult,
    TrendlinePoint,
    baseline_win_rate,
    ensure_df,
)
from ._single import SINGLE_CANDLE_DETECTORS
from ._two import TWO_CANDLE_DETECTORS
from ._three import THREE_CANDLE_DETECTORS
from ._multi import MULTI_CANDLE_DETECTORS
from ._western import WESTERN_DETECTORS
from ._institutional import INSTITUTIONAL_DETECTORS


# ─── Re-export per-category detector functions (named imports for tests) ───
from ._single import *  # noqa: F401,F403
from ._two import *  # noqa: F401,F403
from ._three import *  # noqa: F401,F403
from ._multi import *  # noqa: F401,F403
from ._western import *  # noqa: F401,F403
from ._institutional import *  # noqa: F401,F403


Detector = Callable[..., PatternResult]


ALL_DETECTORS: List[Detector] = (
    SINGLE_CANDLE_DETECTORS
    + TWO_CANDLE_DETECTORS
    + THREE_CANDLE_DETECTORS
    + MULTI_CANDLE_DETECTORS
    + WESTERN_DETECTORS
    + INSTITUTIONAL_DETECTORS
)


# Category metadata for the rule engine + UI filters.
CATEGORY_BY_DETECTOR: dict[str, str] = {
    **{d.__name__: "single_candle" for d in SINGLE_CANDLE_DETECTORS},
    **{d.__name__: "two_candle" for d in TWO_CANDLE_DETECTORS},
    **{d.__name__: "three_candle" for d in THREE_CANDLE_DETECTORS},
    **{d.__name__: "multi_candle" for d in MULTI_CANDLE_DETECTORS},
    **{d.__name__: "western" for d in WESTERN_DETECTORS},
    **{d.__name__: "institutional" for d in INSTITUTIONAL_DETECTORS},
}


def list_pattern_names() -> List[str]:
    """All pattern names this library can produce (for UI multi-select)."""
    return sorted(HISTORICAL_WIN_RATE.keys())


def detector_count() -> dict[str, int]:
    return {
        "single_candle": len(SINGLE_CANDLE_DETECTORS),
        "two_candle": len(TWO_CANDLE_DETECTORS),
        "three_candle": len(THREE_CANDLE_DETECTORS),
        "multi_candle": len(MULTI_CANDLE_DETECTORS),
        "western": len(WESTERN_DETECTORS),
        "institutional": len(INSTITUTIONAL_DETECTORS),
        "total": len(ALL_DETECTORS),
    }


def run_detector_safely(detector: Detector, df: pd.DataFrame) -> PatternResult:
    """Call a detector, catching exceptions so a single buggy detector can't
    take down a whole `/patterns/scan` call. On exception, returns an empty
    result tagged with the detector name."""
    try:
        return detector(df)
    except Exception as e:  # noqa: BLE001
        name = detector.__name__.replace("detect_", "").replace("_", " ").title()
        return {
            "pattern_name": name,
            "detected": False,
            "direction": "neutral",
            "candle_indices": [],
            "strength": 0.0,
            "description": f"detector error: {e}",
            "historical_win_rate": baseline_win_rate(name),
        }


__all__ = [
    "PatternResult",
    "TrendlinePoint",
    "HISTORICAL_WIN_RATE",
    "baseline_win_rate",
    "ensure_df",
    "ALL_DETECTORS",
    "SINGLE_CANDLE_DETECTORS",
    "TWO_CANDLE_DETECTORS",
    "THREE_CANDLE_DETECTORS",
    "MULTI_CANDLE_DETECTORS",
    "WESTERN_DETECTORS",
    "INSTITUTIONAL_DETECTORS",
    "CATEGORY_BY_DETECTOR",
    "list_pattern_names",
    "detector_count",
    "run_detector_safely",
]
