"""Kelly fraction + Sharpe + statistical-significance helpers (Section C)."""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd


def annualized_sharpe(daily_returns: pd.Series, periods: int = 252) -> float:
    """Annualised Sharpe. Returns 0 when the series is too thin or flat."""
    r = pd.Series(daily_returns).dropna()
    if len(r) < 20 or r.std() == 0:
        return 0.0
    return float(r.mean() / r.std() * math.sqrt(periods))


def kelly_fraction(daily_returns: pd.Series, half: bool = True) -> float:
    """Kelly fraction f = mean / variance, optionally halved (P-2)."""
    r = pd.Series(daily_returns).dropna()
    if len(r) < 20 or r.var() == 0:
        return 0.0
    f = float(r.mean() / r.var())
    return f / 2 if half else f


def years_for_significance(sharpe: float, alpha: float = 0.05) -> float:
    """Required years of data for a one-sided test at `alpha` (P-3).

    Bound to a sane minimum (0.01) when sharpe is huge. Returns a large
    finite sentinel (9999) instead of float('inf') when sharpe ≤ 0, so
    the result is JSON-serialisable by FastAPI / starlette without
    needing `allow_nan=True`.
    """
    if sharpe <= 0:
        return 9999.0   # "essentially infinite — symbol has no proven edge"
    z = 1.645 if alpha == 0.05 else 1.96
    return max(0.01, (z / sharpe) ** 2)


def cppi_position(equity: float, floor: float, multiplier: float = 4.0) -> float:
    """CPPI position size (R-2). Clamped to non-negative."""
    return max(0.0, multiplier * (equity - floor))
