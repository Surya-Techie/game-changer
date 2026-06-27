"""Tests for the expectancy harness + strict composer gating.

These encode the core thesis of the AI-trading work: win rate alone is
not a measure of profitability — expectancy and profit factor are.
"""

import importlib.util
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mc = _load("_measure_composer", "_measure_composer.py")
hc = _load("high_conviction", "high_conviction.py")


def test_expectancy_basic_math():
    stats = mc._expectancy_stats([2.0, -1.0, 3.0, -1.0])
    assert stats["expectancy_pct"] == pytest.approx(0.75)
    assert stats["profit_factor"] == pytest.approx(2.5)   # 5 gross win / 2 gross loss
    assert stats["max_drawdown_pct"] == pytest.approx(1.0)
    assert stats["max_consec_losses"] == 1


def test_high_win_rate_can_still_lose_money():
    # 80% win rate (4 of 5 positive) but the single loser dwarfs the wins.
    pnl = [0.5, 0.5, 0.5, 0.5, -5.0]
    wins = sum(1 for p in pnl if p > 0)
    win_rate = wins / len(pnl)
    stats = mc._expectancy_stats(pnl)
    assert win_rate == 0.8                       # looks great
    assert stats["expectancy_pct"] < 0           # ...but bleeds money
    assert stats["profit_factor"] < 1.0          # gross losses > gross wins


def test_empty_is_safe():
    stats = mc._expectancy_stats([])
    assert stats["expectancy_pct"] == 0.0
    assert stats["profit_factor"] == 0.0


def test_strict_preset_is_unanimous_not_fixed_three():
    # Regression guard: a fixed "3 of 3" would never fire without the ML
    # vote. Strict must demand unanimity among active strategies instead.
    assert hc.STRICT_PRESET["require_unanimous"] is True
    assert hc.STRICT_PRESET["min_agree"] <= 2
    assert hc.STRICT_PRESET["min_risk_reward"] >= 1.0


def test_strict_rejects_insufficient_history():
    out = hc.compose_high_conviction([{"o": 1, "h": 1, "l": 1, "c": 1, "v": 1}], strict=True)
    assert out["signal"] == "HOLD"
