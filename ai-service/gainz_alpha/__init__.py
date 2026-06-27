"""Gainz Alpha — Brandt classical pattern model + ensemble.

This package implements the Brandt-rules-encoded composite scoring engine
described in Peter Brandt's *Trading Commodity Futures with Classical
Chart Patterns*. The four key entry points are:

    pattern_detector.detect_best_brandt_pattern(ohlcv)
        Run the 23 Brandt-mapped detectors over a candle DataFrame and
        return the highest-quality match.

    brandt_features.extract_brandt_features(ohlcv, pattern, sentiment)
        Compute the 19-feature vector consumed by the ML model.

    brandt_scorer.compute_brandt_score(features)
        Apply Brandt's hard filters + bonus rules; returns 0..100 score
        plus reject reasons.

    ensemble_engine.GainzAlphaEngine
        Combines the trained Brandt model with three optional auxiliary
        models (RSI/MACD, sentiment/volume, momentum) into a single
        composite alpha score and BUY/SELL/STRONG_BUY/etc. signal.
"""

from .pattern_detector import detect_best_brandt_pattern, PATTERN_NAME_TO_ID
from .brandt_features import extract_brandt_features, BRANDT_FEATURES
from .brandt_scorer import compute_brandt_score
from .ensemble_engine import GainzAlphaEngine

__all__ = [
    "detect_best_brandt_pattern",
    "PATTERN_NAME_TO_ID",
    "extract_brandt_features",
    "BRANDT_FEATURES",
    "compute_brandt_score",
    "GainzAlphaEngine",
]
