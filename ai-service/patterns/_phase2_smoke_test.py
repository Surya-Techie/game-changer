"""Phase 2 integration smoke test (rule engine + ML + confidence).

Steps:
1. Build several synthetic OHLCV frames (mix of trends).
2. Run rule_engine.run_all_patterns — must emit ≥1 enriched detection.
3. Confirm ml_classifier.predict_proba returns source='rule_only' before
   any training has happened (clean install behaviour).
4. Train tiny models (fast=True) on the synthetic frames via
   train_from_frames — must succeed and save model files.
5. Confirm predict_proba now returns source='ensemble' and the
   confidence engine factors the ML component into its score breakdown.

Run with:
    cd ai-service && python patterns/_phase2_smoke_test.py

Exits non-zero on any failure.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))


def _synthetic(n: int, kind: str, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed=seed)
    if kind == "up":
        close = 100 + np.cumsum(rng.normal(loc=0.4, scale=1.0, size=n))
    elif kind == "down":
        close = 200 + np.cumsum(rng.normal(loc=-0.4, scale=1.0, size=n))
    elif kind == "flat":
        close = 150 + np.cumsum(rng.normal(loc=0.0, scale=0.5, size=n))
    else:  # noisy
        close = 150 + np.cumsum(rng.normal(loc=0.0, scale=1.6, size=n))
    open_ = np.concatenate([[close[0]], close[:-1]])
    high = np.maximum(open_, close) + rng.uniform(0.2, 1.6, size=n)
    low = np.minimum(open_, close) - rng.uniform(0.2, 1.6, size=n)
    vol = rng.integers(100_000, 1_000_000, size=n).astype(float)
    t = np.arange(n, dtype="int64") * 60_000
    df = pd.DataFrame({
        "time": t, "open": open_, "high": high, "low": low, "close": close, "volume": vol,
    })
    return df


def main() -> int:
    # Use a temporary models dir so we don't pollute the real one.
    tmp_models = Path(tempfile.mkdtemp(prefix="qti_pattern_models_"))
    os.environ["PATTERN_MODELS_DIR"] = str(tmp_models)
    print("Using temp models dir:", tmp_models)

    # Late-import so PATTERN_MODELS_DIR is honored.
    from patterns.rule_engine import run_all_patterns
    from patterns.ml_classifier import predict_proba, registry_status
    from patterns.confidence_engine import score_many
    from patterns.train_models import train_from_frames

    # --- Step 1: rule engine on synthetic data ---
    df_up = _synthetic(150, "up", seed=11)
    df_down = _synthetic(150, "down", seed=22)
    df_flat = _synthetic(150, "flat", seed=33)
    df_noisy = _synthetic(150, "noisy", seed=44)

    rule_hits = run_all_patterns(df_up)
    print(f"Step 1 (rule engine): {len(rule_hits)} enriched detections on uptrend frame")
    if not rule_hits:
        print("FAIL: expected ≥1 rule-engine detection on uptrend frame")
        return 1
    sample = rule_hits[0]
    if "filters" not in sample or "category" not in sample:
        print(f"FAIL: rule-engine result missing enrichment keys: {list(sample.keys())}")
        return 1

    # --- Step 2: ML lazy fallback (no model on disk yet) ---
    probs = predict_proba(df_up, timeframe="D1")
    if probs.source != "rule_only":
        print(f"FAIL: expected rule_only fallback, got source='{probs.source}'")
        return 1
    print(f"Step 2 (lazy fallback): source='{probs.source}' (no model yet — OK)")

    # --- Step 2b: confidence engine usable with rule-only ML ---
    scored = score_many(rule_hits, df_up, timeframe="D1")
    if not scored or "confidence_score" not in scored[0]:
        print("FAIL: confidence engine did not produce a score")
        return 1
    top = scored[0]
    print(f"Step 2b (rule-only confidence): top pattern '{top['pattern_name']}' scored {top['confidence_score']}/100 grade {top['grade']}")

    # --- Step 3: train tiny models on synthetic frames ---
    t0 = time.perf_counter()
    try:
        result = train_from_frames(
            [df_up, df_down, df_flat, df_noisy] * 3,  # multiply for sample volume
            timeframe="D1",
            horizon=5,
            stride=1,
            aug_factor=1,
            fast=True,
            progress=lambda m: print("   ", m),
        )
    except Exception as e:
        print(f"FAIL: training raised: {e!r}")
        import traceback; traceback.print_exc()
        return 1
    print(f"Step 3 (training): n={result.n_samples} (train={result.n_train}, val={result.n_val}, test={result.n_test}) in {time.perf_counter() - t0:.1f}s")
    print(f"   GB val acc:  {result.val_metrics.get('accuracy')}  f1:  {result.val_metrics.get('f1_macro')}")
    print(f"   GB test acc: {result.test_metrics.get('accuracy')}  f1: {result.test_metrics.get('f1_macro')}")

    # --- Step 4: ML now active ---
    probs2 = predict_proba(df_up, timeframe="D1")
    if probs2.source != "ensemble":
        print(f"FAIL: expected ensemble source after training, got '{probs2.source}'")
        return 1
    print(f"Step 4 (ensemble live): bullish={probs2.bullish_move:.3f}, bearish={probs2.bearish_move:.3f}, no_move={probs2.no_move:.3f}")

    # --- Step 5: confidence engine now uses the ML component ---
    scored2 = score_many(rule_hits, df_up, timeframe="D1")
    sample2 = scored2[0]
    if sample2["score_breakdown"].get("ml_source") != "ensemble":
        print(f"FAIL: confidence engine did not pick up the ensemble model: {sample2['score_breakdown']}")
        return 1
    ml_component = sample2["score_breakdown"].get("ml", 0.0)
    print(f"Step 5 (post-training confidence): top score {sample2['confidence_score']} grade {sample2['grade']} (ML component = {ml_component}/25)")

    # --- Final: registry status looks right ---
    status = registry_status()
    if not status["D1"]["ready"]:
        print("FAIL: registry says D1 model not ready")
        return 1
    print(f"Step 6 (registry status): D1 ready={status['D1']['ready']}, trained_at={status['D1']['trained_at']}")

    # Cleanup.
    shutil.rmtree(tmp_models, ignore_errors=True)
    print("\nPASS — Phase 2 pipeline integrates end-to-end (rule → ML lazy → train → ML active → confidence scored).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
