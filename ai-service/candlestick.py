"""Candlestick pattern detection.

Detects single- and multi-bar candlestick patterns on the most recent bars.
Each detection returns a dict with name, bias (BULL/BEAR/NEUTRAL), index
into the candle array, timestamp, and a reliability score in [0, 1].
"""

from __future__ import annotations

from typing import List, Optional


def _body(c: dict) -> float:
    return c["c"] - c["o"]


def _abody(c: dict) -> float:
    return abs(c["c"] - c["o"])


def _range(c: dict) -> float:
    return max(c["h"] - c["l"], 1e-9)


def _upper_shadow(c: dict) -> float:
    return c["h"] - max(c["o"], c["c"])


def _lower_shadow(c: dict) -> float:
    return min(c["o"], c["c"]) - c["l"]


def _is_bull(c: dict) -> bool:
    return c["c"] > c["o"]


def _is_bear(c: dict) -> bool:
    return c["c"] < c["o"]


def _detect_doji(c: dict, i: int) -> Optional[dict]:
    if _abody(c) < 0.1 * _range(c):
        return {"name": "Doji", "bias": "NEUTRAL", "index": i, "t": c["t"], "reliability": 0.55,
                "notes": "Indecision — small body relative to range"}
    return None


def _detect_hammer(c: dict, i: int) -> Optional[dict]:
    body = _abody(c)
    rng = _range(c)
    if body < 0.35 * rng and _lower_shadow(c) > 2 * body and _upper_shadow(c) < body * 0.6:
        return {"name": "Hammer", "bias": "BULL", "index": i, "t": c["t"], "reliability": 0.65,
                "notes": "Long lower wick — buyers rejected lows"}
    return None


def _detect_shooting_star(c: dict, i: int) -> Optional[dict]:
    body = _abody(c)
    rng = _range(c)
    if body < 0.35 * rng and _upper_shadow(c) > 2 * body and _lower_shadow(c) < body * 0.6:
        return {"name": "Shooting Star", "bias": "BEAR", "index": i, "t": c["t"], "reliability": 0.65,
                "notes": "Long upper wick — sellers rejected highs"}
    return None


def _detect_marubozu(c: dict, i: int) -> Optional[dict]:
    body = _abody(c)
    rng = _range(c)
    if body > 0.9 * rng:
        bias = "BULL" if _is_bull(c) else "BEAR"
        return {"name": "Marubozu", "bias": bias, "index": i, "t": c["t"], "reliability": 0.6,
                "notes": "Body fills entire range — strong directional bar"}
    return None


def _detect_spinning_top(c: dict, i: int) -> Optional[dict]:
    body = _abody(c)
    rng = _range(c)
    if (body < 0.35 * rng and _upper_shadow(c) > body and _lower_shadow(c) > body
            and 0.05 * rng < body):
        return {"name": "Spinning Top", "bias": "NEUTRAL", "index": i, "t": c["t"], "reliability": 0.5,
                "notes": "Small body, balanced shadows — indecision"}
    return None


def _detect_engulfing(prev: dict, curr: dict, i: int) -> Optional[dict]:
    if _is_bear(prev) and _is_bull(curr):
        if curr["c"] >= prev["o"] and curr["o"] <= prev["c"] and _abody(curr) > _abody(prev) * 1.1:
            return {"name": "Bullish Engulfing", "bias": "BULL", "index": i, "t": curr["t"],
                    "reliability": 0.72, "notes": "Bull body engulfs prior bear body"}
    if _is_bull(prev) and _is_bear(curr):
        if curr["o"] >= prev["c"] and curr["c"] <= prev["o"] and _abody(curr) > _abody(prev) * 1.1:
            return {"name": "Bearish Engulfing", "bias": "BEAR", "index": i, "t": curr["t"],
                    "reliability": 0.72, "notes": "Bear body engulfs prior bull body"}
    return None


