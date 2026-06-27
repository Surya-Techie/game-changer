"""
Strategy 5 — RSI Divergence Reversal.
BULLISH: price LL + RSI HL + bullish engulfing → long.
HIGH CONVICTION (book reinforces with double-top / minor-top reversal).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict

import pandas as pd

from .base_strategy import BaseStrategy
from ..indicators.custom_indicators import (
    rsi, atr,
    bullish_divergence, bearish_divergence,
    detect_bullish_engulfing, detect_bearish_engulfing,
)


@dataclass
class RSIDivergenceReversal(BaseStrategy):
    name: str = "RSIDivergenceReversal"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "rsi_period":          14,
        "divergence_lookback": 20,
        "target_rr":            4.0,
        "max_stop_pct":         0.02,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p   = self.params
        r   = rsi(df["close"], p["rsi_period"])
        a   = atr(df, 14)
        bdiv = bullish_divergence(df["close"], r, p["divergence_lookback"])
        ddiv = bearish_divergence(df["close"], r, p["divergence_lookback"])
        be   = detect_bullish_engulfing(df)
        re_  = detect_bearish_engulfing(df)

        long_sig  = bdiv & be
        short_sig = ddiv & re_

        out = self._empty_signals(df)
        out.loc[long_sig, "signal"] = 1
        # stop = below confirmation candle low ; cap at max_stop_pct
        cand_low  = df["low"]
        stop_long = pd.concat(
            [cand_low, df["close"] * (1 - p["max_stop_pct"])], axis=1
        ).min(axis=1)
        out.loc[long_sig, "stop"]   = stop_long[long_sig]
        out.loc[long_sig, "target"] = df["close"][long_sig] + p["target_rr"] * (df["close"][long_sig] - stop_long[long_sig])
        out.loc[long_sig, "reason"] = "RSI bull-div + engulf"

        out.loc[short_sig, "signal"] = -1
        cand_high  = df["high"]
        stop_short = pd.concat(
            [cand_high, df["close"] * (1 + p["max_stop_pct"])], axis=1
        ).max(axis=1)
        out.loc[short_sig, "stop"]   = stop_short[short_sig]
        out.loc[short_sig, "target"] = df["close"][short_sig] - p["target_rr"] * (stop_short[short_sig] - df["close"][short_sig])
        out.loc[short_sig, "reason"] = "RSI bear-div + engulf"
        return out
