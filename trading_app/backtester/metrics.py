"""
Performance metrics.

compute_metrics(equity_curve, trades_df, starting_capital) ->
    dict of:
      total_return, cagr, sharpe, sortino, max_dd,
      win_rate, profit_factor, expectancy, calmar,
      avg_win, avg_loss, total_trades,
      daily_5pct_days   — # days reaching ≥ 5% gain
      avg_daily_return
"""
from __future__ import annotations
from typing import Dict

import numpy as np
import pandas as pd


def _safe(x, default=0.0):
    try:
        if x is None or (isinstance(x, float) and not np.isfinite(x)):
            return default
        return float(x)
    except Exception:
        return default


def compute_metrics(equity: pd.Series, trades: pd.DataFrame,
                    capital: float) -> Dict[str, float]:
    if equity is None or len(equity) < 2:
        return _empty(capital)

    eq = equity.astype(float)
    rets = eq.pct_change().dropna()
    if rets.empty:
        return _empty(capital)

    total_ret = eq.iloc[-1] / capital - 1.0

    # ── drawdown ──
    peak = eq.cummax()
    dd   = (eq - peak) / peak
    max_dd = float(dd.min())

    # ── CAGR (annualized on bar-period basis) ──
    # Try to compute periods/year from index frequency
    try:
        days = (eq.index[-1] - eq.index[0]).total_seconds() / 86400.0
        years = max(days / 365.25, 1e-6)
        cagr = (1 + total_ret) ** (1 / years) - 1
    except Exception:
        cagr = total_ret

    # ── annualization factor for sharpe ──
    # Estimate bars per year from median delta
    try:
        delta_sec = pd.Series(eq.index).diff().dt.total_seconds().median()
        if delta_sec and delta_sec > 0:
            bars_per_year = (252 * 6.25 * 3600) / delta_sec  # NSE-like
        else:
            bars_per_year = 252
    except Exception:
        bars_per_year = 252

    std_r = rets.std()
    sharpe = _safe(rets.mean() / std_r * np.sqrt(bars_per_year)) if std_r and std_r > 0 else 0.0
    downside = rets[rets < 0]
    down_std = downside.std() if not downside.empty else 0.0
    sortino  = _safe(rets.mean() / down_std * np.sqrt(bars_per_year)) if down_std and down_std > 0 else 0.0
    calmar  = _safe(cagr / abs(max_dd)) if max_dd != 0 else 0.0

    # ── trade stats ──
    if trades is None or trades.empty:
        win_rate = pf = exp = avg_w = avg_l = 0.0
        n = 0
    else:
        n = len(trades)
        wins   = trades[trades["pnl"] > 0]["pnl"]
        losses = trades[trades["pnl"] <= 0]["pnl"]
        win_rate = len(wins) / n
        avg_w = float(wins.mean()) if not wins.empty else 0.0
        avg_l = float(losses.mean()) if not losses.empty else 0.0
        gross_p = float(wins.sum())
        gross_l = float(-losses.sum())
        pf  = _safe(gross_p / gross_l) if gross_l > 0 else (gross_p if gross_p > 0 else 0.0)
        exp = float(trades["pnl"].mean())

    # ── daily-5% counter (intraday goal) ──
    daily_ret = eq.resample("1D").last().pct_change().dropna()
    days_5pct = int((daily_ret >= 0.05).sum())
    avg_daily_ret = float(daily_ret.mean()) if not daily_ret.empty else 0.0

    return {
        "total_return":    _safe(total_ret),
        "cagr":            _safe(cagr),
        "sharpe":          _safe(sharpe),
        "sortino":         _safe(sortino),
        "max_drawdown":    _safe(max_dd),
        "win_rate":        _safe(win_rate),
        "profit_factor":   _safe(pf),
        "expectancy":      _safe(exp),
        "calmar":          _safe(calmar),
        "avg_win":         _safe(avg_w),
        "avg_loss":        _safe(avg_l),
        "total_trades":    int(n),
        "days_5pct":       days_5pct,
        "avg_daily_return": _safe(avg_daily_ret),
    }


def _empty(cap: float) -> Dict[str, float]:
    return {
        "total_return": 0, "cagr": 0, "sharpe": 0, "sortino": 0,
        "max_drawdown": 0, "win_rate": 0, "profit_factor": 0,
        "expectancy": 0, "calmar": 0, "avg_win": 0, "avg_loss": 0,
        "total_trades": 0, "days_5pct": 0, "avg_daily_return": 0,
    }


def monte_carlo(trades: pd.DataFrame, runs: int = 500,
                capital: float = 100_000) -> dict:
    """Simple bootstrap on trade P&L."""
    if trades is None or trades.empty:
        return {"runs": 0, "p5_final": capital, "median_final": capital, "p95_final": capital}
    pnls = trades["pnl"].to_numpy()
    n    = len(pnls)
    finals = []
    rng = np.random.default_rng(42)
    for _ in range(runs):
        sample = rng.choice(pnls, size=n, replace=True)
        finals.append(capital + sample.sum())
    finals = np.array(finals)
    return {
        "runs":          runs,
        "p5_final":      float(np.percentile(finals, 5)),
        "median_final":  float(np.median(finals)),
        "p95_final":     float(np.percentile(finals, 95)),
    }
