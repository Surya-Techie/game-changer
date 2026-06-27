"""Smoke test for signal_aggregator.aggregate_signals.

Run with:
    cd signal-overlay && python test_signal_aggregator.py

Covers each branch of the BUY / SELL / HOLD decision tree plus the edge
cases (empty input, out-of-range index, missing keys).
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta

import pandas as pd

from signal_aggregator import aggregate_signals


def _fake_df(n: int) -> pd.DataFrame:
    start = datetime(2026, 1, 1)
    return pd.DataFrame({
        "time": [start + timedelta(days=i) for i in range(n)],
        "open": [100.0] * n,
        "high": [101.0] * n,
        "low": [99.0] * n,
        "close": [100.5] * n,
        "volume": [10_000.0] * n,
    })


def expect(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def main() -> int:
    df = _fake_df(5)

    # 1. BUY — bull score 2.5, bear 0.5 → 2.5 > 1.5 AND 2.5 > 0.5 * 1.3
    out = aggregate_signals(df, [
        {"index": 0, "pattern_name": "Bullish Engulfing", "direction": "bullish", "strength": 1.5},
        {"index": 0, "pattern_name": "Hammer",             "direction": "bullish", "strength": 1.0},
        {"index": 0, "pattern_name": "Shooting Star",      "direction": "bearish", "strength": 0.5},
    ])
    expect(len(out) == 1, "BUY: expected 1 signal row")
    expect(out[0]["signal"] == "BUY", f"BUY: got {out[0]['signal']}")
    expect(out[0]["confidence"] == round(2.5 / 3.0, 2), f"BUY confidence: got {out[0]['confidence']}")
    expect("Bullish Engulfing" in out[0]["patterns"] and "Hammer" in out[0]["patterns"], "BUY pattern list missing entries")

    # 2. SELL — symmetric
    out = aggregate_signals(df, [
        {"index": 1, "pattern_name": "Bearish Engulfing", "direction": "bearish", "strength": 1.6},
        {"index": 1, "pattern_name": "Evening Star",      "direction": "bearish", "strength": 0.8},
        {"index": 1, "pattern_name": "Hammer",            "direction": "bullish", "strength": 0.4},
    ])
    expect(out[0]["signal"] == "SELL", f"SELL: got {out[0]['signal']}")

    # 3. HOLD — conflicting (both sides above 1.5 but neither dominates by 1.3×)
    out = aggregate_signals(df, [
        {"index": 2, "pattern_name": "Bullish Engulfing", "direction": "bullish", "strength": 1.8},
        {"index": 2, "pattern_name": "Bearish Engulfing", "direction": "bearish", "strength": 1.6},
    ])
    expect(out[0]["signal"] == "HOLD", f"HOLD (conflicting): got {out[0]['signal']}")

    # 4. HOLD — weak (single bullish pattern but below 1.5 threshold)
    out = aggregate_signals(df, [
        {"index": 3, "pattern_name": "Doji", "direction": "bullish", "strength": 1.2},
    ])
    expect(out[0]["signal"] == "HOLD", f"HOLD (weak): got {out[0]['signal']}")

    # 5. Empty input
    expect(aggregate_signals(df, []) == [], "empty patterns should return []")
    expect(aggregate_signals(pd.DataFrame(), [{"index": 0, "pattern_name": "x", "direction": "bullish", "strength": 2.0}]) == [],
           "empty df should return []")

    # 6. Out-of-range / malformed patterns are skipped silently
    out = aggregate_signals(df, [
        {"index": 99, "pattern_name": "OOR",       "direction": "bullish", "strength": 3.0},
        {"index": 4,  "pattern_name": "NoStrength", "direction": "bullish"},  # default strength=0 → no signal
        {"index": "bad", "pattern_name": "Junk", "direction": "bullish", "strength": 2.0},
    ])
    # The OOR row is dropped; the strength-less row scores 0 → HOLD with confidence 0.
    expect(any(r["patterns"] == ["NoStrength"] and r["signal"] == "HOLD" and r["confidence"] == 0.0 for r in out),
           f"strength-less pattern handling: got {out}")

    # 7. Time column round-trips as ISO.
    out = aggregate_signals(df, [
        {"index": 0, "pattern_name": "Hammer", "direction": "bullish", "strength": 2.0},
    ])
    expect(out[0]["time"].startswith("2026-01-01"), f"time format: got {out[0]['time']}")

    print("PASS — all aggregate_signals branches behave correctly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
