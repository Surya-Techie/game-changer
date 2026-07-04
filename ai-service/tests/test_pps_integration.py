"""Tests for the Analytics → PPS enrichment (measured win rate folded onto
live PPS signals)."""

import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


pps = _load("pps_engine", "pps_engine.py")


def _sig(pattern, signal="BUY", confidence=0.6):
    return {"signal": signal, "pattern": pattern, "confidence": confidence}


def test_no_measured_data_is_a_clean_noop():
    sigs = pps.enrich_signals_with_accuracy([_sig("double_bottom")], {})
    s = sigs[0]
    assert s["measured_win_rate"] is None
    assert s["measured_samples"] == 0
    assert s["combined_confidence"] == 0.6  # unchanged


def test_measured_data_blends_into_combined_confidence():
    lookup = {"Double Bottom": {"win_rate": 0.80, "samples": 20}}
    s = pps.enrich_signals_with_accuracy([_sig("double_bottom", confidence=0.60)], lookup)[0]
    assert s["measured_win_rate"] == 0.80
    assert s["measured_samples"] == 20
    # samples == K (20) → equal weight → midpoint of 0.60 and 0.80 = 0.70
    assert s["combined_confidence"] == 0.70


def test_more_samples_pull_toward_measured_rate():
    few = {"Double Bottom": {"win_rate": 0.90, "samples": 5}}
    many = {"Double Bottom": {"win_rate": 0.90, "samples": 200}}
    c_few = pps.enrich_signals_with_accuracy([_sig("double_bottom", confidence=0.5)], few)[0]["combined_confidence"]
    c_many = pps.enrich_signals_with_accuracy([_sig("double_bottom", confidence=0.5)], many)[0]["combined_confidence"]
    assert c_few < c_many                       # more evidence → closer to 0.90
    assert c_many > 0.85


def test_hold_signals_are_left_alone():
    s = pps.enrich_signals_with_accuracy(
        [{"signal": "HOLD", "pattern": None, "confidence": 0.0}],
        {"Double Bottom": {"win_rate": 0.8, "samples": 50}},
    )[0]
    assert s["measured_win_rate"] is None
    assert s["combined_confidence"] == 0.0


def test_unmapped_pattern_is_ignored():
    s = pps.enrich_signals_with_accuracy(
        [_sig("some_unknown_pattern")],
        {"Double Bottom": {"win_rate": 0.8, "samples": 50}},
    )[0]
    assert s["measured_win_rate"] is None


def test_pattern_name_map_covers_all_ids():
    # symmetrical_triangle was removed (loose geometry fired on everything);
    # the India setups + Supertrend replaced it.
    for pid in ("ascending_triangle", "descending_triangle",
                "head_shoulders_continuation", "double_bottom", "double_top",
                "orb_breakout", "orb_breakdown", "pdh_breakout", "pdl_breakdown",
                "vwap_reclaim", "vwap_reject",
                "supertrend_flip_bull", "supertrend_flip_bear"):
        assert pid in pps.PPS_PATTERN_NAMES


# ─── PPS → Analytics: outcome resolution ────────────────────────────────────

def _bar(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c, "volume": 1.0}


def _buy(bar_index=0, entry=100, stop=95, target=110, rr=2.0, pattern="double_bottom"):
    return {"signal": "BUY", "pattern": pattern, "bar_index": bar_index,
            "entry_price": entry, "stop_loss": stop, "target_price": target, "risk_reward": rr}


def test_resolve_win_on_target_hit():
    bars = [_bar(100, 100, 100, 100), _bar(100, 111, 99, 108)]  # bar1 high hits 110
    r = pps.resolve_pps_outcomes([_buy()], bars)
    assert len(r) == 1
    assert r[0]["outcome"] == "win"
    assert r[0]["pattern_name"] == "Double Bottom"
    assert r[0]["rr_achieved"] == 2.0


def test_resolve_loss_on_stop_hit():
    bars = [_bar(100, 100, 100, 100), _bar(100, 102, 94, 96)]   # bar1 low ≤ stop 95
    r = pps.resolve_pps_outcomes([_buy()], bars)
    assert r[0]["outcome"] == "loss"
    assert r[0]["rr_achieved"] == -1.0


def test_resolve_tie_break_counts_as_loss():
    bars = [_bar(100, 100, 100, 100), _bar(100, 111, 94, 100)]  # straddles both
    r = pps.resolve_pps_outcomes([_buy()], bars)
    assert r[0]["outcome"] == "loss"


def test_resolve_time_exit_by_sign():
    bars = [_bar(100, 100, 100, 100)] + [_bar(102, 104, 99, 103) for _ in range(5)]
    r = pps.resolve_pps_outcomes([_buy()], bars, max_hold_bars=10)
    assert r[0]["outcome"] == "win"   # never hit stop/target, closed above entry


def test_resolve_skips_unresolvable_tail():
    bars = [_bar(100, 100, 100, 100)]  # signal on last bar — no forward bar
    assert pps.resolve_pps_outcomes([_buy(bar_index=0)], bars) == []


def test_resolve_ignores_hold_and_unmapped():
    bars = [_bar(100, 100, 100, 100), _bar(100, 111, 99, 108)]
    sigs = [{"signal": "HOLD", "pattern": None, "bar_index": 0, "entry_price": None,
             "stop_loss": None, "target_price": None, "risk_reward": None},
            _buy(pattern="not_a_pattern")]
    assert pps.resolve_pps_outcomes(sigs, bars) == []


def test_normalise_timeframe():
    assert pps.normalise_timeframe("1d") == "D1"
    assert pps.normalise_timeframe("1D") == "D1"
    assert pps.normalise_timeframe("30m") == "M30"
    assert pps.normalise_timeframe("H1") == "H1"
    assert pps.normalise_timeframe("weird") == "D1"
