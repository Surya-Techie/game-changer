"""
Strategy 2 — VWAP Momentum Scalp.
LONG: bounce off VWAP from below + RSI extreme + MACD turning up + volume spike.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict

import numpy as np
import pandas as pd

from .base_strategy import BaseStrategy
from ..indicators.custom_indicators import (
    vwap, vwap_bands, rsi, macd, atr, relative_volume,
)


@dataclass
class VWAPMomentumScalp(BaseStrategy):
    name: str = "VWAPMomentumScalp"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "rsi_period":     9,
        "macd_fast":      5,
        "macd_slow":      13,
        "macd_signal":    3,
        "vwap_std":       2.0,
        "target_pct":     0.015,
        "stop_atr_mult":  0.5,
        "vol_mult":       1.5,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p  = self.params
        v  = vwap(df, group_by_session=True)
        lo_band, mid, up_band = vwap_bands(df, p["vwap_std"])
        r  = rsi(df["close"], p["rsi_period"])
        m, s, h = macd(df["close"], p["macd_fast"], p["macd_slow"], p["macd_signal"])
        a  = atr(df, 14)
        rv = relative_volume(df, 20)

        # LONG bounce from below VWAP
        near_vwap_below = (df["close"] >= v * 0.998) & (df["low"] <= v) & (df["close"] < up_band)
        rsi_extreme_lo  = r < 40
        macd_turning_up = (h > h.shift(1)) & (h.shift(1) <= h.shift(2))
        vol_spike       = rv > p["vol_mult"]
        long_sig = near_vwap_below & rsi_extreme_lo & macd_turning_up & vol_spike

        # SHORT rejection at VWAP from above
        near_vwap_above = (df["close"] <= v * 1.002) & (df["high"] >= v) & (df["close"] > lo_band)
        rsi_extreme_hi  = r > 60
        macd_turning_dn = (h < h.shift(1)) & (h.shift(1) >= h.shift(2))
        short_sig = near_vwap_above & rsi_extreme_hi & macd_turning_dn & vol_spike

        out = self._empty_signals(df)
        out.loc[long_sig, "signal"] = 1
        out.loc[long_sig, "stop"]   = df["close"][long_sig] - p["stop_atr_mult"] * a[long_sig]
        out.loc[long_sig, "target"] = df["close"][long_sig] * (1 + p["target_pct"])
        out.loc[long_sig, "reason"] = "VWAP scalp long"

        out.loc[short_sig, "signal"] = -1
        out.loc[short_sig, "stop"]   = df["close"][short_sig] + p["stop_atr_mult"] * a[short_sig]
        out.loc[short_sig, "target"] = df["close"][short_sig] * (1 - p["target_pct"])
        out.loc[short_sig, "reason"] = "VWAP scalp short"
        return out
