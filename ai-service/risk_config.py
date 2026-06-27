"""Risk configuration — single source of truth.

Every pattern detector imports RISK_CONFIG from here and applies the
cap/floor logic uniformly so the user's "2% loss, 5% profit, 2.5:1
minimum" rule is enforced in one place.

Usage (in every detector):
    from risk_config import RISK_CONFIG, apply_risk_caps

    capped = apply_risk_caps(entry, raw_stop, raw_target, direction="bullish")
    if capped is None:
        return None            # signal rejected by risk gate
    entry, stop, target, rr = capped
"""

from __future__ import annotations

from typing import Optional, Tuple


RISK_CONFIG = {
    # Hard cap on stop distance. Patterns whose natural stop is WIDER than
    # this get the stop tightened to exactly max_stop_loss_pct of entry.
    "max_stop_loss_pct": 0.02,        # 2 % of entry

    # Hard floor on target distance. Patterns whose natural target is
    # CLOSER than this get the target stretched to min_target_pct.
    "min_target_pct": 0.05,           # 5 % of entry

    # Minimum reward-to-risk after capping. Below this, the signal is
    # rejected entirely (return None). 2.5:1 is the floor; the natural
    # 0.05 / 0.02 = 2.5 ratio.
    "min_reward_risk": 2.5,

    # Per-trade position-size cap (fraction of equity at risk).
    "max_risk_per_trade_pct": 0.01,

    # Daily / weekly drawdown halts (consumed by risk manager, not
    # detectors). Detectors only deal with per-trade caps.
    "daily_kill_pct": 0.02,
    "weekly_halt_pct": 0.03,
}


def apply_risk_caps(
    entry: float,
    raw_stop: float,
    raw_target: float,
    *,
    direction: str,                   # "bullish" | "bearish"
    cfg: Optional[dict] = None,
) -> Optional[Tuple[float, float, float, float]]:
    """Apply the standard risk envelope to a detector's raw levels.

    Returns (entry, stop, target, reward_risk) or None if the trade is
    rejected (RR below min_reward_risk after capping).

    Bullish: stop <= entry, target >= entry. Bearish: mirror.
    The caps ensure stop is NEVER farther than max_stop_loss_pct
    and target is NEVER closer than min_target_pct.
    """
    cfg = cfg or RISK_CONFIG
    if entry is None or entry <= 0 or raw_stop is None or raw_target is None:
        return None
    if direction == "bullish":
        # Stop must be at most max_stop_loss_pct BELOW entry.
        min_stop = entry * (1 - cfg["max_stop_loss_pct"])
        stop = max(raw_stop, min_stop)              # not too far below
        if stop >= entry:                            # invalid orientation
            return None
        # Target must be at least min_target_pct ABOVE entry.
        min_target = entry * (1 + cfg["min_target_pct"])
        target = max(raw_target, min_target)
    elif direction == "bearish":
        max_stop = entry * (1 + cfg["max_stop_loss_pct"])
        stop = min(raw_stop, max_stop)
        if stop <= entry:
            return None
        max_target = entry * (1 - cfg["min_target_pct"])
        target = min(raw_target, max_target)
    else:
        return None

    risk = abs(entry - stop)
    if risk <= 0:
        return None
    rr = abs(target - entry) / risk
    if rr < cfg.get("min_reward_risk", 2.5):
        return None
    return entry, stop, target, rr


def stop_pct_of(entry: float, stop: float) -> float:
    """% distance from entry to stop (always positive)."""
    if entry <= 0:
        return 0.0
    return abs(entry - stop) / entry * 100.0


def target_pct_of(entry: float, target: float) -> float:
    if entry <= 0:
        return 0.0
    return abs(target - entry) / entry * 100.0
