"""Resample 1-minute candles to higher timeframes and check trend alignment."""

from __future__ import annotations

from typing import List


def resample(candles: List[dict], minutes: int) -> List[dict]:
    """Aggregate 1m candles into N-minute candles. Assumes input is 1m, sorted."""
    if not candles:
        return []
    bucket_ms = minutes * 60 * 1000
    out: List[dict] = []
    current: dict | None = None
    for c in candles:
        t = int(c["t"])
        bucket = t - (t % bucket_ms)
        if current is None or current["t"] != bucket:
            if current is not None:
                out.append(current)
            current = {
                "t": bucket,
                "o": float(c["o"]),
                "h": float(c["h"]),
                "l": float(c["l"]),
                "c": float(c["c"]),
                "v": float(c["v"]),
            }
        else:
            current["h"] = max(current["h"], float(c["h"]))
            current["l"] = min(current["l"], float(c["l"]))
            current["c"] = float(c["c"])
            current["v"] += float(c["v"])
    if current is not None:
        out.append(current)
    return out


def trend_direction(candles: List[dict], fast: int = 9, slow: int = 21) -> str:
    """Returns 'UP' / 'DOWN' / 'FLAT' based on fast vs slow SMA on this timeframe."""
    if len(candles) < slow:
        return "FLAT"
    closes = [c["c"] for c in candles]
    fast_v = sum(closes[-fast:]) / fast
    slow_v = sum(closes[-slow:]) / slow
    diff_pct = (fast_v - slow_v) / slow_v
    if diff_pct > 0.0005:
        return "UP"
    if diff_pct < -0.0005:
        return "DOWN"
    return "FLAT"


def mtf_alignment(candles_1m: List[dict], desired: str) -> dict:
    """Check whether higher TFs (5m, 15m) confirm the desired direction."""
    desired = desired.upper()
    tf5 = resample(candles_1m, 5)
    tf15 = resample(candles_1m, 15)
    d5 = trend_direction(tf5)
    d15 = trend_direction(tf15)
    agree5 = (desired == "BUY" and d5 == "UP") or (desired == "SELL" and d5 == "DOWN")
    agree15 = (desired == "BUY" and d15 == "UP") or (desired == "SELL" and d15 == "DOWN")
    aligned = agree5 and agree15
    return {
        "tf5": d5,
        "tf15": d15,
        "agree5": agree5,
        "agree15": agree15,
        "aligned": aligned,
    }
