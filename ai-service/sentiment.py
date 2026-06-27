"""Lexicon-based sentiment classifier for finance headlines.

VADER-style scoring tuned with a small finance-specific lexicon. Not as
good as a fine-tuned transformer on real-world news, but it has zero
external dependencies and gives interpretable scores. Swap the `classify`
function with a model call later (e.g. FinBERT) without touching callers.
"""

from __future__ import annotations

import re
from typing import Dict

POSITIVE: Dict[str, float] = {
    # generic
    "gain": 1.2, "gains": 1.2, "rally": 1.5, "surge": 1.6, "soar": 1.7, "jump": 1.2,
    "rise": 1.0, "rises": 1.0, "advance": 0.9, "strong": 1.0, "robust": 1.0,
    "outperform": 1.4, "beats": 1.4, "beat": 1.4, "exceed": 1.2, "exceeds": 1.2,
    "record": 1.1, "record-high": 1.4, "all-time": 1.3, "high": 0.6,
    "profit": 1.0, "profits": 1.0, "earnings": 0.3, "growth": 1.0,
    "upgrade": 1.3, "upgraded": 1.3, "buy": 0.8, "bullish": 1.6, "expansion": 1.0,
    "dividend": 0.8, "approved": 0.9, "wins": 1.1, "win": 1.0, "deal": 0.6, "partnership": 0.7,
    "innovation": 0.8, "launch": 0.7, "launches": 0.7, "breakthrough": 1.3,
    "positive": 1.0, "optimism": 1.0, "optimistic": 1.0,
}

NEGATIVE: Dict[str, float] = {
    "loss": -1.2, "losses": -1.2, "decline": -1.0, "declines": -1.0, "fall": -1.0, "falls": -1.0,
    "drop": -1.2, "drops": -1.2, "plunge": -1.7, "crash": -1.9, "tumble": -1.5,
    "weak": -1.0, "weakness": -1.0, "miss": -1.3, "misses": -1.3, "below": -0.6,
    "downgrade": -1.4, "downgraded": -1.4, "sell": -0.7, "bearish": -1.6, "recession": -1.5,
    "lawsuit": -1.2, "fine": -0.9, "penalty": -0.9, "fraud": -2.0, "scandal": -1.6,
    "warning": -1.0, "warn": -1.0, "warns": -1.0, "concern": -0.8, "concerns": -0.8,
    "risk": -0.6, "risky": -0.8, "uncertain": -0.7, "uncertainty": -0.9,
    "cut": -0.9, "cuts": -0.9, "layoffs": -1.4, "layoff": -1.4, "default": -1.7,
    "negative": -1.0, "pessimism": -1.0, "slump": -1.4, "freeze": -0.7,
}

INTENSIFIERS: Dict[str, float] = {
    "very": 1.25, "extremely": 1.5, "highly": 1.25, "huge": 1.4, "massive": 1.5,
    "deep": 1.3, "sharp": 1.3, "sharply": 1.3, "significantly": 1.3, "strongly": 1.3,
}

NEGATIONS = {"not", "no", "never", "nor", "without", "neither", "barely", "hardly", "scarcely"}


def _tokenise(text: str) -> list[str]:
    return re.findall(r"[A-Za-z][A-Za-z'-]+", text.lower())


def classify(text: str) -> dict:
    tokens = _tokenise(text)
    score = 0.0
    hits = 0
    for i, tok in enumerate(tokens):
        if tok in POSITIVE or tok in NEGATIVE:
            base = POSITIVE.get(tok, 0.0) + NEGATIVE.get(tok, 0.0)
            mult = 1.0
            # check the previous 1-2 tokens for intensifier / negation
            for back in (1, 2):
                if i - back >= 0:
                    prev = tokens[i - back]
                    if prev in INTENSIFIERS:
                        mult *= INTENSIFIERS[prev]
                    elif prev in NEGATIONS:
                        mult *= -1
            score += base * mult
            hits += 1
    # normalize roughly into [-1, 1]
    normalised = max(-1.0, min(1.0, score / 4.0))
    if normalised > 0.15:
        label = "POSITIVE"
    elif normalised < -0.15:
        label = "NEGATIVE"
    else:
        label = "NEUTRAL"
    return {
        "label": label,
        "score": round(normalised, 3),
        "raw": round(score, 3),
        "hits": hits,
    }
