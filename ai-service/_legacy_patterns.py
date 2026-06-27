"""Rule-based chart pattern detection with probability scoring.

These are not deep-learning detectors — they're geometric heuristics over
recent swing pivots. Each detector returns a list of detections with a
score in [0, 1] reflecting how cleanly the pattern matches the rules.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Pivot:
    idx: int
    price: float
    kind: str  # 'H' (high) or 'L' (low)


@dataclass
class Detection:
    pattern: str
    direction: str  # 'BULL' | 'BEAR' | 'NEUTRAL'
    start: int
    end: int
    score: float
    notes: str
    points: List[List[float]]  # [[idx, price], ...]


def find_pivots(highs: List[float], lows: List[float], lookback: int = 3) -> List[Pivot]:
    """Marks a bar as a swing high/low if it is the strict max/min within +/-lookback."""
    pivots: List[Pivot] = []
    n = len(highs)
    for i in range(lookback, n - lookback):
        window_h = highs[i - lookback : i + lookback + 1]
        window_l = lows[i - lookback : i + lookback + 1]
        if highs[i] == max(window_h) and window_h.count(highs[i]) == 1:
            pivots.append(Pivot(i, highs[i], "H"))
        elif lows[i] == min(window_l) and window_l.count(lows[i]) == 1:
            pivots.append(Pivot(i, lows[i], "L"))
    return pivots


def _alt_pivots(pivots: List[Pivot]) -> List[Pivot]:
    """Filter to alternating H/L sequence, keeping the strongest of each run."""
    out: List[Pivot] = []
    for p in pivots:
        if not out or out[-1].kind != p.kind:
            out.append(p)
        else:
            # same kind in a row — keep the more extreme one
            if p.kind == "H" and p.price > out[-1].price:
                out[-1] = p
            elif p.kind == "L" and p.price < out[-1].price:
                out[-1] = p
    return out


def _pct_diff(a: float, b: float) -> float:
    return abs(a - b) / max(abs(a), abs(b), 1e-9)


def detect_double_top(pivots: List[Pivot], closes: List[float]) -> Optional[Detection]:
    highs = [p for p in pivots if p.kind == "H"][-3:]
    if len(highs) < 2:
        return None
    p1, p2 = highs[-2], highs[-1]
    diff = _pct_diff(p1.price, p2.price)
    if diff > 0.02 or p2.idx - p1.idx < 5:
        return None
    intermediate_low = min(closes[p1.idx : p2.idx]) if p2.idx > p1.idx else p1.price
    if intermediate_low >= min(p1.price, p2.price) * 0.985:
        return None
    score = max(0.0, 1.0 - diff * 30) * 0.9
    return Detection(
        pattern="Double Top",
        direction="BEAR",
        start=p1.idx,
        end=p2.idx,
        score=round(score, 3),
        notes=f"Two highs within {diff*100:.2f}% over {p2.idx - p1.idx} bars",
        points=[[p1.idx, p1.price], [p2.idx, p2.price]],
    )


def detect_double_bottom(pivots: List[Pivot], closes: List[float]) -> Optional[Detection]:
    lows = [p for p in pivots if p.kind == "L"][-3:]
    if len(lows) < 2:
        return None
    p1, p2 = lows[-2], lows[-1]
    diff = _pct_diff(p1.price, p2.price)
    if diff > 0.02 or p2.idx - p1.idx < 5:
        return None
    intermediate_high = max(closes[p1.idx : p2.idx]) if p2.idx > p1.idx else p1.price
    if intermediate_high <= max(p1.price, p2.price) * 1.015:
        return None
    score = max(0.0, 1.0 - diff * 30) * 0.9
    return Detection(
        pattern="Double Bottom",
        direction="BULL",
        start=p1.idx,
        end=p2.idx,
        score=round(score, 3),
        notes=f"Two lows within {diff*100:.2f}% over {p2.idx - p1.idx} bars",
        points=[[p1.idx, p1.price], [p2.idx, p2.price]],
    )


def detect_head_and_shoulders(pivots: List[Pivot], lows: List[float], closes: List[float]) -> Optional[Detection]:
    h_pivots = [p for p in pivots if p.kind == "H"]
    if len(h_pivots) < 3:
        return None
    p1, p2, p3 = h_pivots[-3], h_pivots[-2], h_pivots[-1]
    if not (p2.price > p1.price and p2.price > p3.price):
        return None
    shoulder_diff = _pct_diff(p1.price, p3.price)
    head_prominence = (p2.price - max(p1.price, p3.price)) / p2.price
    if shoulder_diff > 0.04 or head_prominence < 0.01:
        return None
    # Neckline = average of the two valleys between the shoulders/head.
    valley_left = min(lows[p1.idx : p2.idx]) if p2.idx > p1.idx else p1.price
    valley_right = min(lows[p2.idx : p3.idx]) if p3.idx > p2.idx else p3.price
    neckline = (valley_left + valley_right) / 2.0
    # Confirmation: price has broken below neckline since the right shoulder.
    confirmed = any(closes[i] < neckline for i in range(p3.idx, len(closes)))
    base_score = max(0.0, 1.0 - shoulder_diff * 15) * min(1.0, head_prominence * 25)
    score = base_score * (1.0 if confirmed else 0.6)
    notes = (
        f"Shoulders match within {shoulder_diff*100:.1f}%, head {head_prominence*100:.1f}% above; "
        f"neckline {'BROKEN' if confirmed else 'intact (unconfirmed)'} at {neckline:.2f}"
    )
    return Detection(
        pattern="Head & Shoulders",
        direction="BEAR",
        start=p1.idx,
        end=p3.idx,
        score=round(min(0.95, score), 3),
        notes=notes,
        points=[[p1.idx, p1.price], [p2.idx, p2.price], [p3.idx, p3.price]],
    )


def detect_inverse_head_and_shoulders(pivots: List[Pivot], highs: List[float], closes: List[float]) -> Optional[Detection]:
    l_pivots = [p for p in pivots if p.kind == "L"]
    if len(l_pivots) < 3:
        return None
    p1, p2, p3 = l_pivots[-3], l_pivots[-2], l_pivots[-1]
    if not (p2.price < p1.price and p2.price < p3.price):
        return None
    shoulder_diff = _pct_diff(p1.price, p3.price)
    head_drop = (max(p1.price, p3.price) - p2.price) / max(p1.price, p3.price)
    if shoulder_diff > 0.04 or head_drop < 0.01:
        return None
    peak_left = max(highs[p1.idx : p2.idx]) if p2.idx > p1.idx else p1.price
    peak_right = max(highs[p2.idx : p3.idx]) if p3.idx > p2.idx else p3.price
    neckline = (peak_left + peak_right) / 2.0
    confirmed = any(closes[i] > neckline for i in range(p3.idx, len(closes)))
    base_score = max(0.0, 1.0 - shoulder_diff * 15) * min(1.0, head_drop * 25)
    score = base_score * (1.0 if confirmed else 0.6)
    notes = (
        f"Shoulders match within {shoulder_diff*100:.1f}%, head {head_drop*100:.1f}% below; "
        f"neckline {'BROKEN' if confirmed else 'intact (unconfirmed)'} at {neckline:.2f}"
    )
    return Detection(
        pattern="Inverse Head & Shoulders",
        direction="BULL",
        start=p1.idx,
        end=p3.idx,
        score=round(min(0.95, score), 3),
        notes=notes,
        points=[[p1.idx, p1.price], [p2.idx, p2.price], [p3.idx, p3.price]],
    )


def detect_triangle(pivots: List[Pivot]) -> Optional[Detection]:
    highs = [p for p in pivots if p.kind == "H"][-3:]
    lows = [p for p in pivots if p.kind == "L"][-3:]
    if len(highs) < 2 or len(lows) < 2:
        return None
    h_slope = (highs[-1].price - highs[0].price) / max(highs[-1].idx - highs[0].idx, 1)
    l_slope = (lows[-1].price - lows[0].price) / max(lows[-1].idx - lows[0].idx, 1)
    span = max(highs[-1].idx, lows[-1].idx) - min(highs[0].idx, lows[0].idx)
    if span < 8:
        return None
    # Slope thresholds must scale with price — a 1e-3 ₹/bar slope is huge for a
    # ₹50 stock and trivial for a ₹3000 stock. Express thresholds as fractions
    # of price-per-bar so detection works across price levels.
    avg_price = (highs[0].price + highs[-1].price + lows[0].price + lows[-1].price) / 4.0
    if avg_price <= 0:
        return None
    slope_signif = 0.001 * avg_price   # 0.1% of price per bar = meaningful slope
    slope_flat = 0.0003 * avg_price    # 0.03% of price per bar = "flat"
    descending = h_slope < -slope_signif and abs(l_slope) < slope_flat
    ascending = abs(h_slope) < slope_flat and l_slope > slope_signif
    symmetric = h_slope < -slope_signif and l_slope > slope_signif
    if descending:
        return Detection(
            pattern="Descending Triangle", direction="BEAR",
            start=min(highs[0].idx, lows[0].idx), end=max(highs[-1].idx, lows[-1].idx),
            score=0.7, notes="Flat support, lower highs",
            points=[[p.idx, p.price] for p in [*highs, *lows]],
        )
    if ascending:
        return Detection(
            pattern="Ascending Triangle", direction="BULL",
            start=min(highs[0].idx, lows[0].idx), end=max(highs[-1].idx, lows[-1].idx),
            score=0.7, notes="Flat resistance, higher lows",
            points=[[p.idx, p.price] for p in [*highs, *lows]],
        )
    if symmetric:
        return Detection(
            pattern="Symmetrical Triangle", direction="NEUTRAL",
            start=min(highs[0].idx, lows[0].idx), end=max(highs[-1].idx, lows[-1].idx),
            score=0.6, notes="Converging trendlines",
            points=[[p.idx, p.price] for p in [*highs, *lows]],
        )
    return None


def detect_wedge(pivots: List[Pivot]) -> Optional[Detection]:
    highs = [p for p in pivots if p.kind == "H"][-3:]
    lows = [p for p in pivots if p.kind == "L"][-3:]
    if len(highs) < 2 or len(lows) < 2:
        return None
    h_slope = (highs[-1].price - highs[0].price) / max(highs[-1].idx - highs[0].idx, 1)
    l_slope = (lows[-1].price - lows[0].price) / max(lows[-1].idx - lows[0].idx, 1)
    avg_price = (highs[0].price + highs[-1].price + lows[0].price + lows[-1].price) / 4.0
    if avg_price <= 0:
        return None
    slope_signif = 0.001 * avg_price   # 0.1% of price per bar
    rising = h_slope > slope_signif and l_slope > slope_signif and l_slope > h_slope
    falling = h_slope < -slope_signif and l_slope < -slope_signif and h_slope < l_slope
    if rising:
        return Detection(
            pattern="Rising Wedge", direction="BEAR",
            start=min(highs[0].idx, lows[0].idx), end=max(highs[-1].idx, lows[-1].idx),
            score=0.55, notes="Both lines rise, lower line steeper",
            points=[[p.idx, p.price] for p in [*highs, *lows]],
        )
    if falling:
        return Detection(
            pattern="Falling Wedge", direction="BULL",
            start=min(highs[0].idx, lows[0].idx), end=max(highs[-1].idx, lows[-1].idx),
            score=0.55, notes="Both lines fall, upper line steeper",
            points=[[p.idx, p.price] for p in [*highs, *lows]],
        )
    return None


def detect_flag(highs: List[float], lows: List[float], closes: List[float]) -> Optional[Detection]:
    """Flag = strong impulsive move followed by short tight consolidation."""
    n = len(closes)
    if n < 25:
        return None
    impulse_end = n - 10
    impulse_start = max(0, impulse_end - 12)
    impulse = closes[impulse_end] - closes[impulse_start]
    impulse_pct = impulse / closes[impulse_start]
    if abs(impulse_pct) < 0.02:
        return None
    cons_window = closes[impulse_end:]
    if not cons_window:
        return None
    cons_range = max(cons_window) - min(cons_window)
    cons_pct = cons_range / closes[impulse_end]
    if cons_pct > abs(impulse_pct) * 0.6:
        return None
    direction = "BULL" if impulse > 0 else "BEAR"
    score = round(min(0.85, 0.4 + abs(impulse_pct) * 8 - cons_pct * 4), 3)
    return Detection(
        pattern="Bull Flag" if direction == "BULL" else "Bear Flag",
        direction=direction,
        start=impulse_start,
        end=n - 1,
        score=max(0.4, score),
        notes=f"Impulse {impulse_pct*100:.1f}% then {cons_pct*100:.1f}% consolidation",
        points=[[impulse_start, closes[impulse_start]], [impulse_end, closes[impulse_end]], [n - 1, closes[-1]]],
    )


def detect_all(candles: List[dict]) -> List[Detection]:
    closes = [float(c["c"]) for c in candles]
    highs = [float(c["h"]) for c in candles]
    lows = [float(c["l"]) for c in candles]
    pivots = _alt_pivots(find_pivots(highs, lows, lookback=3))
    detectors = [
        detect_double_top(pivots, closes),
        detect_double_bottom(pivots, closes),
        detect_head_and_shoulders(pivots, lows, closes),
        detect_inverse_head_and_shoulders(pivots, highs, closes),
        detect_triangle(pivots),
        detect_wedge(pivots),
        detect_flag(highs, lows, closes),
    ]
    return [d for d in detectors if d is not None and d.score > 0.3]
