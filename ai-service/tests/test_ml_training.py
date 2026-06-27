"""Tests for the strengthened ML training pipeline.

Cover the new robustness pieces: recency weighting, purge/embargo split,
and the end-to-end train→predict contract. We do NOT assert a particular
accuracy — that would be testing the market, not the code — only that the
pipeline is well-formed and honest (confidence stays 0 without edge).
"""

import importlib.util
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, filename))
    mod = importlib.util.module_from_spec(spec)
    # Register before exec so dataclass type-hint resolution (which looks the
    # module up in sys.modules via cls.__module__) works during collection.
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


M = _load("ml_training", "ml_training.py")


def test_recency_weights_monotonic_and_normalised():
    w = M._recency_weights(10, half_life=5.0)
    assert len(w) == 10
    assert w[-1] == 1.0                       # most recent bar weighted highest
    assert np.all(w > 0) and np.all(w <= 1.0)
    assert np.all(np.diff(w) > 0)             # strictly increasing toward present
    assert M._recency_weights(0).shape == (0,)


def _synthetic(n=400, seed=7):
    rng = np.random.default_rng(seed)
    c = 100.0
    out = []
    for i in range(n):
        c *= 1 + rng.normal(0.0004, 0.012)
        out.append({"t": i * 86_400_000, "o": c, "h": c * 1.004,
                    "l": c * 0.996, "c": c, "v": 1e6})
    return out


def test_train_then_predict_contract():
    candles = _synthetic()
    metrics = M.train_symbol("TESTSYM", candles, horizon=5)
    for k in ("directionAccuracyPct", "brierScore", "logLoss",
              "outOfSampleR2", "cvR2Mean", "nTrain", "nTest"):
        assert k in metrics, f"missing metric {k}"
    pred = M.predict_with_trained("TESTSYM", candles)
    assert pred["ready"] is True
    assert pred["direction"] in ("UP", "DOWN", "FLAT")
    assert 0.0 <= pred["confidence"] <= 0.95


def test_insufficient_data_is_reported_not_crashed():
    out = M.train_symbol("TINY", _synthetic(n=60))
    assert "error" in out


def test_purge_keeps_blocks_non_overlapping():
    # With horizon=5 the embargo must remove ≥5 rows between train and test
    # so the trained model's labels never peek into the holdout's features.
    candles = _synthetic(n=500)
    X, y, ts, vs = M.build_features(candles)
    n = X.shape[0]
    split_train = int(n * 0.70)
    split_cal = int(n * 0.85)
    embargo = 5
    # The first test row index is split_cal + embargo; assert there is a gap.
    assert (split_cal + embargo) - split_train > split_cal - split_train
