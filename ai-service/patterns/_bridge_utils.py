"""Shared utilities for the spec-compatible pattern detectors.

These wrappers convert the existing `_western` / `_institutional` /
`_single` / `_two` / `_three` detector outputs into the spec contract
(direction = bullish/bearish, with confidence + entry/stop/target,
risk caps applied), so the master_confluence engine can call them
through the spec-named modules.
"""

from __future__ import annotations

from typing import Callable, List, Optional, Tuple

import pandas as pd

from risk_config import apply_risk_caps


def _lower(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise column names to lowercase (the existing detectors expect it)."""
    if df is None or df.empty:
        return df
    if any(c[0].isupper() for c in df.columns):
        return df.rename(columns=str.lower)
    return df


def run_pair(
    df: pd.DataFrame,
    bullish_fn: Callable,
    bearish_fn: Callable,
) -> Optional[dict]:
    """Run a bullish+bearish detector pair, return whichever detected with
    higher strength. None if neither fired.
    """
    df_lc = _lower(df)
    try:
        bull = bullish_fn(df_lc)
    except Exception:
        bull = None
    try:
        bear = bearish_fn(df_lc)
    except Exception:
        bear = None

    bull_ok = bool(bull and bull.get("detected"))
    bear_ok = bool(bear and bear.get("detected"))
    if not bull_ok and not bear_ok:
        return None
    if bull_ok and not bear_ok:
        return _shape("bullish", bull, df_lc)
    if bear_ok and not bull_ok:
        return _shape("bearish", bear, df_lc)
    # Both — pick stronger.
    bs = float(bull.get("strength") or 0)
    rs = float(bear.get("strength") or 0)
    return _shape("bullish", bull, df_lc) if bs >= rs else _shape("bearish", bear, df_lc)


def run_aggregate(
    df: pd.DataFrame,
    detector_groups: List[Tuple[List[Callable], List[Callable]]],
    *,
    pattern_name: str,
) -> Optional[dict]:
    """Run many bullish + many bearish detectors and pick the strongest hit.

    detector_groups: list of (bullish_callables, bearish_callables) tuples.
    Aggregates all hits across both sides, returns the single highest
    strength result (with sub-results in a `contributing_patterns` list).
    """
    df_lc = _lower(df)
    bull_hits: List[dict] = []
    bear_hits: List[dict] = []
    for bull_fns, bear_fns in detector_groups:
        for fn in bull_fns:
            try:
                r = fn(df_lc)
                if r and r.get("detected"):
                    bull_hits.append(r)
            except Exception:
                continue
        for fn in bear_fns:
            try:
                r = fn(df_lc)
                if r and r.get("detected"):
                    bear_hits.append(r)
            except Exception:
                continue

    if not bull_hits and not bear_hits:
        return None
    bull_score = sum(float(h.get("strength", 0.5) or 0.5) for h in bull_hits)
    bear_score = sum(float(h.get("strength", 0.5) or 0.5) for h in bear_hits)
    direction = "bullish" if bull_score >= bear_score else "bearish"
    hits = bull_hits if direction == "bullish" else bear_hits
    best = max(hits, key=lambda r: float(r.get("strength", 0) or 0))
    shaped = _shape(direction, best, df_lc)
    if shaped is None:
        return None
    shaped["pattern_name"] = pattern_name
    shaped["contributing_patterns"] = [
        h.get("pattern_name", "?") for h in hits[:10]
    ]
    shaped["hit_count"] = len(hits)
    return shaped


def _shape(direction: str, result: dict, df_lc: pd.DataFrame) -> Optional[dict]:
    """Reshape a raw detector result into the spec contract (+ risk caps)."""
    if not result or not result.get("detected"):
        return None
    close = float(df_lc["close"].iloc[-1]) if "close" in df_lc.columns else None
    entry = float(result.get("entry_price") or close or 0)
    if entry <= 0:
        return None
    raw_stop = result.get("stop_price")
    raw_target = result.get("target_price")
    # Fall back to sensible defaults if the underlying detector didn't
    # supply entry/stop/target.
    if not raw_stop:
        raw_stop = entry * (0.98 if direction == "bullish" else 1.02)
    if not raw_target:
        raw_target = entry * (1.10 if direction == "bullish" else 0.90)
    capped = apply_risk_caps(entry, float(raw_stop), float(raw_target),
                             direction=direction)
    if capped is None:
        return None
    e, s, t, rr = capped
    return {
        "detected": True,
        "pattern_name": result.get("pattern_name", "?"),
        "direction": direction,
        "entry_price": round(e, 2),
        "stop_price": round(s, 2),
        "target_price": round(t, 2),
        "reward_risk": round(rr, 3),
        "confidence": float(result.get("strength", 0.5) or 0.5),
        "historical_win_rate": float(result.get("historical_win_rate", 0.55) or 0.55),
    }
