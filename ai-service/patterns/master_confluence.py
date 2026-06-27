"""Master Confluence Engine.

Runs every detector created in Phase 2 (real + stubs), applies the
Stage-2 gate, scores combinations per the spec's TIER 1-4 matrix, and
emits a single ranked verdict.

Output contract — see compute_master_confluence() docstring.

This engine does NOT modify any existing voter; it's an additive,
read-only consumer. It can be invoked from /api/patterns/scan-all OR
plugged into power_analysis.py as a top-level "master_confluence" voter
(weight 1.50 per spec).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import pandas as pd

from risk_config import RISK_CONFIG, apply_risk_caps, stop_pct_of, target_pct_of

# Real detectors built this turn.
from patterns.stage_analysis import detect_stage
from patterns.vcp import detect_vcp
from patterns.wolfe_waves import detect_wolfe_wave
from patterns.volume_profile import detect_volume_profile_patterns

# Stubs — return None safely until they're implemented.
from patterns.cup_and_handle import detect_cup_and_handle
from patterns.wyckoff import detect_wyckoff
from patterns.harmonics import detect_harmonics
from patterns.advanced_harmonics import detect_advanced_harmonics
from patterns.smc import detect_smc_patterns
from patterns.advanced_smc import detect_advanced_smc
from patterns.elliott_wave import detect_elliott_wave
from patterns.darvas_box import detect_darvas_box
from patterns.ichimoku_patterns import detect_ichimoku_patterns
from patterns.candlestick_advanced import detect_advanced_candlesticks
from patterns.gap_patterns import detect_gap_patterns
from patterns.narrow_range import detect_narrow_range
from patterns.livermore_pivots import detect_livermore_pivots
from patterns.fibonacci_advanced import detect_fibonacci_patterns
from patterns.momentum_bases import (
    detect_high_tight_flag,
    detect_power_earnings_gap,
    detect_flat_base,
    detect_three_weeks_tight,
)


# ─── confluence scoring matrix ───────────────────────────────────────────────
# Each rule: (predicate, points, reason). Predicates take the `r` dict
# of {detector_name: detector_result_or_None} and return bool.

def _has(r: dict, name: str) -> bool:
    """True if the detector returned something `detected: True` (or a non-empty list)."""
    v = r.get(name)
    if v is None:
        return False
    if isinstance(v, list):
        return len(v) > 0
    if isinstance(v, dict):
        return bool(v.get("detected", True)) and (v.get("confidence") or 0) > 0
    return False


def _stage_is_2(r: dict) -> bool:
    s = r.get("stage")
    return bool(s) and isinstance(s, dict) and s.get("current_stage") == 2


def _score_confluence(r: dict) -> tuple[float, list[str]]:
    """Apply the TIER 1-4 matrix from the spec. Returns (score, reasons)."""
    score = 0.0
    reasons: list[str] = []

    # ── TIER 1 — most powerful combos ─────────────────────────────────
    if _stage_is_2(r) and _has(r, "vcp"):
        score += 38
        reasons.append("Stage 2 + VCP = Minervini superstock setup (+38)")

    if _stage_is_2(r) and _has(r, "high_tight_flag"):
        score += 40
        reasons.append("Stage 2 + High Tight Flag = rarest momentum (+40)")

    if (_has(r, "livermore_pivots") and _stage_is_2(r) and _has(r, "high_tight_flag")):
        score += 45
        reasons.append("Livermore + Stage 2 + HTF = SUPERSTOCK (+45)")

    # ── TIER 2 — institutional confluence ────────────────────────────
    if _has(r, "wyckoff") and _has(r, "smc"):
        score += 35
        reasons.append("Wyckoff + SMC Order Block = institutional buy zone (+35)")

    if _has(r, "gap_patterns") and _has(r, "darvas_box"):
        score += 30
        reasons.append("Breakaway Gap + Darvas Box = institutional breakout (+30)")

    if _has(r, "volume_profile") and _has(r, "wyckoff") and _has(r, "elliott_wave"):
        score += 32
        reasons.append("POC + Wyckoff SOS + Wave 3 = triple confirmation (+32)")

    # ── TIER 3 — technical confluence ─────────────────────────────────
    if _has(r, "harmonics") and _has(r, "smc"):
        score += 25
        reasons.append("Harmonic PRZ + SMC OTE zone = Fibonacci convergence (+25)")

    if _has(r, "advanced_smc") and _has(r, "harmonics"):
        score += 28
        reasons.append("QM + Harmonic PRZ = reversal confirmed by two methods (+28)")

    if _has(r, "narrow_range") and _has(r, "ichimoku_patterns"):
        score += 25
        reasons.append("NR7-ID + Kumo Breakout = compressed Ichimoku push (+25)")

    if _has(r, "elliott_wave") and _has(r, "advanced_smc") and _has(r, "smc"):
        score += 32
        reasons.append("Wave 3 + Silver Bullet + FVG = best intraday long (+32)")

    if _has(r, "wolfe_wave") and _has(r, "volume_profile"):
        score += 25
        reasons.append("Wolfe Wave + POC = reversal confirmed two ways (+25)")

    # ── TIER 4 — supporting signals ───────────────────────────────────
    if _has(r, "fibonacci_advanced"):
        score += 15
        reasons.append("Fibonacci confluence zone near entry (+15)")
    if _has(r, "ichimoku_patterns"):
        score += 15
        reasons.append("Ichimoku TK cross above cloud (+15)")
    if _has(r, "candlestick_advanced"):
        score += 18
        reasons.append("Reversal candlestick at key level (+18)")
    if _has(r, "cup_and_handle"):
        score += 20
        reasons.append("Cup & Handle detected (+20)")
    if _has(r, "three_weeks_tight"):
        score += 15
        reasons.append("Three Weeks Tight on weekly chart (+15)")
    if _has(r, "volume_profile"):
        score += 12
        reasons.append("Volume Profile active pattern (+12)")

    # Cap final score at 100.
    return min(100.0, score), reasons


def _count_directions(r: dict) -> tuple[int, int]:
    """Tally bullish vs bearish indicators across all detector results."""
    bull, bear = 0, 0
    for v in r.values():
        if v is None:
            continue
        if isinstance(v, list):
            for item in v:
                d = (item.get("direction") if isinstance(item, dict) else None) or ""
                if "bull" in d:
                    bull += 1
                elif "bear" in d:
                    bear += 1
            continue
        if isinstance(v, dict):
            d = v.get("direction") or ""
            if "bull" in d:
                bull += 1
            elif "bear" in d:
                bear += 1
    return bull, bear


def _institutional_footprint(r: dict) -> bool:
    return any(_has(r, k) for k in ("wyckoff", "smc", "advanced_smc", "volume_profile"))


def _best_single(r: dict) -> tuple[Optional[str], float, Optional[dict]]:
    """Highest-confidence single detector result."""
    best_name, best_conf, best_res = None, -1.0, None
    for k, v in r.items():
        if v is None:
            continue
        if isinstance(v, list):
            for item in v:
                conf = (item.get("confidence") if isinstance(item, dict) else 0) or 0
                if conf > best_conf:
                    best_name, best_conf, best_res = k, float(conf), item
            continue
        if isinstance(v, dict):
            conf = v.get("confidence") or 0
            if conf > best_conf:
                best_name, best_conf, best_res = k, float(conf), v
    return best_name, best_conf, best_res


def _safe(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception:
        return None


def compute_master_confluence(
    symbol: str,
    df: pd.DataFrame,
    df_weekly: pd.DataFrame,
) -> dict:
    """Run every detector, apply Stage-2 gate, score confluence, emit verdict.

    See module docstring + Phase-2 File 20 in the build spec for the
    full output contract.
    """
    # Run every detector. Each is wrapped so failures don't crash the engine.
    r: dict = {
        "stage":              _safe(detect_stage, df_weekly),
        "vcp":                _safe(detect_vcp, df),
        "cup_and_handle":     _safe(detect_cup_and_handle, df),
        "wyckoff":            _safe(detect_wyckoff, df),
        "harmonics":          _safe(detect_harmonics, df),
        "advanced_harmonics": _safe(detect_advanced_harmonics, df),
        "smc":                _safe(detect_smc_patterns, df),
        "advanced_smc":       _safe(detect_advanced_smc, df),
        "elliott_wave":       _safe(detect_elliott_wave, df),
        "high_tight_flag":    _safe(detect_high_tight_flag, df),
        "power_earnings_gap": _safe(detect_power_earnings_gap, df, []),
        "flat_base":          _safe(detect_flat_base, df),
        "three_weeks_tight":  _safe(detect_three_weeks_tight, df_weekly),
        "darvas_box":         _safe(detect_darvas_box, df),
        "wolfe_wave":         _safe(detect_wolfe_wave, df),
        "volume_profile":     _safe(detect_volume_profile_patterns, df),
        "ichimoku_patterns":  _safe(detect_ichimoku_patterns, df),
        "candlestick_advanced": _safe(detect_advanced_candlesticks, df),
        "gap_patterns":       _safe(detect_gap_patterns, df),
        "narrow_range":       _safe(detect_narrow_range, df),
        "livermore_pivots":   _safe(detect_livermore_pivots, df),
        "fibonacci_advanced": _safe(detect_fibonacci_patterns, df),
    }

    # ── Stage-2 gate ──────────────────────────────────────────────────
    stage_info = r.get("stage") or {}
    current_stage = int(stage_info.get("current_stage") or 0)
    stage_warning: Optional[str] = None
    if current_stage != 2:
        stage_warning = (f"Stage {current_stage} — not optimal for buying; "
                         f"confidences capped at 0.40")
        # Apply cap to every detector's confidence in place.
        for v in r.values():
            if isinstance(v, dict) and "confidence" in v:
                v["confidence"] = min(float(v["confidence"] or 0), 0.40)
            elif isinstance(v, list):
                for it in v:
                    if isinstance(it, dict) and "confidence" in it:
                        it["confidence"] = min(float(it["confidence"] or 0), 0.40)

    # ── Confluence score & direction ──────────────────────────────────
    score, reasons = _score_confluence(r)
    bull_count, bear_count = _count_directions(r)
    direction = "bullish" if bull_count > bear_count else (
        "bearish" if bear_count > bull_count else "neutral"
    )

    # ── Best single pattern for entry/stop/target anchor ──────────────
    best_name, best_conf, best_res = _best_single(r)

    # ── Signal tier ───────────────────────────────────────────────────
    if score >= 40:
        signal = "STRONG_BUY" if direction == "bullish" else "STRONG_SELL"
    elif score >= 28:
        signal = "BUY" if direction == "bullish" else "SELL"
    elif score >= 15:
        signal = "WATCH"
    else:
        signal = "NO_TRADE"

    # ── Final entry/stop/target with risk caps re-applied ─────────────
    entry = stop = target = float("nan")
    rr = 0.0
    if best_res and best_res.get("entry_price"):
        e = float(best_res["entry_price"])
        s = float(best_res.get("stop_price") or 0)
        t = float(best_res.get("target_price") or 0)
        d = "bullish" if direction in ("bullish", "neutral") else "bearish"
        capped = apply_risk_caps(e, s, t, direction=d)
        if capped is not None:
            entry, stop, target, rr = capped

    patterns_detected = [
        k for k, v in r.items()
        if v is not None and (
            (isinstance(v, dict) and (v.get("detected", True) and (v.get("confidence") or 0) > 0))
            or (isinstance(v, list) and len(v) > 0)
        )
    ]

    return {
        "symbol": symbol,
        "signal": signal,
        "confluence_score": round(score, 1),
        "confluence_reasons": reasons,
        "patterns_detected": patterns_detected,
        "pattern_count": len(patterns_detected),
        "institutional_footprint": _institutional_footprint(r),
        "stage": current_stage,
        "stage_warning": stage_warning,
        "direction": direction,
        "entry_price": round(float(entry), 2) if entry == entry else None,
        "stop_price": round(float(stop), 2) if stop == stop else None,
        "target_price": round(float(target), 2) if target == target else None,
        "reward_risk": round(float(rr), 3) if rr else None,
        "best_single_pattern": best_name,
        "best_single_confidence": round(float(best_conf), 3) if best_conf >= 0 else 0.0,
        "timeframe_alignment": {
            "daily": signal,
            "weekly": (stage_info.get("stage_label") or "unknown"),
        },
        "top_3_reasons": reasons[:3] if reasons else [
            f"No strong confluence (score {score:.0f})",
            f"Stage: {current_stage}",
            f"Bull/Bear votes: {bull_count}/{bear_count}",
        ],
        "scan_timestamp": datetime.now(timezone.utc).isoformat(),
    }
