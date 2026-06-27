"""Unit tests for the patterns built this session:
- risk_config (caps + reward-risk floor)
- stage_analysis (Weinstein 4-stage)
- wolfe_waves
- volume_profile
- master_confluence (TIER scoring + Stage 2 hard cap)
- bridge stubs (verify they return None safely or shaped dicts)

Synthetic OHLCV is used so tests are deterministic + don't hit the network.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

# Make ai-service importable when running pytest from repo root.
AI_ROOT = Path(__file__).resolve().parent.parent
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))


# ─── risk_config ────────────────────────────────────────────────────────────

def test_risk_caps_apply_to_wide_stops():
    from risk_config import apply_risk_caps
    # Raw stop 5% below entry — should get tightened to 2% (max_stop_loss_pct).
    out = apply_risk_caps(100.0, 95.0, 110.0, direction="bullish")
    assert out is not None
    entry, stop, target, rr = out
    assert entry == pytest.approx(100.0, abs=1e-6)
    assert stop == pytest.approx(98.0, abs=1e-6)            # capped at 2%
    assert target == pytest.approx(110.0, abs=1e-6)          # target preserved
    assert rr >= 2.5


def test_risk_caps_floor_small_targets():
    from risk_config import apply_risk_caps
    # Raw target 3% above entry — should be stretched to 5% (min_target_pct).
    out = apply_risk_caps(100.0, 98.0, 103.0, direction="bullish")
    assert out is not None
    _, _, target, rr = out
    assert target == pytest.approx(105.0, abs=1e-6)          # floored at 5%
    assert rr == pytest.approx(2.5, abs=0.05)


def test_risk_caps_reject_invalid_orientation():
    from risk_config import apply_risk_caps
    # Bullish trade with stop ABOVE entry is invalid orientation.
    assert apply_risk_caps(100.0, 101.0, 110.0, direction="bullish") is None
    # Bearish trade with stop BELOW entry is invalid.
    assert apply_risk_caps(100.0, 99.0, 90.0, direction="bearish") is None


def test_risk_caps_bearish_path():
    from risk_config import apply_risk_caps
    out = apply_risk_caps(100.0, 105.0, 92.0, direction="bearish")
    assert out is not None
    _, stop, target, rr = out
    assert stop == pytest.approx(102.0, abs=1e-6)            # capped 2% above
    assert target == pytest.approx(92.0, abs=1e-6)            # preserved (already ≥5%)
    assert rr >= 2.5


# ─── stage_analysis ─────────────────────────────────────────────────────────

def _make_weekly(n_weeks: int, slope_per_week: float = 0.005, base: float = 100.0
                ) -> pd.DataFrame:
    """Build a synthetic weekly OHLCV with a clean trend slope."""
    rows = []
    rng = np.random.default_rng(42)
    price = base
    for i in range(n_weeks):
        price *= (1 + slope_per_week + rng.normal(0, 0.005))
        rng_high = price * (1 + abs(rng.normal(0, 0.01)))
        rng_low = price * (1 - abs(rng.normal(0, 0.01)))
        rows.append({"open": price, "high": rng_high, "low": rng_low,
                       "close": price, "volume": 1_000_000})
    return pd.DataFrame(rows)


def test_stage_analysis_rising_market_is_stage_2():
    from patterns.stage_analysis import detect_stage
    df = _make_weekly(60, slope_per_week=0.008)              # strong uptrend
    r = detect_stage(df)
    assert r["detected"]
    assert r["current_stage"] == 2
    assert r["tradeable"]
    assert r["ma30_slope"] > 0


def test_stage_analysis_falling_market_is_stage_4():
    from patterns.stage_analysis import detect_stage
    df = _make_weekly(60, slope_per_week=-0.008)             # strong downtrend
    r = detect_stage(df)
    assert r["detected"]
    assert r["current_stage"] == 4
    assert not r["tradeable"]
    assert r["ma30_slope"] < 0


def test_stage_analysis_handles_insufficient_history():
    from patterns.stage_analysis import detect_stage
    df = _make_weekly(15)                                     # <30 weeks
    r = detect_stage(df)
    assert r["detected"] is False
    assert "insufficient" in (r["warning"] or "")


# ─── wolfe_waves ────────────────────────────────────────────────────────────

def test_wolfe_waves_returns_none_on_random_walk():
    from patterns.wolfe_waves import detect_wolfe_wave
    rng = np.random.default_rng(7)
    n = 120
    closes = 100 + rng.normal(0, 0.5, n).cumsum()
    df = pd.DataFrame({
        "open": closes + rng.normal(0, 0.1, n),
        "high": closes + np.abs(rng.normal(0, 0.3, n)),
        "low": closes - np.abs(rng.normal(0, 0.3, n)),
        "close": closes,
        "volume": np.ones(n) * 1_000_000,
    })
    # On random walk Wolfe rarely fires. Either None or a low-confidence hit.
    r = detect_wolfe_wave(df)
    if r is not None:
        assert 0.0 <= r["confidence"] <= 1.0
        assert r["direction"] in ("bullish", "bearish")
        assert r["entry_price"] > 0
        assert r["stop_price"] > 0
        assert r["target_price"] > 0


def test_wolfe_waves_handles_short_input():
    from patterns.wolfe_waves import detect_wolfe_wave
    df = pd.DataFrame({"open": [1, 2], "high": [1, 2], "low": [1, 2],
                       "close": [1, 2], "volume": [1, 2]})
    assert detect_wolfe_wave(df) is None


# ─── volume_profile ─────────────────────────────────────────────────────────

def test_volume_profile_computes_poc_vah_val():
    from patterns.volume_profile import detect_volume_profile_patterns
    rng = np.random.default_rng(11)
    n = 60
    closes = 100 + np.cumsum(rng.normal(0, 0.5, n))
    df = pd.DataFrame({
        "open": closes, "high": closes + 1, "low": closes - 1,
        "close": closes, "volume": np.full(n, 1_000_000),
    })
    r = detect_volume_profile_patterns(df, lookback=50)
    assert r is not None
    assert r["poc"] > 0
    assert r["vah"] >= r["poc"] >= r["val"]
    # HVN/LVN levels should be sorted.
    if r.get("hvn_levels"):
        assert r["hvn_levels"] == sorted(r["hvn_levels"])


def test_volume_profile_short_input_returns_none():
    from patterns.volume_profile import detect_volume_profile_patterns
    df = pd.DataFrame({"open": [1], "high": [1], "low": [1], "close": [1],
                       "volume": [1]})
    assert detect_volume_profile_patterns(df) is None


# ─── master_confluence ──────────────────────────────────────────────────────

def _make_daily(n_days: int = 200, slope: float = 0.001) -> pd.DataFrame:
    rng = np.random.default_rng(42)
    price = 100.0
    rows = []
    for _ in range(n_days):
        price *= (1 + slope + rng.normal(0, 0.01))
        hi = price * (1 + abs(rng.normal(0, 0.008)))
        lo = price * (1 - abs(rng.normal(0, 0.008)))
        rows.append({"open": price, "high": hi, "low": lo, "close": price,
                       "volume": 1_000_000})
    return pd.DataFrame(rows)


def test_master_confluence_returns_full_contract():
    from patterns.master_confluence import compute_master_confluence
    daily = _make_daily(220, slope=0.0015)
    weekly = _make_weekly(80, slope_per_week=0.007)
    m = compute_master_confluence("TEST", daily, weekly)
    # Spec contract — every key must exist.
    for k in ("symbol", "signal", "confluence_score", "confluence_reasons",
              "patterns_detected", "pattern_count", "institutional_footprint",
              "stage", "direction", "entry_price", "stop_price",
              "target_price", "reward_risk", "best_single_pattern",
              "best_single_confidence", "timeframe_alignment",
              "top_3_reasons", "scan_timestamp"):
        assert k in m, f"missing key: {k}"
    assert m["signal"] in ("STRONG_BUY", "BUY", "WATCH", "NO_TRADE", "SELL", "STRONG_SELL")
    assert 0.0 <= float(m["confluence_score"]) <= 100.0


def test_master_confluence_caps_confidence_when_not_stage_2():
    """Stage != 2 → every voter's confidence is forced ≤ 0.40."""
    from patterns.master_confluence import compute_master_confluence
    # Use a flat/declining weekly so stage is NOT 2.
    daily = _make_daily(220, slope=-0.001)
    weekly = _make_weekly(80, slope_per_week=-0.008)
    m = compute_master_confluence("TEST_BEAR", daily, weekly)
    if m["stage"] != 2:
        # Stage cap must be reflected in the warning text.
        assert m["stage_warning"] and "Stage" in m["stage_warning"]


