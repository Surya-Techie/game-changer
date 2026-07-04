"""Tests for the live news-sentiment aggregation.

Network is monkeypatched out — we test the aggregation/recency/relevance
logic deterministically, not yfinance.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parent.parent
if str(AI_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_ROOT))

import news_sentiment as ns  # noqa: E402


def _item(title, age_h, summary=""):
    return {"title": title, "summary": summary,
            "ts": int((time.time() - age_h * 3600) * 1000),
            "provider": "Test", "url": None}


def test_positive_headlines_read_positive(monkeypatch):
    monkeypatch.setattr(ns, "fetch_news", lambda s: [
        _item("INFY surges on record profit, analysts upgrade", 1),
        _item("INFY wins large deal, strong growth outlook", 2),
    ])
    r = ns.analyze_symbol("INFY.NS")
    assert r["label"] == "POSITIVE"
    assert r["score"] > 0
    assert r["n_headlines"] == 2


def test_empty_is_neutral_with_disclaimer(monkeypatch):
    monkeypatch.setattr(ns, "fetch_news", lambda s: [])
    r = ns.analyze_symbol("XYZ.NS")
    assert r["label"] == "NEUTRAL"
    assert r["score"] == 0.0
    assert "not a backtested edge" in r["disclaimer"].lower()


def test_recency_weighting_favours_fresh_news(monkeypatch):
    # A fresh negative headline should outweigh a week-old positive one.
    monkeypatch.setattr(ns, "fetch_news", lambda s: [
        _item("TCS rallies to record high on strong earnings", 24 * 7),  # stale +
        _item("TCS plunges on fraud probe, downgrade", 1),               # fresh -
    ])
    r = ns.analyze_symbol("TCS.NS")
    assert r["score"] < 0
    assert r["label"] == "NEGATIVE"


def test_relevance_count_and_confidence(monkeypatch):
    monkeypatch.setattr(ns, "fetch_news", lambda s: [
        _item("RELIANCE posts strong profit growth", 1),     # relevant
        _item("Some unrelated macro headline about gold", 1),  # not relevant
    ])
    r = ns.analyze_symbol("RELIANCE.NS")
    assert r["relevant_count"] == 1
    assert 0.0 <= r["confidence"] <= 1.0


def test_confidence_is_zero_without_relevant_headlines(monkeypatch):
    monkeypatch.setattr(ns, "fetch_news", lambda s: [
        _item("Completely unrelated story", 1),
    ])
    r = ns.analyze_symbol("RELIANCE.NS")
    assert r["relevant_count"] == 0
    assert r["confidence"] == 0.0