def _detect_harami(prev: dict, curr: dict, i: int) -> Optional[dict]:
    if _abody(curr) < _abody(prev) * 0.6:
        prev_hi = max(prev["o"], prev["c"])
        prev_lo = min(prev["o"], prev["c"])
        curr_hi = max(curr["o"], curr["c"])
        curr_lo = min(curr["o"], curr["c"])
        if curr_hi <= prev_hi and curr_lo >= prev_lo:
            bias = "BULL" if _is_bear(prev) and _is_bull(curr) else "BEAR" if _is_bull(prev) and _is_bear(curr) else "NEUTRAL"
            return {"name": "Harami", "bias": bias, "index": i, "t": curr["t"], "reliability": 0.55,
                    "notes": "Small body inside prior body — momentum pause"}
    return None


def _detect_morning_star(a: dict, b: dict, c: dict, i: int) -> Optional[dict]:
    # Bear, small/doji, bull that closes above midpoint of A.
    if _is_bear(a) and _abody(b) < _abody(a) * 0.4 and _is_bull(c):
        mid_a = (a["o"] + a["c"]) / 2
        if c["c"] > mid_a:
            return {"name": "Morning Star", "bias": "BULL", "index": i, "t": c["t"], "reliability": 0.75,
                    "notes": "3-bar bullish reversal"}
    return None


def _detect_evening_star(a: dict, b: dict, c: dict, i: int) -> Optional[dict]:
    if _is_bull(a) and _abody(b) < _abody(a) * 0.4 and _is_bear(c):
        mid_a = (a["o"] + a["c"]) / 2
        if c["c"] < mid_a:
            return {"name": "Evening Star", "bias": "BEAR", "index": i, "t": c["t"], "reliability": 0.75,
                    "notes": "3-bar bearish reversal"}
    return None


def _detect_three_soldiers(a: dict, b: dict, c: dict, i: int) -> Optional[dict]:
    if _is_bull(a) and _is_bull(b) and _is_bull(c) and c["c"] > b["c"] > a["c"]:
        if min(_abody(a), _abody(b), _abody(c)) > 0.5 * max(_range(a), _range(b), _range(c)):
            return {"name": "Three White Soldiers", "bias": "BULL", "index": i, "t": c["t"], "reliability": 0.72,
                    "notes": "3 consecutive higher bullish bars"}
    return None


def _detect_three_crows(a: dict, b: dict, c: dict, i: int) -> Optional[dict]:
    if _is_bear(a) and _is_bear(b) and _is_bear(c) and c["c"] < b["c"] < a["c"]:
        if min(_abody(a), _abody(b), _abody(c)) > 0.5 * max(_range(a), _range(b), _range(c)):
            return {"name": "Three Black Crows", "bias": "BEAR", "index": i, "t": c["t"], "reliability": 0.72,
                    "notes": "3 consecutive lower bearish bars"}
    return None


def detect_candlestick_patterns(candles: List[dict], lookback: int = 30) -> List[dict]:
    """Scan the last `lookback` bars and return detected candlestick patterns,
    newest first. At most 1 detection per bar (most reliable wins)."""
    if not candles:
        return []
    start = max(0, len(candles) - lookback)
    out: List[dict] = []
    for i in range(start, len(candles)):
        c = candles[i]
        best: Optional[dict] = None
        # 3-bar patterns (priority).
        if i >= 2:
            a3, b3, c3 = candles[i - 2], candles[i - 1], c
            for det in (_detect_morning_star, _detect_evening_star, _detect_three_soldiers, _detect_three_crows):
                d = det(a3, b3, c3, i)
                if d and (best is None or d["reliability"] > best["reliability"]):
                    best = d
        # 2-bar patterns.
        if i >= 1:
            prev = candles[i - 1]
            for det in (_detect_engulfing, _detect_harami):
                d = det(prev, c, i)
                if d and (best is None or d["reliability"] > best["reliability"]):
                    best = d
        # 1-bar patterns.
        for det in (_detect_doji, _detect_hammer, _detect_shooting_star, _detect_marubozu, _detect_spinning_top):
            d = det(c, i)
            if d and (best is None or d["reliability"] > best["reliability"]):
                best = d
        if best:
            out.append(best)
    return list(reversed(out))
