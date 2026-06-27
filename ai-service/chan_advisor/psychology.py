"""Section-A psychology rules — emotional checks attached to each recommendation."""

from __future__ import annotations

from .regime import MarketRegime


PSYCH_RULES = {
    "LOSS_AVERSION":
        "Loss aversion (Rule 1): you'll feel the urge to cut this winner early or "
        "hold a loser past its exit. Resist — the math assumes you take every signal.",
    "OVERCONFIDENCE":
        "Overconfidence (Rule 2): a recent win streak is the most dangerous time to "
        "upsize. Kelly fraction is set by strategy statistics, not by your last week.",
    "NO_OVERRIDE":
        "No override (Rule 3): the urge to intervene peaks during drawdowns. "
        "Strategy performance mean-reverts; premature override destroys the recovery.",
    "REBALANCE_INTO_LOSS":
        "Selling into losses (Rule 4): constant-leverage means you sell as equity "
        "falls. It feels wrong; the alternative is geometric ruin.",
    "NO_REVENGE":
        "No revenge sizing (Rule 5): size from Kelly + strategy stats, never from "
        "yesterday's P&L. Doubling up to recover losses is the classic blowup.",
}


def emotional_check(regime: MarketRegime, recommended_category: str) -> str:
    """Return the most relevant psychology warning for the current setup."""
    if regime.band == "CRISIS":
        return PSYCH_RULES["NO_OVERRIDE"]
    if recommended_category == "MEAN_REVERSION":
        # MR positions grow as they move against you — classic trap.
        return PSYCH_RULES["LOSS_AVERSION"]
    if recommended_category == "MOMENTUM" and regime.band == "ELEVATED":
        return PSYCH_RULES["OVERCONFIDENCE"]
    if regime.band == "CALM":
        return PSYCH_RULES["NO_REVENGE"]
    return PSYCH_RULES["REBALANCE_INTO_LOSS"]
