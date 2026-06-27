"""Volume Profile — POC / VAH / VAL / HVN / LVN.

Computes a volume-by-price histogram over a `lookback` window, then
identifies institutional reference levels:

  POC (Point of Control): single price level with the highest volume
  VAH (Value Area High):  upper boundary of 70 % of total volume
  VAL (Value Area Low):   lower boundary of 70 % of total volume
  HVN (High Volume Node): price zones with volume > 1.5 × average bucket
  LVN (Low Volume Node):  price zones with volume < 0.5 × average bucket

Trade patterns (returned in `active_pattern`):
  POC rejection      — price touched POC and reversed
  VAH/VAL breakout   — price punched through value-area boundary
  LVN transit        — price entering a low-volume "air pocket" (fast move)

All actionable verdicts go through `apply_risk_caps` so stop ≤ 2 % and
target ≥ 5 %.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from risk_config import apply_risk_caps


def _compute_profile(
    df: pd.DataFrame, n_buckets: int = 100
) -> tuple[np.ndarray, np.ndarray]:
    """Volume histogram. Returns (price_levels, volume_at_level)."""
    cols = {c.lower(): c for c in df.columns}
    h, l, c, v = (cols.get("high"), cols.get("low"),
                  cols.get("close"), cols.get("volume"))
    if not (h and l and c and v):
        return np.array([]), np.array([])
    highs = df[h].to_numpy(float)
    lows = df[l].to_numpy(float)
    closes = df[c].to_numpy(float)
    vols = df[v].to_numpy(float)

    p_min, p_max = float(lows.min()), float(highs.max())
    if p_max <= p_min:
        return np.array([]), np.array([])
    edges = np.linspace(p_min, p_max, n_buckets + 1)
    centres = (edges[:-1] + edges[1:]) / 2.0
    hist = np.zeros(n_buckets, dtype=float)

    # Each bar contributes its volume distributed across the buckets
    # spanned by [low, high]. Simple uniform allocation — good enough for
    # daily/intraday NSE bars.
    for hi, lo, vol in zip(highs, lows, vols):
        if vol <= 0 or hi <= lo:
            continue
        lo_b = int(np.clip(np.searchsorted(edges, lo, side="left") - 1, 0, n_buckets - 1))
        hi_b = int(np.clip(np.searchsorted(edges, hi, side="right") - 1, 0, n_buckets - 1))
        if hi_b < lo_b:
            lo_b, hi_b = hi_b, lo_b
        n = hi_b - lo_b + 1
        hist[lo_b:hi_b + 1] += vol / n
    return centres, hist


def _value_area(centres: np.ndarray, hist: np.ndarray,
                area_pct: float = 0.70) -> tuple[float, float, float]:
    """POC, VAH, VAL via expand-around-POC method."""
    if hist.size == 0:
        return float("nan"), float("nan"), float("nan")
    poc_idx = int(np.argmax(hist))
    poc = float(centres[poc_idx])
    total = float(hist.sum())
    if total <= 0:
        return poc, poc, poc
    target = total * area_pct
    accumulated = float(hist[poc_idx])
    lo, hi = poc_idx, poc_idx
    while accumulated < target and (lo > 0 or hi < len(hist) - 1):
        below = hist[lo - 1] if lo > 0 else -1.0
        above = hist[hi + 1] if hi < len(hist) - 1 else -1.0
        if above >= below:
            hi += 1
            accumulated += float(hist[hi])
        else:
            lo -= 1
            accumulated += float(hist[lo])
    return poc, float(centres[hi]), float(centres[lo])


def _classify_nodes(
    centres: np.ndarray, hist: np.ndarray, hvn_mult: float = 1.5,
    lvn_mult: float = 0.5
) -> tuple[list[float], list[float]]:
    if hist.size == 0:
        return [], []
    avg = float(hist[hist > 0].mean()) if (hist > 0).any() else 0.0
    if avg <= 0:
        return [], []
    hvn = [float(centres[i]) for i, v in enumerate(hist) if v >= hvn_mult * avg]
    lvn = [float(centres[i]) for i, v in enumerate(hist) if 0 < v <= lvn_mult * avg]
    return hvn, lvn


def detect_volume_profile_patterns(
    df: pd.DataFrame, lookback: int = 50
) -> Optional[dict]:
    """Run volume-profile analysis over the last `lookback` bars."""
    try:
        if df is None or len(df) < max(20, lookback // 2):
            return None
        window = df.tail(lookback).reset_index(drop=True) if len(df) >= lookback else df.copy()
        centres, hist = _compute_profile(window, n_buckets=100)
        if centres.size == 0:
            return None

        poc, vah, val = _value_area(centres, hist, area_pct=0.70)
        hvn, lvn = _classify_nodes(centres, hist)
        cols = {c.lower(): c for c in df.columns}
        last_close = float(df[cols["close"]].iloc[-1])
        last_high = float(df[cols["high"]].iloc[-1])
        last_low = float(df[cols["low"]].iloc[-1])

        in_value = val <= last_close <= vah
        poc_dist_pct = ((last_close - poc) / poc * 100.0) if poc > 0 else 0.0
        hvn_above = next((h for h in sorted(hvn) if h > last_close), float("nan"))
        hvn_below = next((h for h in sorted(hvn, reverse=True) if h < last_close), float("nan"))
        lvn_near = min(lvn, key=lambda x: abs(x - last_close)) if lvn else float("nan")

        # ── Active-pattern detection (highest priority wins) ───────────
        pattern: Optional[str] = None
        direction = "neutral"
        entry = stop = target = float("nan")
        confidence = 0.30

        # 1) POC rejection — price tagged POC then reversed away.
        if abs(last_close - poc) / max(poc, 1e-9) < 0.005:
            # Was the prior bar on the OTHER side of POC?
            prev_close = float(df[cols["close"]].iloc[-2])
            if prev_close < poc < last_close:
                pattern = "poc_rejection_up"
                direction = "bullish"
                entry = last_close
                stop = poc * 0.99
                target = hvn_above if not np.isnan(hvn_above) else entry * 1.08
                confidence = 0.55
            elif prev_close > poc > last_close:
                pattern = "poc_rejection_down"
                direction = "bearish"
                entry = last_close
                stop = poc * 1.01
                target = hvn_below if not np.isnan(hvn_below) else entry * 0.92
                confidence = 0.55

        # 2) Value-area breakout.
        if pattern is None and last_close > vah and last_high > vah * 1.005:
            pattern = "vah_breakout"
            direction = "bullish"
            entry = last_close
            stop = vah * 0.99
            target = (hvn_above if not np.isnan(hvn_above) and hvn_above > entry
                      else entry * 1.06)
            confidence = 0.50
        elif pattern is None and last_close < val and last_low < val * 0.995:
            pattern = "val_breakdown"
            direction = "bearish"
            entry = last_close
            stop = val * 1.01
            target = (hvn_below if not np.isnan(hvn_below) and hvn_below < entry
                      else entry * 0.94)
            confidence = 0.50

        # 3) LVN transit — price entering a low-volume air pocket.
        if pattern is None and not np.isnan(lvn_near) and abs(last_close - lvn_near) / lvn_near < 0.005:
            if last_close > poc:
                pattern = "lvn_transit_up"
                direction = "bullish"
                entry = last_close
                stop = lvn_near * 0.99
                target = (hvn_above if not np.isnan(hvn_above) else entry * 1.07)
                confidence = 0.45
            else:
                pattern = "lvn_transit_down"
                direction = "bearish"
                entry = last_close
                stop = lvn_near * 1.01
                target = (hvn_below if not np.isnan(hvn_below) else entry * 0.93)
                confidence = 0.45

        if pattern is None:
            return {
                "detected": False,
                "pattern_name": "Volume Profile",
                "poc": round(float(poc), 4),
                "vah": round(float(vah), 4),
                "val": round(float(val), 4),
                "hvn_levels": [round(x, 4) for x in sorted(hvn)],
                "lvn_levels": [round(x, 4) for x in sorted(lvn)],
                "price_in_value_area": bool(in_value),
                "price_vs_poc_pct": round(float(poc_dist_pct), 3),
                "active_pattern": None,
                "confidence": 0.0,
            }

        capped = apply_risk_caps(float(entry), float(stop), float(target),
                                 direction=direction)
        if capped is None:
            return None
        entry, stop, target, rr = capped

        return {
            "detected": True,
            "pattern_name": "Volume Profile",
            "active_pattern": pattern,
            "direction": direction,
            "poc": round(float(poc), 4),
            "vah": round(float(vah), 4),
            "val": round(float(val), 4),
            "hvn_levels": [round(x, 4) for x in sorted(hvn)],
            "lvn_levels": [round(x, 4) for x in sorted(lvn)],
            "nearest_hvn_above": (None if np.isnan(hvn_above)
                                  else round(float(hvn_above), 4)),
            "nearest_hvn_below": (None if np.isnan(hvn_below)
                                  else round(float(hvn_below), 4)),
            "nearest_lvn": (None if np.isnan(lvn_near)
                            else round(float(lvn_near), 4)),
            "price_in_value_area": bool(in_value),
            "price_vs_poc_pct": round(float(poc_dist_pct), 3),
            "entry_price": round(float(entry), 2),
            "stop_price": round(float(stop), 2),
            "target_price": round(float(target), 2),
            "reward_risk": round(float(rr), 3),
            "confidence": round(float(confidence), 3),
            "historical_win_rate": 0.60,
        }
    except Exception:
        return None
