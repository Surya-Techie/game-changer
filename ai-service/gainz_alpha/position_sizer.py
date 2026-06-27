"""Brandt position sizing — Last Day Rule + 1% capital risk.

Brandt's two non-negotiables for sizing:

1. Risk no more than 1% of trading capital on any single trade.
2. The stop is the "Last Day Rule" — placed just beyond the high/low of
   the bar that completed the breakout, NOT at an arbitrary % distance.

Given the engine returns ``last_day_rule_stop_pct`` as the actual %
distance from entry to the stop, position sizing falls out as:

    capital_at_risk_pct = 1.0
    size_pct_of_capital = capital_at_risk_pct / stop_pct
"""

from __future__ import annotations

from typing import Dict


def compute_position_size(
    entry_price: float,
    stop_pct: float,
    capital: float,
    risk_pct: float = 1.0,
) -> Dict:
    """Return position-sizing block for the API response.

    Parameters
    ----------
    entry_price : last-day-rule entry price.
    stop_pct    : distance from entry to stop, in % of entry.
    capital     : total trading capital in INR.
    risk_pct    : max % of capital to risk on this trade (default 1.0).
    """
    if stop_pct <= 0 or entry_price <= 0 or capital <= 0:
        return {
            "max_position_inr": 0.0,
            "max_qty": 0,
            "capital_at_risk_inr": 0.0,
            "stop_pct": stop_pct,
            "note": "invalid_inputs",
        }

    capital_at_risk = capital * (risk_pct / 100.0)
    # If we put X rupees into this trade and the stop is stop_pct away,
    # our loss at stop = X * (stop_pct/100). Solve for X:
    max_position_inr = capital_at_risk / (stop_pct / 100.0)
    max_qty = int(max_position_inr // entry_price)
    return {
        "capital": capital,
        "risk_pct": risk_pct,
        "stop_pct": stop_pct,
        "capital_at_risk_inr": round(capital_at_risk, 2),
        "max_position_inr": round(max_position_inr, 2),
        "max_qty": max_qty,
        "note": f"Risk max {risk_pct}% of capital / {stop_pct:.2f}% stop = max ₹{max_position_inr:,.0f} per trade",
    }
