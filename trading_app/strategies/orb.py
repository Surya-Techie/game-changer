"""
Strategy 1 — Opening Range Breakout (ORB)

HIGH CONVICTION (book reinforces: symmetrical-triangle break at the open).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import time
from typing import Any, Dict

import numpy as np
import pandas as pd

from .base_strategy import BaseStrategy
from ..indicators.custom_indicators import opening_range, relative_volume, atr


@dataclass
class OpeningRangeBreakout(BaseStrategy):
    name: str = "OpeningRangeBreakout"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "orb_minutes":          15,
        "breakout_buffer":      0.002,
        "volume_confirm_mult":  2.0,
        "target_rr":            3.0,
        "max_trades_per_day":   2,
        "min_range_pct":        0.005,
        "force_close":          time(14, 30),    # no new entries after this
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        if not isinstance(df.index, pd.DatetimeIndex) or df.index.tz is None:
            return self._empty_signals(df)

        p   = self.params
        orb_min = int(p["orb_minutes"])          # tolerate float from optimizer
        oh, ol = opening_range(df, minutes=orb_min)
        rv     = relative_volume(df, lookback=20)
        rng    = oh - ol
        rng_ok = (rng / df["close"]) >= p["min_range_pct"]

        # entries only between (open + ORB) and force_close
        from datetime import time as _t
        entry_start = _t(9 + (15 + orb_min) // 60, (15 + orb_min) % 60)
        entry_end   = p["force_close"]
        in_window   = (df.index.time >= entry_start) & (df.index.time < entry_end)

        long_brk  = (df["close"] > oh * (1 + p["breakout_buffer"])) & (rv > p["volume_confirm_mult"]) & rng_ok & in_window
        short_brk = (df["close"] < ol * (1 - p["breakout_buffer"])) & (rv > p["volume_confirm_mult"]) & rng_ok & in_window

        # max-trades-per-day filter (vectorized)
        day = df.index.date
        ok_long  = self._first_n_per_day(long_brk,  day, p["max_trades_per_day"])
        ok_short = self._first_n_per_day(short_brk, day, p["max_trades_per_day"])

        out = self._empty_signals(df)
        out.loc[ok_long,  "signal"] = 1
        out.loc[ok_long,  "stop"]   = ol[ok_long]
        out.loc[ok_long,  "target"] = df["close"][ok_long] + p["target_rr"] * rng[ok_long]
        out.loc[ok_long,  "reason"] = "ORB long"

        out.loc[ok_short, "signal"] = -1
        out.loc[ok_short, "stop"]   = oh[ok_short]
        out.loc[ok_short, "target"] = df["close"][ok_short] - p["target_rr"] * rng[ok_short]
        out.loc[ok_short, "reason"] = "ORB short"
        return out

    @staticmethod
    def _first_n_per_day(mask: pd.Series, days, n: int) -> pd.Series:
        idx = mask.index
        s   = pd.Series(mask.values, index=days)
        s   = s.groupby(level=0).cumsum() <= n
        return pd.Series(s.values & mask.values, index=idx)
