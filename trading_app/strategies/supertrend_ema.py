"""
Strategy 4 — Supertrend + EMA stack confluence.
LONG: ST green + EMA9>EMA21>EMA50 + price pulls back to EMA21 + RSI 45-65.
HIGH CONVICTION (book reinforces with 18/40 MA trend filter).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict

import pandas as pd

from .base_strategy import BaseStrategy
from ..indicators.custom_indicators import ema, supertrend, rsi, atr


@dataclass
class SupertrendEMAScalp(BaseStrategy):
    name: str = "SupertrendEMAScalp"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "supertrend_period": 7,
        "supertrend_mult":   3.0,
        "ema_fast":          9,
        "ema_slow":         21,
        "ema_trend":        50,
        "rsi_period":       14,
        "target_atr_mult":  2.5,
        "stop_atr_mult":    1.0,
        "rsi_low":          45,
        "rsi_high":         65,
        "pullback_tol":    0.003,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.params
        e_f = ema(df["close"], p["ema_fast"])
        e_s = ema(df["close"], p["ema_slow"])
        e_t = ema(df["close"], p["ema_trend"])
        st, dir_ = supertrend(df, p["supertrend_period"], p["supertrend_mult"])
        r        = rsi(df["close"], p["rsi_period"])
        a        = atr(df, 14)

        up_stack   = (e_f > e_s) & (e_s > e_t)
        down_stack = (e_f < e_s) & (e_s < e_t)
        pull_to_21_up   = (df["low"]  <= e_s * (1 + p["pullback_tol"])) & (df["close"] > e_s)
        pull_to_21_dn   = (df["high"] >= e_s * (1 - p["pullback_tol"])) & (df["close"] < e_s)
        rsi_ok_lo  = r.between(p["rsi_low"], p["rsi_high"])
        rsi_ok_hi  = r.between(100 - p["rsi_high"], 100 - p["rsi_low"])

        long_sig  = (dir_ == 1)  & up_stack   & pull_to_21_up & rsi_ok_lo
        short_sig = (dir_ == -1) & down_stack & pull_to_21_dn & rsi_ok_hi

        out = self._empty_signals(df)
        out.loc[long_sig, "signal"] = 1
        out.loc[long_sig, "stop"]   = e_s[long_sig] - p["stop_atr_mult"] * a[long_sig]
        out.loc[long_sig, "target"] = df["close"][long_sig] + p["target_atr_mult"] * a[long_sig]
        out.loc[long_sig, "reason"] = "ST+EMA long pullback"

        out.loc[short_sig, "signal"] = -1
        out.loc[short_sig, "stop"]   = e_s[short_sig] + p["stop_atr_mult"] * a[short_sig]
        out.loc[short_sig, "target"] = df["close"][short_sig] - p["target_atr_mult"] * a[short_sig]
        out.loc[short_sig, "reason"] = "ST+EMA short pullback"
        return out
