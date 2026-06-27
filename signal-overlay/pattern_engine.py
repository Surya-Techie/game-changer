"""Pattern engine — detects candlestick patterns and returns the 4-key dict
shape consumed by signal_aggregator.aggregate_signals().

Per-pattern detection function signature:
    detector(df: pd.DataFrame) -> Iterable[dict]   (each dict is one detection)

Each detection:
    {
        "index": int,                 # row index into df (the candle the pattern formed on)
        "pattern_name": str,
        "direction": "bullish" | "bearish" | "neutral",
        "strength": float             # 0.0 – 3.0
    }

Strength scale (anchored so it matches signal_aggregator's MAX_STRENGTH=3):
    1.0 = baseline geometric match
    2.0 = strong match (clean shape, prior trend lined up)
    3.0 = exceptional match (very large body, strong wick ratio, etc.)

This is a deliberately compact module — eight high-edge patterns is enough
to demo the signal pipeline; extend with more detectors as needed.
"""

from __future__ import annotations

from typing import Iterable, List

import pandas as pd


# ─── Per-candle geometry helpers ──────────────────────────────────────────

def _o(row): return float(row["open"])
def _h(row): return float(row["high"])
def _l(row): return float(row["low"])
def _c(row): return float(row["close"])
def _body(row) -> float:      return abs(_c(row) - _o(row))
def _range(row) -> float:     return max(_h(row) - _l(row), 1e-9)
def _upper_wick(row) -> float: return _h(row) - max(_o(row), _c(row))
def _lower_wick(row) -> float: return min(_o(row), _c(row)) - _l(row)
def _is_bull(row) -> bool:    return _c(row) > _o(row)
def _is_bear(row) -> bool:    return _c(row) < _o(row)


def _prior_trend(df: pd.DataFrame, idx: int, lookback: int = 6) -> str:
    """Return 'uptrend' / 'downtrend' / 'sideways' over the last `lookback` closes."""
    start = max(0, idx - lookback)
    win = df["close"].iloc[start:idx]
    if len(win) < 3:
        return "sideways"
    first = float(win.iloc[0])
    last = float(win.iloc[-1])
    change = (last - first) / max(abs(first), 1e-9)
    if change > 0.012:
        return "uptrend"
    if change < -0.012:
        return "downtrend"
    return "sideways"


# ─── Detectors ────────────────────────────────────────────────────────────

def detect_hammer(df: pd.DataFrame) -> List[dict]:
    out: List[dict] = []
    for i in range(3, len(df)):
        row = df.iloc[i]
        b = _body(row)
        r = _range(row)
        if b == 0:
            continue
        if b > 0.35 * r:
            continue
        if _lower_wick(row) < 2.0 * b:
            continue
        if _upper_wick(row) > 0.5 * b:
            continue
        if _prior_trend(df, i) != "downtrend":
            continue
        # Strength scales with wick:body ratio.
        wick_ratio = _lower_wick(row) / max(b, 1e-9)
        strength = min(3.0, 1.0 + min(wick_ratio, 5.0) * 0.4)
        out.append({"index": i, "pattern_name": "Hammer", "direction": "bullish", "strength": round(strength, 2)})
    return out


def detect_shooting_star(df: pd.DataFrame) -> List[dict]:
    out: List[dict] = []
    for i in range(3, len(df)):
        row = df.iloc[i]
        b = _body(row)
        r = _range(row)
        if b == 0:
            continue
        if b > 0.35 * r or _upper_wick(row) < 2.0 * b or _lower_wick(row) > 0.5 * b:
            continue
        if _prior_trend(df, i) != "uptrend":
            continue
        wick_ratio = _upper_wick(row) / max(b, 1e-9)
        strength = min(3.0, 1.0 + min(wick_ratio, 5.0) * 0.4)
        out.append({"index": i, "pattern_name": "Shooting Star", "direction": "bearish", "strength": round(strength, 2)})
    return out


def detect_doji(df: pd.DataFrame) -> List[dict]:
    out: List[dict] = []
    for i in range(len(df)):
        row = df.iloc[i]
        r = _range(row)
        b = _body(row)
        if r <= 0 or b > 0.10 * r:
            continue
        # Dojis are indecision — emit as neutral; strength 0.6 so the aggregator
        # records them on the patterns list but they don't bias bull/bear scores.
        out.append({"index": i, "pattern_name": "Doji", "direction": "neutral", "strength": 0.6})
    return out


