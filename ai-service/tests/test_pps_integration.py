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
    for pid in ("symmetrical_triangle", "ascending_triangle", "descending_triangle",
                "head_shoulders_continuation", "double_bottom", "double_top"):
        assert pid in pps.PPS_PATTERN_NAMES
