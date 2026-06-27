"""QTI institutional-grade pattern detection package.

Modules:
- pattern_definitions: pure-function detectors for every supported pattern.
- (later phases will add rule_engine, ml_classifier, confidence_engine, explainer.)

Every detector returns a `PatternResult` TypedDict with a stable shape so
upstream code (rule engine, confidence engine, FastAPI router) can iterate
detectors generically.
"""

from .pattern_definitions import (
    PatternResult,
    ALL_DETECTORS,
    SINGLE_CANDLE_DETECTORS,
    TWO_CANDLE_DETECTORS,
    THREE_CANDLE_DETECTORS,
    MULTI_CANDLE_DETECTORS,
    WESTERN_DETECTORS,
    INSTITUTIONAL_DETECTORS,
)

# Restore the legacy `detect_all` API. The `/patterns` endpoint in main.py
# imports the top-level `patterns` symbol and calls `.detect_all(candles)`.
# When this directory became a package, it shadowed the old patterns.py
# module and `detect_all` disappeared — the endpoint has been raising
# AttributeError at runtime ever since. We re-export it here from the
# (now renamed) legacy module so the API works again, while the newer
# rule-engine detectors remain available for the /pattern_router routes.
from _legacy_patterns import detect_all, Detection, Pivot, find_pivots  # type: ignore[import-not-found]  # noqa: E402

__all__ = [
    "PatternResult",
    "ALL_DETECTORS",
    "SINGLE_CANDLE_DETECTORS",
    "TWO_CANDLE_DETECTORS",
    "THREE_CANDLE_DETECTORS",
    "MULTI_CANDLE_DETECTORS",
    "WESTERN_DETECTORS",
    "INSTITUTIONAL_DETECTORS",
    "detect_all",
    "Detection",
    "Pivot",
    "find_pivots",
]