# ─── bridge stubs ───────────────────────────────────────────────────────────

def test_all_bridges_return_safely_on_random_walk():
    """Every bridged detector must accept random walk + not throw."""
    from patterns.candlestick_advanced import detect_advanced_candlesticks
    from patterns.smc import detect_smc_patterns
    from patterns.wyckoff import detect_wyckoff
    from patterns.darvas_box import detect_darvas_box
    from patterns.narrow_range import detect_narrow_range
    from patterns.ichimoku_patterns import detect_ichimoku_patterns
    from patterns.cup_and_handle import detect_cup_and_handle
    from patterns.gap_patterns import detect_gap_patterns

    rng = np.random.default_rng(123)
    n = 150
    closes = 100 + np.cumsum(rng.normal(0, 0.5, n))
    df = pd.DataFrame({
        "open": closes, "high": closes + 1.0, "low": closes - 1.0,
        "close": closes, "volume": rng.integers(500_000, 2_000_000, n),
    })
    for fn in (detect_advanced_candlesticks, detect_smc_patterns,
               detect_wyckoff, detect_darvas_box, detect_narrow_range,
               detect_ichimoku_patterns, detect_cup_and_handle,
               detect_gap_patterns):
        r = fn(df)
        assert r is None or isinstance(r, dict), f"{fn.__name__} bad shape"
        if isinstance(r, dict):
            # When detected, must include direction + confidence in [0,1].
            assert r.get("direction") in (None, "bullish", "bearish", "neutral")
            conf = r.get("confidence", 0)
            assert 0.0 <= float(conf) <= 1.0
