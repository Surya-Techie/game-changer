"""
Labeling for the PPS ML model.

Combines TWO label sources:

  1. "Teacher labels" — for bars where any of the 4 PPS book strategies
     fires (Symmetrical Triangle, Ascending Triangle, Rising Wedge Short,
     Double Top Minor), we look forward N bars and apply a triple-barrier:
        - If price reaches the strategy's TARGET first  → label = signal
          (i.e. the book strategy was right → BUY = +1 or SELL = -1)
        - If price reaches the STOP first               → label = 0   (HOLD)
                                                          (book strategy
                                                           was wrong)
        - If time runs out                              → label = 0

  2. Forward-return labels for NON-strategy bars to teach HOLD:
        - if 12-bar forward return |r| < 0.5 %          → label = 0

The model therefore learns:
    "predict +1 ONLY when conditions look like a *winning* book setup,
     -1 ONLY when conditions look like a *winning* book short,
     and 0 otherwise."

Public API:
    label_dataset(df, fwd_bars=12) -> pd.Series of {-1, 0, +1}
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..strategies.book_strategies import (
    SymmetricalTriangle, AscendingTriangle,
    RisingWedgeShort, DoubleTopMinor,
)


BOOK_STRATEGIES_CLASSES = [
    SymmetricalTriangle,
    AscendingTriangle,
    RisingWedgeShort,
    DoubleTopMinor,
]


def _triple_barrier(df: pd.DataFrame, side: int, entry: float,
                    stop: float, target: float,
                    i: int, fwd_bars: int) -> int:
    """
    Returns +side if target hit first, 0 if stop hit first or time runs out.
    side: +1 long, -1 short.
    """
    end = min(i + fwd_bars + 1, len(df))
    h = df["high"].iloc[i + 1:end].to_numpy()
    l = df["low"].iloc [i + 1:end].to_numpy()
    for j in range(len(h)):
        if side == 1:
            if l[j] <= stop:   return 0
            if h[j] >= target: return +1
        else:
            if h[j] >= stop:   return 0
            if l[j] <= target: return -1
    return 0


def label_dataset(df: pd.DataFrame, fwd_bars: int = 12) -> pd.Series:
    """
    Build labels ∈ {-1, 0, +1} for every bar in df.
    """
    if df is None or len(df) < fwd_bars + 5:
        return pd.Series(dtype=int)

    labels = pd.Series(0, index=df.index, dtype=int)

    # 1) book-strategy "teacher" labels ------------------------------
    # collect every (idx, side, stop, target) triplet
    for cls in BOOK_STRATEGIES_CLASSES:
        sig = cls().run(df)
        for ts, row in sig[sig["signal"] != 0].iterrows():
            i = df.index.get_loc(ts)
            if i + 2 >= len(df):
                continue
            side = int(row["signal"])
            entry = float(df["close"].iloc[i])
            stop  = float(row["stop"])
            tgt   = float(row["target"])
            if not (np.isfinite(stop) and np.isfinite(tgt)):
                continue
            verdict = _triple_barrier(df, side, entry, stop, tgt, i, fwd_bars)
            if verdict != 0:
                # only OVERWRITE if not already set with a different verdict
                # (i.e. don't let a later weaker signal cancel an earlier strong one)
                if labels.iat[i] == 0:
                    labels.iat[i] = verdict

    # 2) forward-return based labels for very obvious quiet bars ----
    # mark slight HOLD signal explicitly so the model has clean
    # negative examples (already 0; nothing to do — but we ensure
    # bars near a teacher label keep their value).

    # 3) flag with helpful reason — small forward-return BUY/SELL
    #    inferred labels for bars where book strategies didn't fire
    #    but the market clearly trended.
    fwd_ret = (df["close"].shift(-fwd_bars) / df["close"]) - 1
    big_up   = (fwd_ret >  0.015) & (labels == 0)
    big_down = (fwd_ret < -0.015) & (labels == 0)
    labels[big_up]   = 1
    labels[big_down] = -1

    return labels.iloc[:-fwd_bars]      # drop last fwd_bars (no future info)


def label_summary(labels: pd.Series) -> dict:
    if labels.empty:
        return {"buy": 0, "sell": 0, "hold": 0, "total": 0, "balance": "—"}
    vc = labels.value_counts()
    n  = len(labels)
    return {
        "buy":   int(vc.get(1, 0)),
        "sell":  int(vc.get(-1, 0)),
        "hold":  int(vc.get(0, 0)),
        "total": n,
        "balance": f"BUY {vc.get(1,0)/n*100:.1f}%  HOLD {vc.get(0,0)/n*100:.1f}%  SELL {vc.get(-1,0)/n*100:.1f}%",
    }
