"""Western chart pattern detectors (10–100 bar windows).

These operate on a longer window and use swing-pivot detection + trendline
fitting. Every detector in this file returns a `PatternResult` extended with:

  - trendline_points: list[{time, price}]  — chart overlay polyline
  - entry_price:   suggested entry (breakout level)
  - target_price:  measured-move target
  - stop_price:    invalidation level
  - risk_reward:   target_distance / stop_distance

The shape rules are intentionally tight (small slope tolerances, minimum
bar spans) to keep false positives down on NSE daily / intraday data.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np
import pandas as pd

from ._helpers import (
    PatternResult,
    Pivot,
    TrendlinePoint,
    abs_body,
    alternating_pivots,
    candle_range,
    empty_result,
    ensure_df,
    find_pivots,
    fit_line,
    is_bear,
    is_bull,
    make_extended_result,
    upper_shadow,
    _val,
)


# ─── shared helpers ─────────────────────────────────────────────────────────

def _idx(df: pd.DataFrame, idx: Optional[int]) -> int:
    return (len(df) - 1) if idx is None else (idx if idx >= 0 else len(df) + idx)


def _point(df: pd.DataFrame, i: int, price: float) -> TrendlinePoint:
    try:
        t = int(df["time"].iloc[i])
    except Exception:
        t = i
    return {"time": t, "price": float(price)}


def _avg_atr(df: pd.DataFrame, window: int = 14) -> float:
    if len(df) < 2:
        return 0.0
    high = df["high"]
    low = df["low"]
    close = df["close"]
    prev_close = close.shift(1)
    tr = pd.concat([(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    return float(tr.tail(window).mean())


def _pivots_window(df: pd.DataFrame, window: int) -> List[Pivot]:
    """Pivots in the last `window` bars only — used to keep pattern recognition
    focused on recent structure."""
    start = max(0, len(df) - window)
    sub = df.iloc[start:].reset_index(drop=True)
    pvs = alternating_pivots(find_pivots(sub, lookback=3))
    # Re-index pivots back to original df coordinates.
    return [Pivot(idx=p.idx + start, price=p.price, kind=p.kind) for p in pvs]


# ─── Flag (parallel pull-back inside a trend) ───────────────────────────────

def _detect_flag(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bull Flag" if direction == "bullish" else "Bear Flag"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, direction)  # type: ignore[arg-type]

    # Identify impulse + consolidation segments. Impulse is the largest run in
    # the last 25 bars; consolidation is the bars after the impulse end.
    impulse_window = 14
    cons_window = 10
    impulse_end = n - cons_window - 1
    impulse_start = max(0, impulse_end - impulse_window)
    impulse_lo = float(df["low"].iloc[impulse_start:impulse_end + 1].min())
    impulse_hi = float(df["high"].iloc[impulse_start:impulse_end + 1].max())
    impulse_pct = (df["close"].iloc[impulse_end] - df["close"].iloc[impulse_start]) / max(df["close"].iloc[impulse_start], 1e-9)

    expected_sign = 1 if direction == "bullish" else -1
    if expected_sign * impulse_pct < 0.025:
        return empty_result(name, direction)  # type: ignore[arg-type]

    cons = df.iloc[impulse_end + 1 :].reset_index(drop=True)
    if len(cons) < 4:
        return empty_result(name, direction)  # type: ignore[arg-type]
    cons_hi = float(cons["high"].max())
    cons_lo = float(cons["low"].min())
    cons_range_pct = (cons_hi - cons_lo) / max(impulse_hi - impulse_lo, 1e-9)
    if cons_range_pct > 0.6:
        return empty_result(name, direction)  # type: ignore[arg-type]

    # Fit upper + lower trendlines through the consolidation.
    xs = np.arange(len(cons), dtype=float)
    upper_pts = list(zip(xs.tolist(), cons["high"].astype(float).tolist()))
    lower_pts = list(zip(xs.tolist(), cons["low"].astype(float).tolist()))
    m_up, b_up = fit_line(upper_pts)
    m_lo, b_lo = fit_line(lower_pts)
    # Flag = roughly parallel; slope of the channel should oppose the impulse.
    if direction == "bullish" and (m_up >= 0 or m_lo >= 0):
        return empty_result(name, direction)  # type: ignore[arg-type]
    if direction == "bearish" and (m_up <= 0 or m_lo <= 0):
        return empty_result(name, direction)  # type: ignore[arg-type]
    slope_diff = abs(m_up - m_lo) / max(abs(m_up) + abs(m_lo), 1e-6)
    if slope_diff > 0.5:  # too divergent to call parallel
        return empty_result(name, direction)  # type: ignore[arg-type]

    impulse_size = abs(df["close"].iloc[impulse_end] - df["close"].iloc[impulse_start])
    last = float(df["close"].iloc[-1])
    if direction == "bullish":
        entry = float(cons_hi)
        target = entry + impulse_size
        stop = float(cons_lo)
    else:
        entry = float(cons_lo)
        target = entry - impulse_size
        stop = float(cons_hi)

    # Build trendline points to overlay on chart.
    tps: List[TrendlinePoint] = [
        _point(df, impulse_start, float(df["close"].iloc[impulse_start])),
        _point(df, impulse_end, float(df["close"].iloc[impulse_end])),
        _point(df, impulse_end + 1, m_up * 0 + b_up),
        _point(df, n - 1, m_up * (len(cons) - 1) + b_up),
        _point(df, impulse_end + 1, m_lo * 0 + b_lo),
        _point(df, n - 1, m_lo * (len(cons) - 1) + b_lo),
    ]
    strength = min(1.0, 0.45 + min(abs(impulse_pct), 0.12) * 4 - cons_range_pct * 0.3)
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=list(range(impulse_start, n)),
        strength=strength,
        description=(
            f"Impulse of {impulse_pct * 100:.1f}% followed by a tight {('descending' if direction == 'bullish' else 'ascending')} "
            f"channel of {cons_range_pct * 100:.1f}% pullback — classic continuation pattern."
        ),
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bull_flag(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_flag(df, "bullish")


def detect_bear_flag(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_flag(df, "bearish")


# ─── Pennant (impulse + small symmetrical triangle) ─────────────────────────

def _detect_pennant(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bull Pennant" if direction == "bullish" else "Bear Pennant"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, direction)  # type: ignore[arg-type]
    impulse_window = 14
    cons_window = 10
    impulse_end = n - cons_window - 1
    impulse_start = max(0, impulse_end - impulse_window)
    impulse_pct = (df["close"].iloc[impulse_end] - df["close"].iloc[impulse_start]) / max(df["close"].iloc[impulse_start], 1e-9)
    expected_sign = 1 if direction == "bullish" else -1
    if expected_sign * impulse_pct < 0.025:
        return empty_result(name, direction)  # type: ignore[arg-type]

    cons = df.iloc[impulse_end + 1 :].reset_index(drop=True)
    if len(cons) < 4:
        return empty_result(name, direction)  # type: ignore[arg-type]
    xs = np.arange(len(cons), dtype=float)
    m_up, b_up = fit_line(list(zip(xs.tolist(), cons["high"].astype(float).tolist())))
    m_lo, b_lo = fit_line(list(zip(xs.tolist(), cons["low"].astype(float).tolist())))
    # Pennant = converging (upper slope down, lower slope up).
    if m_up >= 0 or m_lo <= 0:
        return empty_result(name, direction)  # type: ignore[arg-type]

    impulse_size = abs(df["close"].iloc[impulse_end] - df["close"].iloc[impulse_start])
    cons_hi = float(cons["high"].max())
    cons_lo = float(cons["low"].min())
    if direction == "bullish":
        entry = float(cons_hi)
        target = entry + impulse_size
        stop = float(cons_lo)
    else:
        entry = float(cons_lo)
        target = entry - impulse_size
        stop = float(cons_hi)
    tps = [
        _point(df, impulse_start, float(df["close"].iloc[impulse_start])),
        _point(df, impulse_end, float(df["close"].iloc[impulse_end])),
        _point(df, impulse_end + 1, b_up),
        _point(df, n - 1, m_up * (len(cons) - 1) + b_up),
        _point(df, impulse_end + 1, b_lo),
        _point(df, n - 1, m_lo * (len(cons) - 1) + b_lo),
    ]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=list(range(impulse_start, n)),
        strength=min(1.0, 0.45 + min(abs(impulse_pct), 0.12) * 4),
        description=(
            f"Impulse of {impulse_pct * 100:.1f}% then a small converging triangle — pennant continuation."
        ),
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bull_pennant(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_pennant(df, "bullish")


def detect_bear_pennant(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_pennant(df, "bearish")


# ─── Triangles ──────────────────────────────────────────────────────────────

def _triangle_lines(pivots: List[Pivot]) -> Optional[Tuple[float, float, float, float, List[Pivot], List[Pivot]]]:
    highs = [p for p in pivots if p.kind == "H"][-3:]
    lows = [p for p in pivots if p.kind == "L"][-3:]
    if len(highs) < 2 or len(lows) < 2:
        return None
    m_h, b_h = fit_line([(p.idx, p.price) for p in highs])
    m_l, b_l = fit_line([(p.idx, p.price) for p in lows])
    return m_h, b_h, m_l, b_l, highs, lows


def detect_ascending_triangle(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Ascending Triangle"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "bullish")
    pvs = _pivots_window(df, min(n, 80))
    res = _triangle_lines(pvs)
    if not res:
        return empty_result(name, "bullish")
    m_h, b_h, m_l, b_l, highs, lows = res
    # Flat resistance + rising lows
    avg_price = float(df["close"].iloc[-1])
    if avg_price <= 0:
        return empty_result(name, "bullish")
    slope_tol = avg_price * 1e-4
    if abs(m_h) > slope_tol or m_l < slope_tol * 2:
        return empty_result(name, "bullish")
    height = max(p.price for p in highs) - min(p.price for p in lows)
    entry = float(max(p.price for p in highs))
    target = entry + height
    stop = float(min(p.price for p in lows[-2:]))
    tps = [highs[0].as_point(df), highs[-1].as_point(df), lows[0].as_point(df), lows[-1].as_point(df)]
    return make_extended_result(
        name,
        direction="bullish",
        indices=list(range(min(highs[0].idx, lows[0].idx), n)),
        strength=0.66,
        description="Flat resistance with rising lows — bullish accumulation; breakout above resistance targets the pattern height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_descending_triangle(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Descending Triangle"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "bearish")
    pvs = _pivots_window(df, min(n, 80))
    res = _triangle_lines(pvs)
    if not res:
        return empty_result(name, "bearish")
    m_h, b_h, m_l, b_l, highs, lows = res
    avg_price = float(df["close"].iloc[-1])
    if avg_price <= 0:
        return empty_result(name, "bearish")
    slope_tol = avg_price * 1e-4
    if abs(m_l) > slope_tol or m_h > -slope_tol * 2:
        return empty_result(name, "bearish")
    height = max(p.price for p in highs) - min(p.price for p in lows)
    entry = float(min(p.price for p in lows))
    target = entry - height
    stop = float(max(p.price for p in highs[-2:]))
    tps = [highs[0].as_point(df), highs[-1].as_point(df), lows[0].as_point(df), lows[-1].as_point(df)]
    return make_extended_result(
        name,
        direction="bearish",
        indices=list(range(min(highs[0].idx, lows[0].idx), n)),
        strength=0.62,
        description="Flat support with lower highs — bearish distribution; breakdown below support targets the pattern height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_symmetrical_triangle(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Symmetrical Triangle"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "continuation")
    pvs = _pivots_window(df, min(n, 80))
    res = _triangle_lines(pvs)
    if not res:
        return empty_result(name, "continuation")
    m_h, b_h, m_l, b_l, highs, lows = res
    avg_price = float(df["close"].iloc[-1])
    slope_tol = avg_price * 1e-4
    if m_h > -slope_tol or m_l < slope_tol:
        return empty_result(name, "continuation")
    height = max(p.price for p in highs) - min(p.price for p in lows)
    last = float(df["close"].iloc[-1])
    # Direction is decided by the prior swing leading into the triangle.
    pivot_start = min(highs[0].idx, lows[0].idx)
    prior_close = float(df["close"].iloc[max(0, pivot_start - 5)])
    going_up = last >= prior_close
    direction = "bullish" if going_up else "bearish"
    if going_up:
        entry = float(max(p.price for p in highs))
        target = entry + height
        stop = float(min(p.price for p in lows[-2:]))
    else:
        entry = float(min(p.price for p in lows))
        target = entry - height
        stop = float(max(p.price for p in highs[-2:]))
    tps = [highs[0].as_point(df), highs[-1].as_point(df), lows[0].as_point(df), lows[-1].as_point(df)]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=list(range(pivot_start, n)),
        strength=0.55,
        description="Converging trendlines from lower highs and higher lows — continuation in the direction of the prior swing.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Wedges ────────────────────────────────────────────────────────────────

def detect_rising_wedge(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Rising Wedge"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "bearish")
    pvs = _pivots_window(df, min(n, 80))
    res = _triangle_lines(pvs)
    if not res:
        return empty_result(name, "bearish")
    m_h, b_h, m_l, b_l, highs, lows = res
    # Both lines rise, lower steeper than upper.
    if m_h <= 0 or m_l <= 0 or m_l <= m_h:
        return empty_result(name, "bearish")
    height = max(p.price for p in highs[-2:]) - min(p.price for p in lows[-2:])
    entry = float(min(p.price for p in lows[-2:]))  # breakdown level
    target = entry - height
    stop = float(max(p.price for p in highs[-2:]))
    tps = [highs[0].as_point(df), highs[-1].as_point(df), lows[0].as_point(df), lows[-1].as_point(df)]
    return make_extended_result(
        name,
        direction="bearish",
        indices=list(range(min(highs[0].idx, lows[0].idx), n)),
        strength=0.60,
        description="Both trendlines rise but lows rise faster than highs — exhaustion; breakdown is the expected resolution.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_falling_wedge(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Falling Wedge"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "bullish")
    pvs = _pivots_window(df, min(n, 80))
    res = _triangle_lines(pvs)
    if not res:
        return empty_result(name, "bullish")
    m_h, b_h, m_l, b_l, highs, lows = res
    if m_h >= 0 or m_l >= 0 or m_h <= m_l:
        return empty_result(name, "bullish")
    height = max(p.price for p in highs[-2:]) - min(p.price for p in lows[-2:])
    entry = float(max(p.price for p in highs[-2:]))  # breakout level
    target = entry + height
    stop = float(min(p.price for p in lows[-2:]))
    tps = [highs[0].as_point(df), highs[-1].as_point(df), lows[0].as_point(df), lows[-1].as_point(df)]
    return make_extended_result(
        name,
        direction="bullish",
        indices=list(range(min(highs[0].idx, lows[0].idx), n)),
        strength=0.62,
        description="Both trendlines fall but highs fall faster than lows — selling exhausting; breakout is the expected resolution.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Channels ──────────────────────────────────────────────────────────────

def _detect_channel(df: pd.DataFrame, kind: str) -> PatternResult:
    name_map = {"asc": "Ascending Channel", "desc": "Descending Channel", "flat": "Horizontal Channel"}
    direction_map = {"asc": "bullish", "desc": "bearish", "flat": "neutral"}
    name = name_map[kind]
    direction = direction_map[kind]
    df = ensure_df(df)
    n = len(df)
    if n < 30:
        return empty_result(name, direction)  # type: ignore[arg-type]
    pvs = _pivots_window(df, min(n, 80))
    highs = [p for p in pvs if p.kind == "H"][-3:]
    lows = [p for p in pvs if p.kind == "L"][-3:]
    if len(highs) < 2 or len(lows) < 2:
        return empty_result(name, direction)  # type: ignore[arg-type]
    m_h, b_h = fit_line([(p.idx, p.price) for p in highs])
    m_l, b_l = fit_line([(p.idx, p.price) for p in lows])
    last = float(df["close"].iloc[-1])
    slope_tol = last * 5e-4

    parallel = abs(m_h - m_l) <= max(abs(m_h), abs(m_l), 1e-9) * 0.5
    if not parallel:
        return empty_result(name, direction)  # type: ignore[arg-type]

    if kind == "asc" and not (m_h > slope_tol and m_l > slope_tol):
        return empty_result(name, direction)  # type: ignore[arg-type]
    if kind == "desc" and not (m_h < -slope_tol and m_l < -slope_tol):
        return empty_result(name, direction)  # type: ignore[arg-type]
    if kind == "flat" and (abs(m_h) > slope_tol or abs(m_l) > slope_tol):
        return empty_result(name, direction)  # type: ignore[arg-type]

    # Trade the channel boundary — assume continuation of the current swing.
    height = (m_h * highs[-1].idx + b_h) - (m_l * lows[-1].idx + b_l)
    if direction == "bullish":
        entry = last
        target = entry + height
        stop = m_l * (n - 1) + b_l
    elif direction == "bearish":
        entry = last
        target = entry - height
        stop = m_h * (n - 1) + b_h
    else:  # flat
        # Buy lower band, target upper band.
        entry = m_l * (n - 1) + b_l
        target = m_h * (n - 1) + b_h
        stop = entry - height * 0.3
    tps = [highs[0].as_point(df), highs[-1].as_point(df), lows[0].as_point(df), lows[-1].as_point(df)]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=list(range(min(highs[0].idx, lows[0].idx), n)),
        strength=0.55,
        description=f"Parallel {kind}ending trendlines forming a channel — trade the boundaries.",
        entry_price=float(entry),
        target_price=float(target),
        stop_price=float(stop),
        trendline_points=tps,
    )


def detect_ascending_channel(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_channel(df, "asc")


def detect_descending_channel(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_channel(df, "desc")


def detect_horizontal_channel(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_channel(df, "flat")


# ─── Cup & Handle (+ Inverse) ──────────────────────────────────────────────

def _cup_metrics(close: pd.Series) -> Tuple[float, int, float, float]:
    """Return (depth_pct, trough_idx, cup_high, cup_low)."""
    n = len(close)
    cup_high = float(close.iloc[0])
    cup_low = float(close.min())
    trough_idx = int(close.idxmin())
    end_high = float(close.iloc[-1])
    rim_low = min(cup_high, end_high)
    depth = (rim_low - cup_low) / max(rim_low, 1e-9)
    # Symmetry: trough roughly in the middle third.
    if not (n // 4 <= trough_idx <= 3 * n // 4):
        return 0.0, trough_idx, cup_high, cup_low
    return depth, trough_idx, max(cup_high, end_high), cup_low


def detect_cup_and_handle(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Cup and Handle"
    df = ensure_df(df)
    n = len(df)
    if n < 40:
        return empty_result(name, "bullish")
    # Cup = first 75% of window; handle = last 25%.
    cup_end = int(n * 0.75)
    handle = df.iloc[cup_end:].reset_index(drop=True)
    cup = df.iloc[:cup_end].reset_index(drop=True)
    depth, trough_idx, cup_high, cup_low = _cup_metrics(cup["close"])
    if depth < 0.05 or depth > 0.35:
        return empty_result(name, "bullish")
    # Handle is a small downward drift (≤ 1/3 cup depth).
    h_high = float(handle["high"].max())
    h_low = float(handle["low"].min())
    handle_depth = (h_high - h_low) / max(h_high, 1e-9)
    if handle_depth < 0.005 or handle_depth > depth / 2:
        return empty_result(name, "bullish")
    # Handle must stay above cup midpoint.
    if h_low < (cup_high + cup_low) / 2:
        return empty_result(name, "bullish")
    height = cup_high - cup_low
    entry = float(cup_high)
    target = entry + height
    stop = float(h_low)
    tps = [
        _point(df, 0, float(cup["close"].iloc[0])),
        _point(df, trough_idx, float(cup_low)),
        _point(df, cup_end - 1, float(cup["close"].iloc[-1])),
        _point(df, n - 1, float(handle["close"].iloc[-1])),
    ]
    return make_extended_result(
        name,
        direction="bullish",
        indices=list(range(0, n)),
        strength=0.65,
        description=f"U-shaped basing of {depth * 100:.1f}% depth with a {handle_depth * 100:.1f}% handle pullback — breakout above cup rim targets the cup height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_inverse_cup_and_handle(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Inverse Cup and Handle"
    df = ensure_df(df)
    n = len(df)
    if n < 40:
        return empty_result(name, "bearish")
    cup_end = int(n * 0.75)
    handle = df.iloc[cup_end:].reset_index(drop=True)
    cup = df.iloc[:cup_end].reset_index(drop=True)
    # Mirror via 1/x — easier: invert the close series for shape detection.
    inv = -cup["close"]
    inv = inv - inv.min() + 1.0  # keep positive
    depth, trough_idx, _hi, _lo = _cup_metrics(inv)
    if depth < 0.05 or depth > 0.35:
        return empty_result(name, "bearish")
    cup_low = float(cup["close"].min())
    cup_high = float(cup["close"].max())
    h_high = float(handle["high"].max())
    h_low = float(handle["low"].min())
    handle_depth = (h_high - h_low) / max(h_high, 1e-9)
    if handle_depth < 0.005 or handle_depth > depth / 2:
        return empty_result(name, "bearish")
    if h_high > (cup_high + cup_low) / 2:
        return empty_result(name, "bearish")
    height = cup_high - cup_low
    entry = float(cup_low)
    target = entry - height
    stop = float(h_high)
    tps = [
        _point(df, 0, float(cup["close"].iloc[0])),
        _point(df, trough_idx, float(cup_high)),
        _point(df, cup_end - 1, float(cup["close"].iloc[-1])),
        _point(df, n - 1, float(handle["close"].iloc[-1])),
    ]
    return make_extended_result(
        name,
        direction="bearish",
        indices=list(range(0, n)),
        strength=0.60,
        description="Inverted U-shaped distribution with a small rebound handle — breakdown targets the pattern height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Head & Shoulders (+ Inverse) ──────────────────────────────────────────

def detect_head_and_shoulders(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Head and Shoulders"
    df = ensure_df(df)
    n = len(df)
    if n < 30:
        return empty_result(name, "bearish")
    pvs = _pivots_window(df, min(n, 80))
    highs = [p for p in pvs if p.kind == "H"]
    lows = [p for p in pvs if p.kind == "L"]
    if len(highs) < 3 or len(lows) < 2:
        return empty_result(name, "bearish")
    p1, p2, p3 = highs[-3], highs[-2], highs[-1]
    if not (p2.price > p1.price and p2.price > p3.price):
        return empty_result(name, "bearish")
    shoulder_diff = abs(p1.price - p3.price) / max(p1.price, p3.price, 1e-9)
    head_prom = (p2.price - max(p1.price, p3.price)) / p2.price
    if shoulder_diff > 0.05 or head_prom < 0.01:
        return empty_result(name, "bearish")
    # Neckline through the two troughs between the three peaks.
    troughs = [l for l in lows if p1.idx < l.idx < p3.idx]
    if len(troughs) < 2:
        return empty_result(name, "bearish")
    t1, t2 = troughs[-2], troughs[-1]
    m, b = fit_line([(t1.idx, t1.price), (t2.idx, t2.price)])
    neckline_now = m * (n - 1) + b
    height = p2.price - neckline_now
    if height <= 0:
        return empty_result(name, "bearish")
    entry = float(neckline_now)
    target = entry - height
    stop = float(p2.price)
    tps = [p1.as_point(df), p2.as_point(df), p3.as_point(df), t1.as_point(df), t2.as_point(df)]
    return make_extended_result(
        name,
        direction="bearish",
        indices=list(range(p1.idx, n)),
        strength=min(0.95, 0.55 + (1 - shoulder_diff * 15) * 0.25 + head_prom * 5),
        description=f"Three peaks with the middle highest; shoulders within {shoulder_diff * 100:.1f}%; breakdown below neckline targets the head height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_inverse_head_and_shoulders(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Inverse Head and Shoulders"
    df = ensure_df(df)
    n = len(df)
    if n < 30:
        return empty_result(name, "bullish")
    pvs = _pivots_window(df, min(n, 80))
    highs = [p for p in pvs if p.kind == "H"]
    lows = [p for p in pvs if p.kind == "L"]
    if len(lows) < 3 or len(highs) < 2:
        return empty_result(name, "bullish")
    p1, p2, p3 = lows[-3], lows[-2], lows[-1]
    if not (p2.price < p1.price and p2.price < p3.price):
        return empty_result(name, "bullish")
    shoulder_diff = abs(p1.price - p3.price) / max(p1.price, p3.price, 1e-9)
    head_prom = (min(p1.price, p3.price) - p2.price) / max(p1.price, p3.price)
    if shoulder_diff > 0.05 or head_prom < 0.01:
        return empty_result(name, "bullish")
    peaks = [h for h in highs if p1.idx < h.idx < p3.idx]
    if len(peaks) < 2:
        return empty_result(name, "bullish")
    t1, t2 = peaks[-2], peaks[-1]
    m, b = fit_line([(t1.idx, t1.price), (t2.idx, t2.price)])
    neckline_now = m * (n - 1) + b
    height = neckline_now - p2.price
    if height <= 0:
        return empty_result(name, "bullish")
    entry = float(neckline_now)
    target = entry + height
    stop = float(p2.price)
    tps = [p1.as_point(df), p2.as_point(df), p3.as_point(df), t1.as_point(df), t2.as_point(df)]
    return make_extended_result(
        name,
        direction="bullish",
        indices=list(range(p1.idx, n)),
        strength=min(0.95, 0.55 + (1 - shoulder_diff * 15) * 0.25 + head_prom * 5),
        description=f"Three troughs with the middle lowest; shoulders within {shoulder_diff * 100:.1f}%; breakout above neckline targets the head depth.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Double / Triple Top + Bottom ──────────────────────────────────────────

def detect_double_top(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Double Top"
    df = ensure_df(df)
    n = len(df)
    if n < 20:
        return empty_result(name, "bearish")
    pvs = _pivots_window(df, min(n, 80))
    highs = [p for p in pvs if p.kind == "H"][-3:]
    lows = [p for p in pvs if p.kind == "L"]
    if len(highs) < 2:
        return empty_result(name, "bearish")
    p1, p2 = highs[-2], highs[-1]
    diff = abs(p1.price - p2.price) / max(p1.price, p2.price, 1e-9)
    if diff > 0.02 or (p2.idx - p1.idx) < 5:
        return empty_result(name, "bearish")
    intermediate = [l for l in lows if p1.idx < l.idx < p2.idx]
    if not intermediate:
        return empty_result(name, "bearish")
    trough = min(intermediate, key=lambda l: l.price)
    if trough.price > min(p1.price, p2.price) * 0.985:
        return empty_result(name, "bearish")
    height = ((p1.price + p2.price) / 2) - trough.price
    entry = float(trough.price)
    target = entry - height
    stop = float(max(p1.price, p2.price))
    tps = [p1.as_point(df), trough.as_point(df), p2.as_point(df)]
    return make_extended_result(
        name,
        direction="bearish",
        indices=list(range(p1.idx, n)),
        strength=max(0.0, 1.0 - diff * 30) * 0.9,
        description=f"Two peaks within {diff * 100:.2f}% with intermediate trough — breakdown below trough targets the pattern height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_double_bottom(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Double Bottom"
    df = ensure_df(df)
    n = len(df)
    if n < 20:
        return empty_result(name, "bullish")
    pvs = _pivots_window(df, min(n, 80))
    lows = [p for p in pvs if p.kind == "L"][-3:]
    highs = [p for p in pvs if p.kind == "H"]
    if len(lows) < 2:
        return empty_result(name, "bullish")
    p1, p2 = lows[-2], lows[-1]
    diff = abs(p1.price - p2.price) / max(p1.price, p2.price, 1e-9)
    if diff > 0.02 or (p2.idx - p1.idx) < 5:
        return empty_result(name, "bullish")
    intermediate = [h for h in highs if p1.idx < h.idx < p2.idx]
    if not intermediate:
        return empty_result(name, "bullish")
    peak = max(intermediate, key=lambda h: h.price)
    if peak.price < max(p1.price, p2.price) * 1.015:
        return empty_result(name, "bullish")
    height = peak.price - ((p1.price + p2.price) / 2)
    entry = float(peak.price)
    target = entry + height
    stop = float(min(p1.price, p2.price))
    tps = [p1.as_point(df), peak.as_point(df), p2.as_point(df)]
    return make_extended_result(
        name,
        direction="bullish",
        indices=list(range(p1.idx, n)),
        strength=max(0.0, 1.0 - diff * 30) * 0.9,
        description=f"Two troughs within {diff * 100:.2f}% with intermediate peak — breakout above peak targets the pattern height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_triple_top(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Triple Top"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "bearish")
    pvs = _pivots_window(df, min(n, 100))
    highs = [p for p in pvs if p.kind == "H"][-4:]
    lows = [p for p in pvs if p.kind == "L"]
    if len(highs) < 3:
        return empty_result(name, "bearish")
    p1, p2, p3 = highs[-3], highs[-2], highs[-1]
    span = max(p1.price, p2.price, p3.price) - min(p1.price, p2.price, p3.price)
    if span / max(p1.price, p2.price, p3.price) > 0.02:
        return empty_result(name, "bearish")
    troughs = [l for l in lows if p1.idx < l.idx < p3.idx]
    if not troughs:
        return empty_result(name, "bearish")
    support = min(troughs, key=lambda l: l.price)
    height = max(p1.price, p2.price, p3.price) - support.price
    entry = float(support.price)
    target = entry - height
    stop = float(max(p1.price, p2.price, p3.price))
    tps = [p1.as_point(df), p2.as_point(df), p3.as_point(df), support.as_point(df)]
    return make_extended_result(
        name,
        direction="bearish",
        indices=list(range(p1.idx, n)),
        strength=0.60,
        description="Three peaks at similar levels with shared support trough — breakdown signals top.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_triple_bottom(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Triple Bottom"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "bullish")
    pvs = _pivots_window(df, min(n, 100))
    lows = [p for p in pvs if p.kind == "L"][-4:]
    highs = [p for p in pvs if p.kind == "H"]
    if len(lows) < 3:
        return empty_result(name, "bullish")
    p1, p2, p3 = lows[-3], lows[-2], lows[-1]
    span = max(p1.price, p2.price, p3.price) - min(p1.price, p2.price, p3.price)
    if span / max(p1.price, p2.price, p3.price) > 0.02:
        return empty_result(name, "bullish")
    peaks = [h for h in highs if p1.idx < h.idx < p3.idx]
    if not peaks:
        return empty_result(name, "bullish")
    resistance = max(peaks, key=lambda h: h.price)
    height = resistance.price - min(p1.price, p2.price, p3.price)
    entry = float(resistance.price)
    target = entry + height
    stop = float(min(p1.price, p2.price, p3.price))
    tps = [p1.as_point(df), p2.as_point(df), p3.as_point(df), resistance.as_point(df)]
    return make_extended_result(
        name,
        direction="bullish",
        indices=list(range(p1.idx, n)),
        strength=0.62,
        description="Three troughs at similar levels with shared resistance peak — breakout signals bottom.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Rounding Top / Bottom ──────────────────────────────────────────────────

def _rounding_score(close: pd.Series, curvature_sign: int) -> float:
    """Return how well `close` follows a quadratic with the requested curvature.
    +1 for bottom (concave up), -1 for top (concave down). Score in [0,1]."""
    xs = np.arange(len(close), dtype=float)
    if len(close) < 8:
        return 0.0
    coefs = np.polyfit(xs, close.astype(float), 2)
    if np.sign(coefs[0]) != np.sign(curvature_sign):
        return 0.0
    fit = np.polyval(coefs, xs)
    ss_res = float(((close.values - fit) ** 2).sum())
    ss_tot = float(((close.values - close.mean()) ** 2).sum())
    if ss_tot <= 0:
        return 0.0
    r2 = 1.0 - (ss_res / ss_tot)
    return max(0.0, min(1.0, r2))


def detect_rounding_bottom(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Rounding Bottom"
    df = ensure_df(df)
    n = len(df)
    if n < 30:
        return empty_result(name, "bullish")
    window = df.iloc[max(0, n - 60):]
    r2 = _rounding_score(window["close"], +1)
    if r2 < 0.55:
        return empty_result(name, "bullish")
    cup_low = float(window["low"].min())
    cup_high = float(window["close"].iloc[-1])  # current price acts as rim
    rim = max(float(window["close"].iloc[0]), cup_high)
    if rim <= cup_low:
        return empty_result(name, "bullish")
    height = rim - cup_low
    entry = float(rim)
    target = entry + height
    stop = cup_low
    tps = [
        _point(df, n - len(window), float(window["close"].iloc[0])),
        _point(df, int(window["low"].idxmin()), cup_low),
        _point(df, n - 1, float(window["close"].iloc[-1])),
    ]
    return make_extended_result(
        name,
        direction="bullish",
        indices=list(range(n - len(window), n)),
        strength=0.50 + 0.30 * r2,
        description=f"Smooth U-shaped basing (R²={r2:.2f}) — breakout above the rim targets the pattern depth.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_rounding_top(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Rounding Top"
    df = ensure_df(df)
    n = len(df)
    if n < 30:
        return empty_result(name, "bearish")
    window = df.iloc[max(0, n - 60):]
    r2 = _rounding_score(window["close"], -1)
    if r2 < 0.55:
        return empty_result(name, "bearish")
    cup_high = float(window["high"].max())
    rim = min(float(window["close"].iloc[0]), float(window["close"].iloc[-1]))
    if rim >= cup_high:
        return empty_result(name, "bearish")
    height = cup_high - rim
    entry = float(rim)
    target = entry - height
    stop = cup_high
    tps = [
        _point(df, n - len(window), float(window["close"].iloc[0])),
        _point(df, int(window["high"].idxmax()), cup_high),
        _point(df, n - 1, float(window["close"].iloc[-1])),
    ]
    return make_extended_result(
        name,
        direction="bearish",
        indices=list(range(n - len(window), n)),
        strength=0.45 + 0.25 * r2,
        description=f"Smooth inverted-U distribution (R²={r2:.2f}) — breakdown below the rim targets the pattern height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Rectangle (range) ─────────────────────────────────────────────────────

def detect_rectangle(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Rectangle"
    df = ensure_df(df)
    n = len(df)
    if n < 20:
        return empty_result(name, "neutral")
    pvs = _pivots_window(df, min(n, 60))
    highs = [p for p in pvs if p.kind == "H"][-3:]
    lows = [p for p in pvs if p.kind == "L"][-3:]
    if len(highs) < 2 or len(lows) < 2:
        return empty_result(name, "neutral")
    hi_max = max(p.price for p in highs)
    hi_min = min(p.price for p in highs)
    lo_max = max(p.price for p in lows)
    lo_min = min(p.price for p in lows)
    # All highs cluster + all lows cluster.
    if (hi_max - hi_min) / max(hi_max, 1e-9) > 0.01:
        return empty_result(name, "neutral")
    if (lo_max - lo_min) / max(lo_max, 1e-9) > 0.01:
        return empty_result(name, "neutral")
    top = (hi_max + hi_min) / 2
    bot = (lo_max + lo_min) / 2
    height = top - bot
    last = float(df["close"].iloc[-1])
    if last >= (top + bot) / 2:
        direction = "bullish"
        entry = top
        target = entry + height
        stop = bot
    else:
        direction = "bearish"
        entry = bot
        target = entry - height
        stop = top
    tps = [highs[0].as_point(df), highs[-1].as_point(df), lows[0].as_point(df), lows[-1].as_point(df)]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=list(range(min(highs[0].idx, lows[0].idx), n)),
        strength=0.55,
        description="Price oscillates inside a horizontal range — trade the breakout direction, target the range height.",
        entry_price=float(entry),
        target_price=float(target),
        stop_price=float(stop),
        trendline_points=tps,
    )


# ─── Island Reversal ──────────────────────────────────────────────────────

def _detect_island_reversal(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Island Reversal" if direction == "bullish" else "Bearish Island Reversal"
    df = ensure_df(df)
    n = len(df)
    if n < 6:
        return empty_result(name, direction)  # type: ignore[arg-type]
    # Walk back to find a gap that isolates an island of 1-5 bars from a counter gap.
    for island_start in range(n - 6, max(0, n - 25), -1):
        prev = df.iloc[island_start - 1]
        island_open = df.iloc[island_start]
        if direction == "bullish":
            # Gap down into island.
            if _val(island_open, "high") >= _val(prev, "low"):
                continue
        else:
            if _val(island_open, "low") <= _val(prev, "high"):
                continue
        for island_end in range(island_start, min(n - 1, island_start + 6)):
            after = df.iloc[island_end + 1]
            island_close = df.iloc[island_end]
            if direction == "bullish":
                # Gap up out of island.
                if _val(after, "low") <= _val(island_close, "high"):
                    continue
            else:
                if _val(after, "high") >= _val(island_close, "low"):
                    continue
            # Reasonable island bar count (≥1) and isolation confirmed.
            island_hi = float(df["high"].iloc[island_start:island_end + 1].max())
            island_lo = float(df["low"].iloc[island_start:island_end + 1].min())
            height = island_hi - island_lo
            if direction == "bullish":
                entry = float(_val(after, "open"))
                target = entry + height * 2
                stop = island_lo
            else:
                entry = float(_val(after, "open"))
                target = entry - height * 2
                stop = island_hi
            tps = [
                _point(df, island_start - 1, float(_val(prev, "close"))),
                _point(df, island_start, float(_val(island_open, "open"))),
                _point(df, island_end, float(_val(island_close, "close"))),
                _point(df, island_end + 1, float(_val(after, "open"))),
            ]
            return make_extended_result(
                name,
                direction=direction,  # type: ignore[arg-type]
                indices=list(range(island_start - 1, island_end + 2)),
                strength=0.62,
                description=f"Cluster of {island_end - island_start + 1} bars isolated by gaps on both sides — sharp sentiment flip; rare and powerful.",
                entry_price=entry,
                target_price=target,
                stop_price=stop,
                trendline_points=tps,
            )
    return empty_result(name, direction)  # type: ignore[arg-type]


def detect_bullish_island_reversal(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_island_reversal(df, "bullish")


def detect_bearish_island_reversal(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_island_reversal(df, "bearish")


# ─── Bump and Run Reversal ─────────────────────────────────────────────────

def detect_bump_and_run_reversal(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Bump and Run Reversal"
    df = ensure_df(df)
    n = len(df)
    if n < 30:
        return empty_result(name, "bearish")
    # Three phases: lead-in (gentle uptrend), bump (steep uptrend with 2x slope),
    # run (price breaks the lead-in trendline).
    third = n // 3
    lead = df.iloc[:third]["close"]
    bump = df.iloc[third:2 * third]["close"]
    run = df.iloc[2 * third:]["close"]
    if len(lead) < 5 or len(bump) < 5 or len(run) < 3:
        return empty_result(name, "bearish")
    m_lead, b_lead = fit_line(list(zip(np.arange(len(lead), dtype=float).tolist(), lead.astype(float).tolist())))
    m_bump, b_bump = fit_line(list(zip(np.arange(len(bump), dtype=float).tolist(), bump.astype(float).tolist())))
    if m_lead <= 0 or m_bump <= 2 * m_lead:
        return empty_result(name, "bearish")
    # Run breaks the (extended) lead trendline downward.
    extended = m_lead * (n - 1) + b_lead
    if float(run.iloc[-1]) >= extended:
        return empty_result(name, "bearish")
    bump_high = float(df["high"].iloc[third:2 * third].max())
    lead_high = float(df["high"].iloc[:third].max())
    height = bump_high - lead_high
    entry = float(extended)
    target = entry - height
    stop = bump_high
    tps = [
        _point(df, 0, float(lead.iloc[0])),
        _point(df, third - 1, float(lead.iloc[-1])),
        _point(df, 2 * third - 1, bump_high),
        _point(df, n - 1, float(run.iloc[-1])),
    ]
    return make_extended_result(
        name,
        direction="bearish",
        indices=list(range(0, n)),
        strength=0.58,
        description="Gentle uptrend, then a steep 'bump' phase, then break of the lead-in trendline — three-phase distribution.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Diamond Top / Bottom ─────────────────────────────────────────────────

def _detect_diamond(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Diamond Top" if direction == "bearish" else "Diamond Bottom"
    df = ensure_df(df)
    n = len(df)
    if n < 30:
        return empty_result(name, direction)  # type: ignore[arg-type]
    pvs = _pivots_window(df, min(n, 80))
    highs = [p for p in pvs if p.kind == "H"][-4:]
    lows = [p for p in pvs if p.kind == "L"][-4:]
    if len(highs) < 3 or len(lows) < 3:
        return empty_result(name, direction)  # type: ignore[arg-type]
    # Diamond shape: range expands then contracts (highs go up then down, lows go down then up).
    h_seq = [p.price for p in highs]
    l_seq = [p.price for p in lows]
    if not (h_seq[1] > h_seq[0] and h_seq[-1] < h_seq[1]):
        return empty_result(name, direction)  # type: ignore[arg-type]
    if not (l_seq[1] < l_seq[0] and l_seq[-1] > l_seq[1]):
        return empty_result(name, direction)  # type: ignore[arg-type]
    apex_hi = max(h_seq)
    apex_lo = min(l_seq)
    height = apex_hi - apex_lo
    last = float(df["close"].iloc[-1])
    if direction == "bearish":
        entry = float(min(p.price for p in lows[-2:]))
        target = entry - height
        stop = float(max(p.price for p in highs[-2:]))
    else:
        entry = float(max(p.price for p in highs[-2:]))
        target = entry + height
        stop = float(min(p.price for p in lows[-2:]))
    tps = [highs[0].as_point(df), highs[1].as_point(df), highs[-1].as_point(df),
           lows[0].as_point(df), lows[1].as_point(df), lows[-1].as_point(df)]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=list(range(min(highs[0].idx, lows[0].idx), n)),
        strength=0.55,
        description=f"Volatility expands then contracts into a diamond — {direction} resolution targets the apex height.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_diamond_top(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_diamond(df, "bearish")


def detect_diamond_bottom(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_diamond(df, "bullish")


WESTERN_DETECTORS = [
    detect_bull_flag,
    detect_bear_flag,
    detect_bull_pennant,
    detect_bear_pennant,
    detect_ascending_triangle,
    detect_descending_triangle,
    detect_symmetrical_triangle,
    detect_rising_wedge,
    detect_falling_wedge,
    detect_ascending_channel,
    detect_descending_channel,
    detect_horizontal_channel,
    detect_cup_and_handle,
    detect_inverse_cup_and_handle,
    detect_head_and_shoulders,
    detect_inverse_head_and_shoulders,
    detect_double_top,
    detect_double_bottom,
    detect_triple_top,
    detect_triple_bottom,
    detect_rounding_bottom,
    detect_rounding_top,
    detect_rectangle,
    detect_bullish_island_reversal,
    detect_bearish_island_reversal,
    detect_bump_and_run_reversal,
    detect_diamond_top,
    detect_diamond_bottom,
]
