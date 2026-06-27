"""
Grid-search optimizer + walk-forward analysis.

grid_search(strategy_cls, df, param_grid, target='sharpe')
walk_forward(strategy_cls, df, train_pct=0.7)
"""
from __future__ import annotations
from itertools import product
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from .. import config
from .engine import Backtester


def grid_search(
    strategy_cls,
    df: pd.DataFrame,
    param_grid: Dict[str, List[Any]],
    target: str = "sharpe",
    capital: float = config.CAPITAL,
) -> pd.DataFrame:
    """
    Cartesian-product all parameter combinations; returns sorted DataFrame.
    """
    # snapshot defaults so partial grids don't blow away required keys
    defaults = dict(strategy_cls().params)
    keys     = list(param_grid.keys())
    rows     = []
    for combo in product(*param_grid.values()):
        params  = dict(zip(keys, combo))
        merged  = {**defaults, **params}
        strat   = strategy_cls(params=merged)
        sig     = strat.run(df)
        result  = Backtester(capital=capital).run(df, sig)
        m       = result["metrics"]
        rows.append({**params, **m})
    out = pd.DataFrame(rows)
    if target in out.columns:
        out = out.sort_values(target, ascending=False).reset_index(drop=True)
    return out


def walk_forward(
    strategy_cls,
    df: pd.DataFrame,
    param_grid: Dict[str, List[Any]] | None = None,
    train_pct: float = config.TRAIN_PCT,
    capital:   float = config.CAPITAL,
    target:    str   = "sharpe",
) -> dict:
    """
    Optimize on first `train_pct` of data → apply best params to test set.
    If param_grid is None, run default params on both halves.
    """
    cut   = int(len(df) * train_pct)
    train = df.iloc[:cut]
    test  = df.iloc[cut:]

    defaults = dict(strategy_cls().params)
    if param_grid:
        gs = grid_search(strategy_cls, train, param_grid, target, capital)
        best = gs.iloc[0].to_dict()
        best_params = {k: best[k] for k in param_grid.keys()}
        merged      = {**defaults, **best_params}
    else:
        best_params = {}
        merged      = defaults

    strat_test = strategy_cls(params=merged)
    sig        = strat_test.run(test)
    test_res   = Backtester(capital=capital).run(test, sig)

    strat_tr   = strategy_cls(params=merged)
    sig_tr     = strat_tr.run(train)
    train_res  = Backtester(capital=capital).run(train, sig_tr)

    return {
        "best_params":     best_params,
        "train_metrics":   train_res["metrics"],
        "test_metrics":    test_res["metrics"],
        "train_equity":    train_res["equity"],
        "test_equity":     test_res["equity"],
        "test_trades":     test_res["trades"],
    }
