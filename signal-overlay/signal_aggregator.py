"""Signal aggregator — converts per-candle pattern detections into BUY / SELL / HOLD signals.

Input shape (per detected pattern):
    {
        "index": int,              # row index into the OHLCV DataFrame
        "pattern_name": str,
        "direction": "bullish" | "bearish" | "neutral",
        "strength": float          # 0.0 – 3.0
    }

Output (per candle with at least one detection):
    {
        "time": str,               # ISO date pulled from df.iloc[idx]["time"]
        "signal": "BUY" | "SELL" | "HOLD",
        "confidence": float,       # min(dominant_score / 3.0, 1.0), 2dp
        "patterns": [pattern_name, ...]  # all pattern names that fired on this candle
    }

Aggregation rules (per spec):
    bull_score = sum(strength) of bullish patterns on the candle
    bear_score = sum(strength) of bearish patterns on the candle
    BUY   ← bull_score > 1.5  AND  bull_score > bear_score * 1.3
    SELL  ← bear_score > 1.5  AND  bear_score > bull_score * 1.3
    HOLD  ← everything else (conflicting / weak)

The module is intentionally framework-free — no Flask, no DataFrame mutation.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable, List

import pandas as pd


# ─── Thresholds ───────────────────────────────────────────────────────────
# Kept module-level so a future caller can monkey-patch or override them for
# A/B testing without forking the function.
BUY_THRESHOLD = 1.5
SELL_THRESHOLD = 1.5
DOMINANCE_RATIO = 1.3   # winning side must beat the other by at least this much
MAX_STRENGTH = 3.0      # divisor for confidence normalisation


def _row_time(df: pd.DataFrame, idx: int) -> str:
    """Pull the time column for row `idx` and emit ISO-date format.

    Accepts the time column being a pandas Timestamp, datetime, or already-
    formatted string. Returns "" when the index is out of range so a buggy
    detector index can't crash the whole pipeline.
    """
    if idx < 0 or idx >= len(df):
        return ""
    if "time" not in df.columns:
        # Fall back to the DataFrame index — common when the user has set
        # the timestamp as the row index instead of a "time" column.
        v = df.index[idx]
    else:
        v = df.iloc[idx]["time"]
    try:
        if isinstance(v, pd.Timestamp):
            return v.isoformat()
        if hasattr(v, "isoformat"):
            return v.isoformat()  # datetime.date / datetime.datetime
    except Exception:
        pass
    return str(v)


def aggregate_signals(df: pd.DataFrame, patterns: Iterable[dict]) -> List[dict]:
    """Aggregate per-candle pattern detections into BUY/SELL/HOLD signals."""
    if df is None or len(df) == 0:
        return []

    # Group by candle index in a single pass.
    bull: dict[int, float] = defaultdict(float)
    bear: dict[int, float] = defaultdict(float)
    names: dict[int, list[str]] = defaultdict(list)

    for p in patterns or []:
        # Defensive: skip rows missing required keys instead of raising.
        try:
            idx = int(p["index"])
            direction = str(p["direction"]).lower()
            strength = float(p.get("strength", 0.0))
            name = str(p["pattern_name"])
        except (KeyError, TypeError, ValueError):
            continue
        if idx < 0 or idx >= len(df):
            continue
        if direction == "bullish":
            bull[idx] += strength
        elif direction == "bearish":
            bear[idx] += strength
        # "neutral" still gets recorded as a name so the tooltip can show it,
        # but contributes nothing to the bull/bear scores.
        names[idx].append(name)

    out: List[dict] = []
    # Sort by index so the output is in chronological order (the chart
    # frontend re-sorts by time anyway, but emitting sorted output keeps
    # downstream consumers happy with no extra work).
    for idx in sorted(names.keys()):
        b = bull[idx]
        s = bear[idx]
        if b > BUY_THRESHOLD and b > s * DOMINANCE_RATIO:
            sig = "BUY"
            dominant = b
        elif s > SELL_THRESHOLD and s > b * DOMINANCE_RATIO:
            sig = "SELL"
            dominant = s
        else:
            sig = "HOLD"
            # For HOLD we report whichever side is larger as the confidence
            # number, so a "weak BUY" still shows ~0.4 instead of 0.
            dominant = max(b, s)

        confidence = round(min(dominant / MAX_STRENGTH, 1.0), 2)
        out.append({
            "time": _row_time(df, idx),
            "signal": sig,
            "confidence": confidence,
            "patterns": list(names[idx]),
        })
    return out
