"""Cup and Handle — bridge to `_western.detect_cup_and_handle` and
`_western.detect_inverse_cup_and_handle`.

The existing detectors cover the O'Neil / IBD geometry. This wrapper
applies the risk envelope and emits the spec-compliant verdict shape.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from patterns._bridge_utils import run_pair
from patterns import _western as _w


def detect_cup_and_handle(df: pd.DataFrame, *args, **kwargs) -> Optional[dict]:
    return run_pair(
        df,
        bullish_fn=_w.detect_cup_and_handle,
        bearish_fn=_w.detect_inverse_cup_and_handle,
    )
