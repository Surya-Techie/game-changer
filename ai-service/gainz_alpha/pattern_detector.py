"""Brandt-mapped pattern detection.

Rather than re-implementing the 23 chart patterns from scratch, we wrap
the existing ``ai-service/patterns/_western.py`` detector battery and
expose a Brandt-flavoured surface:

    detect_best_brandt_pattern(df) -> dict | None

Each detector returns the standard PatternResult; we adapt it into a
Brandt dict that includes the pattern_type_id used by the ML model and
the bonus/penalty multipliers from Brandt's reliability hierarchy.

If a detector raises because the dataframe is too short (Brandt requires
~20 weekly bars i.e. ~100 daily bars) we skip it rather than crash.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional

import pandas as pd

from patterns import _western as W


# --------------------------------------------------------------------------
# Brandt's 23 patterns → detector function + reliability tier.
# Tier 0 = high reliability (Brandt's "core" patterns)
# Tier 1 = medium reliability
# Tier 2 = low reliability (use with caution)
#
# Pattern type IDs are stable integers used by the ML model.
# --------------------------------------------------------------------------

BRANDT_PATTERNS: List[Dict] = [
    # ───────── Tier 0: high reliability ─────────
    {"id":  0, "name": "head_and_shoulders_top",     "fn": W.detect_head_and_shoulders,
     "tier": 0, "direction": -1, "boundary": 0},
    {"id":  1, "name": "head_and_shoulders_bottom",  "fn": W.detect_inverse_head_and_shoulders,
     "tier": 0, "direction":  1, "boundary": 0},
    {"id":  2, "name": "rectangle",                  "fn": W.detect_rectangle,
     "tier": 0, "direction":  0, "boundary": 0},
    {"id":  3, "name": "ascending_triangle",         "fn": W.detect_ascending_triangle,
     "tier": 0, "direction":  1, "boundary": 0},
    {"id":  4, "name": "descending_triangle",        "fn": W.detect_descending_triangle,
     "tier": 0, "direction": -1, "boundary": 0},
    {"id":  5, "name": "rounding_bottom",            "fn": W.detect_rounding_bottom,
     "tier": 0, "direction":  1, "boundary": 0},
    {"id":  6, "name": "rounding_top",               "fn": W.detect_rounding_top,
     "tier": 0, "direction": -1, "boundary": 0},
    {"id":  7, "name": "island_bottom",              "fn": W.detect_bullish_island_reversal,
     "tier": 0, "direction":  1, "boundary": 0},
    {"id":  8, "name": "island_top",                 "fn": W.detect_bearish_island_reversal,
     "tier": 0, "direction": -1, "boundary": 0},

    # ───────── Tier 1: medium reliability ─────────
    {"id":  9, "name": "double_top",                 "fn": W.detect_double_top,
     "tier": 1, "direction": -1, "boundary": 0},
    {"id": 10, "name": "double_bottom",              "fn": W.detect_double_bottom,
     "tier": 1, "direction":  1, "boundary": 0},
    {"id": 11, "name": "triple_top",                 "fn": W.detect_triple_top,
     "tier": 1, "direction": -1, "boundary": 0},
    {"id": 12, "name": "triple_bottom",              "fn": W.detect_triple_bottom,
     "tier": 1, "direction":  1, "boundary": 0},
    {"id": 13, "name": "symmetrical_triangle",       "fn": W.detect_symmetrical_triangle,
     "tier": 1, "direction":  0, "boundary": 1},
    {"id": 14, "name": "diamond_top",                "fn": W.detect_diamond_top,
     "tier": 1, "direction": -1, "boundary": 1},
    {"id": 15, "name": "diamond_bottom",             "fn": W.detect_diamond_bottom,
     "tier": 1, "direction":  1, "boundary": 1},

    # ───────── Tier 2: lower reliability ─────────
    {"id": 16, "name": "bull_flag",                  "fn": W.detect_bull_flag,
     "tier": 2, "direction":  1, "boundary": 1},
    {"id": 17, "name": "bear_flag",                  "fn": W.detect_bear_flag,
     "tier": 2, "direction": -1, "boundary": 1},
    {"id": 18, "name": "bull_pennant",               "fn": W.detect_bull_pennant,
     "tier": 2, "direction":  1, "boundary": 1},
    {"id": 19, "name": "bear_pennant",               "fn": W.detect_bear_pennant,
     "tier": 2, "direction": -1, "boundary": 1},
    {"id": 20, "name": "rising_wedge",               "fn": W.detect_rising_wedge,
     "tier": 2, "direction": -1, "boundary": 1},
    {"id": 21, "name": "falling_wedge",              "fn": W.detect_falling_wedge,
     "tier": 2, "direction":  1, "boundary": 1},
    {"id": 22, "name": "horizontal_channel",         "fn": W.detect_horizontal_channel,
     "tier": 1, "direction":  0, "boundary": 0},
]

PATTERN_NAME_TO_ID = {p["name"]: p["id"] for p in BRANDT_PATTERNS}
PATTERN_ID_TO_DEF = {p["id"]: p for p in BRANDT_PATTERNS}


def detect_all_brandt_patterns(df: pd.DataFrame, *, min_confidence: float = 0.4) -> list[dict]:
    """Run every detector and return EVERY match (not just the best one).

    Used by the Power Analysis chart so it can draw trendlines + breakout
    markers for *every* classical reversal pattern the engine finds —
    Double Top / H&S / Wedge / Rounding / Diamond / Bump and Run / etc.

    Each returned dict carries enough geometry (``trendline_points``,
    ``candle_indices``, entry/SL/TP) for the frontend to draw the
    pattern lines exactly like the reference cheat-sheet.
    """
    if df is None or len(df) < 60:
        return []
    out: list[dict] = []
    for p in BRANDT_PATTERNS:
        try:
            res = p["fn"](df)
        except Exception:
            continue
        if not res or not res.get("detected"):
            continue
        conf = float(res.get("confidence_score") or res.get("strength") or 0.5)
        if conf < min_confidence:
            continue

        # Resolve direction from the per-pattern hint or detector output.
        direction = p["direction"]
        if direction == 0:
            d = (res.get("direction") or "").lower()
            if d in ("bullish", "up"):       direction = 1
            elif d in ("bearish", "down"):   direction = -1

        out.append({
            "id":            p["id"],
            "name":          p["name"],
            "tier":          p["tier"],
            "boundary_type": p["boundary"],
            "direction":     direction,
            "confidence":    conf,
            "candle_indices": res.get("candle_indices", []),
            "entry_price":   res.get("entry_price"),
            "target_price":  res.get("target_price"),
            "stop_price":    res.get("stop_price"),
            "rr":            res.get("risk_reward"),
            # Geometry for the chart — keep only well-shaped trendline
            # points (epoch-ms, not bar indices).
            "trendline_points": [
                {"t": int(pt["time"]), "price": float(pt["price"])}
                for pt in (res.get("trendline_points") or [])
                if isinstance(pt, dict)
                and isinstance(pt.get("time"), (int, float))
                and pt["time"] > 9.4e11
            ],
            "description": res.get("description"),
        })

    # Highest-confidence first so the frontend can cap the visible count
    # without losing the best patterns.
    out.sort(key=lambda x: (x["tier"], -x["confidence"]))
    return out


def _safe_run(fn: Callable, df: pd.DataFrame) -> Optional[dict]:
    """Run a detector and swallow short-DF errors."""
    try:
        result = fn(df)
        if result and result.get("detected"):
            return result
    except Exception:
        return None
    return None


def detect_best_brandt_pattern(df: pd.DataFrame) -> Optional[Dict]:
    """Run all 23 Brandt-mapped detectors and return the highest-quality
    match. "Best" = highest tier (lower number = better) × highest
    confidence/strength returned by the detector.

    Brandt minimum data: ~4 weeks of pattern development on daily bars
    means ~20 daily bars at the very minimum; we require ≥60 bars before
    even attempting detection so patterns have room to form properly.
    """
    if df is None or len(df) < 60:
        return None

    candidates: List[Dict] = []
    for p in BRANDT_PATTERNS:
        res = _safe_run(p["fn"], df)
        if not res:
            continue
        # PatternResult exposes either 'confidence_score' or 'strength'.
        conf = float(res.get("confidence_score") or res.get("strength") or 0.5)
        # Lower-tier patterns get a confidence haircut so high-tier wins ties.
        adjusted = conf * (1.0 - p["tier"] * 0.15)
        candidates.append({
            "pattern_def": p,
            "result": res,
            "adjusted_conf": adjusted,
        })

    if not candidates:
        return None

    candidates.sort(key=lambda x: x["adjusted_conf"], reverse=True)
    best = candidates[0]
    p = best["pattern_def"]
    res = best["result"]

    # Figure out actual direction (some patterns are bi-directional —
    # rectangle/triangle break either way; use detector hint).
    direction = p["direction"]
    if direction == 0:
        d = (res.get("direction") or "").lower()
        if d in ("bullish", "up"):
            direction = 1
        elif d in ("bearish", "down"):
            direction = -1
        else:
            direction = 0

    return {
        "id": p["id"],
        "name": p["name"],
        "tier": p["tier"],
        "boundary_type": p["boundary"],   # 0 = horizontal, 1 = diagonal
        "direction": direction,
        "confidence": float(res.get("confidence_score") or res.get("strength") or 0.5),
        "candle_indices": res.get("candle_indices", []),
        "entry_price":  res.get("entry_price"),
        "target_price": res.get("target_price"),
        "stop_price":   res.get("stop_price"),
        "rr":           res.get("risk_reward"),
        "description":  res.get("description"),
        "raw_result":   res,
    }
