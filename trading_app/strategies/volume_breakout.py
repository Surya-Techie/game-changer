"""
Strategy 6 — Tight Consolidation Volume Breakout.
HIGH CONVICTION (book reinforces: symmetrical triangle break).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict

import pandas as pd

from .base_strategy import BaseStrategy
from ..indicators.custom_indicators import atr, relative_volume


@dataclass
class VolumeBreakout(BaseStrategy):
    name: str = "VolumeBreakout"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "consolidation_bars": 20,
        "max_range_pct":      0.03,
        "volume_mult":        2.5,
        "target_rr":          3.0,
        "retest_entry":       True,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p  = self.params
        a  = atr(df, 14)
        rv = relative_volume(df, lookback=20)

        roll_hi = df["high"].rolling(p["consolidation_bars"]).max()
        roll_lo = df["low"].rolling(p["consolidation_bars"]).min()
        rng_pct = (roll_hi - roll_lo) / roll_lo
        tight   = rng_pct < p["max_range_pct"]

        # tight on previous bar, breakout this bar
        long_sig  = tight.shift(1) & (df["close"] > roll_hi.shift(1)) & (rv > p["volume_mult"])
        short_sig = tight.shift(1) & (df["close"] < roll_lo.shift(1)) & (rv > p["volume_mult"])

        out = self._empty_signals(df)
        rng = roll_hi.shift(1) - roll_lo.shift(1)
        out.loc[long_sig,  "signal"] = 1
        out.loc[long_sig,  "stop"]   = roll_lo.shift(1)[long_sig]
        out.loc[long_sig,  "target"] = df["close"][long_sig] + p["target_rr"] * rng[long_sig]
        out.loc[long_sig,  "reason"] = "VolBrk long"

        out.loc[short_sig, "signal"] = -1
        out.loc[short_sig, "stop"]   = roll_hi.shift(1)[short_sig]
        out.loc[short_sig, "target"] = df["close"][short_sig] - p["target_rr"] * rng[short_sig]
        out.loc[short_sig, "reason"] = "VolBrk short"
        return out
