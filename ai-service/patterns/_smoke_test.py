"""Internal smoke test for the pattern library.

Exercises every detector against three synthetic windows (uptrend,
downtrend, sideways) and verifies the standard PatternResult contract
holds for every call. Run with:

    python -m ai-service.patterns._smoke_test
or:
    python ai-service/patterns/_smoke_test.py

Exits non-zero if any detector returns a malformed dict or raises.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

# Allow direct script execution from inside ai-service/ or repo root.
HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))

from patterns.pattern_definitions import (  # noqa: E402
    ALL_DETECTORS,
    CATEGORY_BY_DETECTOR,
    INSTITUTIONAL_DETECTORS,
    WESTERN_DETECTORS,
    detector_count,
    ensure_df,
    list_pattern_names,
    run_detector_safely,
)

REQUIRED_KEYS = {
    "pattern_name", "detected", "direction", "candle_indices",
    "strength", "description", "historical_win_rate",
}
EXTENDED_KEYS = {"trendline_points", "entry_price", "target_price", "stop_price", "risk_reward"}
VALID_DIRECTIONS = {"bullish", "bearish", "continuation", "neutral"}


def _synthetic(n: int, kind: str) -> pd.DataFrame:
    """Build a fake OHLCV DataFrame of `n` bars. `kind` ∈ {'up','down','flat','noisy'}."""
    rng = np.random.default_rng(seed=hash(kind) & 0xFFFF_FFFF)
    if kind == "up":
        close = 100 + np.cumsum(rng.normal(loc=0.5, scale=1.0, size=n))
    elif kind == "down":
        close = 200 + np.cumsum(rng.normal(loc=-0.5, scale=1.0, size=n))
    elif kind == "flat":
        close = 150 + rng.normal(loc=0.0, scale=0.8, size=n).cumsum() * 0.1
    else:  # noisy
        close = 150 + rng.normal(loc=0.0, scale=2.0, size=n).cumsum()
    open_ = np.concatenate([[close[0]], close[:-1]])
    high = np.maximum(open_, close) + rng.uniform(0.1, 1.5, size=n)
    low = np.minimum(open_, close) - rng.uniform(0.1, 1.5, size=n)
    vol = rng.integers(100_000, 1_000_000, size=n).astype(float)
    t = np.arange(n, dtype="int64") * 60_000  # 1-minute bars
    return ensure_df(pd.DataFrame({
        "time": t, "open": open_, "high": high, "low": low, "close": close, "volume": vol,
    }))


def _validate_result(detector_name: str, res, requires_extended: bool) -> list[str]:
    errors: list[str] = []
    if not isinstance(res, dict):
        return [f"{detector_name}: result is not a dict ({type(res).__name__})"]
    missing = REQUIRED_KEYS - set(res.keys())
    if missing:
        errors.append(f"{detector_name}: missing keys {sorted(missing)}")
    if "direction" in res and res["direction"] not in VALID_DIRECTIONS:
        errors.append(f"{detector_name}: invalid direction '{res['direction']}'")
    if "strength" in res:
        s = res["strength"]
        if not isinstance(s, (int, float)) or s < 0 or s > 1.0001:
            errors.append(f"{detector_name}: strength out of [0,1] (got {s})")
    if "historical_win_rate" in res:
        w = res["historical_win_rate"]
        if not isinstance(w, (int, float)) or w < 0 or w > 1.0001:
            errors.append(f"{detector_name}: historical_win_rate out of [0,1] (got {w})")
    if res.get("detected") and requires_extended:
        missing_ext = EXTENDED_KEYS - set(res.keys())
        if missing_ext:
            errors.append(f"{detector_name}: detected extended pattern missing keys {sorted(missing_ext)}")
    return errors


def main() -> int:
    counts = detector_count()
    print("\n=== Pattern library — smoke test ===")
    print("Detector counts:", counts)
    print("Pattern names registered (HISTORICAL_WIN_RATE):", len(list_pattern_names()))

    samples = {kind: _synthetic(120, kind) for kind in ("up", "down", "flat", "noisy")}

    all_errors: list[str] = []
    detection_counts = {k: 0 for k in samples}
    timings: list[float] = []

    extended_detector_names = {d.__name__ for d in WESTERN_DETECTORS + INSTITUTIONAL_DETECTORS}

    for det in ALL_DETECTORS:
        requires_extended = det.__name__ in extended_detector_names
        for kind, df in samples.items():
            t0 = time.perf_counter()
            res = run_detector_safely(det, df)
            timings.append(time.perf_counter() - t0)
            errs = _validate_result(det.__name__, res, requires_extended)
            all_errors.extend(errs)
            if res.get("detected"):
                detection_counts[kind] += 1

    print(f"Total detector × scenario calls: {len(ALL_DETECTORS) * len(samples)}")
    print(f"Detections per scenario: {detection_counts}")
    print(f"Median per-call latency: {1000 * np.median(timings):.2f} ms — Max: {1000 * np.max(timings):.2f} ms")

    if all_errors:
        print(f"\nFAIL — {len(all_errors)} contract violation(s):")
        for e in all_errors[:50]:
            print(f"  • {e}")
        if len(all_errors) > 50:
            print(f"  … and {len(all_errors) - 50} more")
        return 1

    print("PASS — every detector honors the PatternResult contract on all 4 scenarios.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
