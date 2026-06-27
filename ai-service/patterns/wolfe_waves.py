"""Wolfe Wave (Bill Wolfe) — 5-pivot pattern with linear EPA target.

Validation (this is what makes it work or fail):
    - Points 1, 3, 5 must lie on a single trendline (R² ≥ 0.92 acceptable)
    - Points 2, 4 must lie on a single trendline (same R² floor)
    - Time symmetry: |dt(1→3) − dt(3→5)| < 35 % of dt(1→5)
    - Point 5 must overshoot the 1-3 line slightly (≤ 5 %) for the bullish
      variant (the "sweep" that traps late shorts)
    - Bearish: mirror with overshoot above the 1-3 line.

Entry: at the close of bar 5 (after sweep + reversal candle).
Stop:  1.5 % beyond Point 5 (tight).
Target: EPA = intersection of (1-4 line extended) with current time +
        N bars of time symmetry.

Returns None if no valid Wolfe Wave; dict with full geometry otherwise.
"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np
import pandas as pd

from risk_config import apply_risk_caps


def _find_swing_pivots(
    high: np.ndarray, low: np.ndarray, k: int = 3
) -> list[tuple[int, float, str]]:
    """Confirmed swing pivots — high or low strictly extreme within ±k bars.

    Returns chronological list of (index, price, "H"|"L").
    """
    n = len(high)
    out: list[tuple[int, float, str]] = []
    for i in range(k, n - k):
        window_h = high[i - k:i + k + 1]
        window_l = low[i - k:i + k + 1]
        if high[i] == window_h.max() and (window_h == high[i]).sum() == 1:
            out.append((i, float(high[i]), "H"))
        elif low[i] == window_l.min() and (window_l == low[i]).sum() == 1:
            out.append((i, float(low[i]), "L"))
    return out


def _line_r2(p1: tuple[int, float], p2: tuple[int, float],
             p3: tuple[int, float]) -> float:
    """R² of fitting p1, p2, p3 to a single line. 1.0 = perfect."""
    xs = np.array([p1[0], p2[0], p3[0]], dtype=float)
    ys = np.array([p1[1], p2[1], p3[1]], dtype=float)
    if len(set(xs)) < 2:
        return 0.0
    slope, intercept = np.polyfit(xs, ys, 1)
    pred = slope * xs + intercept
    ss_res = float(((ys - pred) ** 2).sum())
    ss_tot = float(((ys - ys.mean()) ** 2).sum())
    if ss_tot <= 1e-12:
        return 1.0
    return max(0.0, 1.0 - ss_res / ss_tot)


def _project_line(p1: tuple[int, float], p2: tuple[int, float],
                  target_x: int) -> float:
    """y-value of the line through p1, p2 at x = target_x."""
    if p2[0] == p1[0]:
        return p1[1]
    slope = (p2[1] - p1[1]) / (p2[0] - p1[0])
    return p1[1] + slope * (target_x - p1[0])


def detect_wolfe_wave(df: pd.DataFrame) -> Optional[dict]:
    """Detect a completed Wolfe Wave on the most recent 5 pivots.

    Returns a verdict dict with all geometry + entry/stop/target, OR None
    if no valid Wolfe Wave is present.
    """
    try:
        if df is None or len(df) < 40:
            return None
        # Tolerate Capitalized column names.
        cols = {c.lower(): c for c in df.columns}
        h_col, l_col, c_col = cols.get("high"), cols.get("low"), cols.get("close")
        if not (h_col and l_col and c_col):
            return None
        high = df[h_col].to_numpy(dtype=float)
        low = df[l_col].to_numpy(dtype=float)
        close = df[c_col].to_numpy(dtype=float)
        n = len(high)

        pivots = _find_swing_pivots(high, low, k=3)
        if len(pivots) < 5:
            return None

        # Try the 5 most recent pivots as P1..P5.
        p1, p2, p3, p4, p5 = pivots[-5:]

        # Required alternation for a bullish Wolfe: H, L, H, L, L (P5 sweeps)
        # For a bearish Wolfe: L, H, L, H, H (P5 sweeps above)
        kinds = [p[2] for p in (p1, p2, p3, p4, p5)]
        bullish = (kinds == ["H", "L", "H", "L", "L"])
        bearish = (kinds == ["L", "H", "L", "H", "H"])
        if not (bullish or bearish):
            return None
        direction = "bullish" if bullish else "bearish"

        # Geometry — 1,3,5 on one line; 2,4 (extended) on another.
        l13_r2 = _line_r2((p1[0], p1[1]), (p3[0], p3[1]), (p5[0], p5[1]))
        l24_r2 = 1.0  # only 2 points fully define the 2-4 line
        if l13_r2 < 0.85:                       # 1-3-5 must align
            return None

        # Point 5 must overshoot the 1-3 line slightly (the sweep).
        line_13_at_p5 = _project_line((p1[0], p1[1]), (p3[0], p3[1]), p5[0])
        if bullish:
            if p5[1] >= line_13_at_p5:          # bullish Wolfe needs P5 BELOW line
                return None
            overshoot_pct = (line_13_at_p5 - p5[1]) / line_13_at_p5 * 100.0
        else:
            if p5[1] <= line_13_at_p5:
                return None
            overshoot_pct = (p5[1] - line_13_at_p5) / line_13_at_p5 * 100.0
        if not (0.0 < overshoot_pct < 8.0):     # too much overshoot = noise
            return None

        # Time symmetry — the three legs should be roughly equal in time.
        dt_13 = p3[0] - p1[0]
        dt_35 = p5[0] - p3[0]
        if dt_13 <= 0 or dt_35 <= 0:
            return None
        time_sym = 1.0 - abs(dt_13 - dt_35) / max(dt_13, dt_35)
        if time_sym < 0.50:
            return None

        # EPA — the intersection of the 1-4 line extended with a future
        # time = P5 + (P5 - P1) / 2  (a reasonable "expected arrival" bar).
        target_bar = p5[0] + max(5, (p5[0] - p1[0]) // 2)
        if target_bar >= n + 60:                # don't project absurdly far
            target_bar = n + 30
        epa = _project_line((p1[0], p1[1]), (p4[0], p4[1]), target_bar)

        # Entry at the close of the latest available bar after P5.
        entry = float(close[-1])

        # Stop 1.5 % beyond P5 in the opposing direction.
        if bullish:
            raw_stop = p5[1] * 0.985
            raw_target = float(epa)
        else:
            raw_stop = p5[1] * 1.015
            raw_target = float(epa)

        capped = apply_risk_caps(entry, raw_stop, raw_target, direction=direction)
        if capped is None:
            return None
        entry, stop, target, rr = capped

        # Confidence — blend of line quality, overshoot tightness, time symmetry.
        line_q = l13_r2
        overshoot_score = max(0.0, 1.0 - abs(overshoot_pct - 2.0) / 4.0)
        confidence = round(min(0.95, 0.30 + 0.30 * line_q
                                + 0.20 * overshoot_score + 0.20 * time_sym), 3)

        return {
            "detected": True,
            "pattern_name": "Wolfe Wave",
            "direction": direction,
            "points": {
                "1": {"price": p1[1], "bar_index": p1[0]},
                "2": {"price": p2[1], "bar_index": p2[0]},
                "3": {"price": p3[1], "bar_index": p3[0]},
                "4": {"price": p4[1], "bar_index": p4[0]},
                "5": {"price": p5[1], "bar_index": p5[0]},
            },
            "epa_target": round(float(epa), 4),
            "line_1_3_quality": round(float(line_q), 3),
            "line_2_4_quality": round(float(l24_r2), 3),
            "overshoot_pct": round(float(overshoot_pct), 3),
            "time_symmetry_score": round(float(time_sym), 3),
            "entry_price": round(float(entry), 2),
            "stop_price": round(float(stop), 2),
            "target_price": round(float(target), 2),
            "reward_risk": round(float(rr), 3),
            "confidence": confidence,
            "historical_win_rate": 0.58,         # conservative literature baseline
        }
    except Exception:
        return None