def detect_bullish_engulfing(df: pd.DataFrame) -> List[dict]:
    out: List[dict] = []
    for i in range(4, len(df)):
        prev, curr = df.iloc[i - 1], df.iloc[i]
        if not (_is_bear(prev) and _is_bull(curr)):
            continue
        if not (_o(curr) <= _c(prev) and _c(curr) >= _o(prev)):
            continue
        if _body(curr) < 1.1 * max(_body(prev), 1e-9):
            continue
        if _prior_trend(df, i) == "uptrend":
            continue
        ratio = _body(curr) / max(_body(prev), 1e-9)
        strength = min(3.0, 1.0 + (ratio - 1.0) * 1.0)
        out.append({"index": i, "pattern_name": "Bullish Engulfing", "direction": "bullish", "strength": round(strength, 2)})
    return out


def detect_bearish_engulfing(df: pd.DataFrame) -> List[dict]:
    out: List[dict] = []
    for i in range(4, len(df)):
        prev, curr = df.iloc[i - 1], df.iloc[i]
        if not (_is_bull(prev) and _is_bear(curr)):
            continue
        if not (_o(curr) >= _c(prev) and _c(curr) <= _o(prev)):
            continue
        if _body(curr) < 1.1 * max(_body(prev), 1e-9):
            continue
        if _prior_trend(df, i) == "downtrend":
            continue
        ratio = _body(curr) / max(_body(prev), 1e-9)
        strength = min(3.0, 1.0 + (ratio - 1.0) * 1.0)
        out.append({"index": i, "pattern_name": "Bearish Engulfing", "direction": "bearish", "strength": round(strength, 2)})
    return out


def detect_morning_star(df: pd.DataFrame) -> List[dict]:
    out: List[dict] = []
    for i in range(4, len(df)):
        a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
        if not (_is_bear(a) and _body(b) < 0.4 * _body(a) and _is_bull(c)):
            continue
        mid_a = (_o(a) + _c(a)) / 2
        if _c(c) <= mid_a:
            continue
        if _prior_trend(df, i - 2) != "downtrend":
            continue
        penetration = (_c(c) - mid_a) / max(_body(a), 1e-9)
        strength = min(3.0, 2.0 + min(penetration, 1.0) * 1.0)
        out.append({"index": i, "pattern_name": "Morning Star", "direction": "bullish", "strength": round(strength, 2)})
    return out


def detect_evening_star(df: pd.DataFrame) -> List[dict]:
    out: List[dict] = []
    for i in range(4, len(df)):
        a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
        if not (_is_bull(a) and _body(b) < 0.4 * _body(a) and _is_bear(c)):
            continue
        mid_a = (_o(a) + _c(a)) / 2
        if _c(c) >= mid_a:
            continue
        if _prior_trend(df, i - 2) != "uptrend":
            continue
        penetration = (mid_a - _c(c)) / max(_body(a), 1e-9)
        strength = min(3.0, 2.0 + min(penetration, 1.0) * 1.0)
        out.append({"index": i, "pattern_name": "Evening Star", "direction": "bearish", "strength": round(strength, 2)})
    return out


def detect_marubozu(df: pd.DataFrame) -> List[dict]:
    out: List[dict] = []
    for i in range(len(df)):
        row = df.iloc[i]
        b = _body(row)
        r = _range(row)
        if r <= 0 or b < 0.9 * r:
            continue
        direction = "bullish" if _is_bull(row) else "bearish"
        # Marubozu strength scales with body share of range.
        strength = min(3.0, 1.5 + (b / r) * 1.2)
        name = "Bullish Marubozu" if direction == "bullish" else "Bearish Marubozu"
        out.append({"index": i, "pattern_name": name, "direction": direction, "strength": round(strength, 2)})
    return out


# ─── Registry + public entry point ────────────────────────────────────────

DETECTORS = [
    detect_hammer,
    detect_shooting_star,
    detect_doji,
    detect_bullish_engulfing,
    detect_bearish_engulfing,
    detect_morning_star,
    detect_evening_star,
    detect_marubozu,
]


def detect_patterns(df: pd.DataFrame) -> List[dict]:
    """Run every registered detector and return the flat list of detections.

    Errors in a single detector are isolated — the rest still run.
    """
    out: List[dict] = []
    for det in DETECTORS:
        try:
            out.extend(det(df))
        except Exception:
            # Detectors that throw shouldn't break the pipeline.
            continue
    return out
