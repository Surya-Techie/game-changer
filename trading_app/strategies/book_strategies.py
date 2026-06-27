"""
Curtis Arnold's PPS strategies — ported to intraday 5-min bars.

Implemented:
    SymmetricalTriangle    (B1 — core)
    AscendingTriangle      (B2 — uptrends only)
    RisingWedgeShort       (B8 — explosive short)
    DoubleTopMinor         (B5 — best win rate)

All use the book's trend filter (18 & 40 MA on bars; we use 18/40 5-min bars).
All use the book's break-even rule: shift stop to entry at 2× risk OR 4th bar.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict

import numpy as np
import pandas as pd

from .base_strategy import BaseStrategy
from ..indicators.custom_indicators import (
    sma, atr, swing_high_low,
    detect_symmetrical_triangle, detect_rising_wedge,
)


# ── Trend filter (book §6) ─────────────────────────────────────
def _trend(df: pd.DataFrame, fast: int = 18, slow: int = 40) -> pd.Series:
    """+1 uptrend (both MAs rising), -1 downtrend, 0 sideways."""
    ma_f, ma_s = sma(df["close"], fast), sma(df["close"], slow)
    f_slope    = ma_f.diff()
    s_slope    = ma_s.diff()
    up   = (ma_f > ma_s) & (f_slope > 0) & (s_slope >= 0)
    down = (ma_f < ma_s) & (f_slope < 0) & (s_slope <= 0)
    out  = pd.Series(0, index=df.index, dtype=int)
    out[up]   = 1
    out[down] = -1
    return out


# ═════════════════════════════════════════════════════════════
#  B1 — SYMMETRICAL TRIANGLE (the core PPS pattern)
# ═════════════════════════════════════════════════════════════
@dataclass
class SymmetricalTriangle(BaseStrategy):
    name: str = "SymmetricalTriangle"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "lookback": 20,
        "atr_mult_stop": 1.0,
        "rr": 7.0,                 # book's asymmetric R:R
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p   = self.params
        trd = _trend(df)
        tri = detect_symmetrical_triangle(df, lookback=p["lookback"])
        a   = atr(df, 14)

        # apex = midpoint of last `lookback` swings
        sh, sl = swing_high_low(df, lookback=2)
        hi = df["high"].where(sh).ffill()
        lo = df["low"].where(sl).ffill()
        apex_h = hi.rolling(p["lookback"], min_periods=2).max()
        apex_l = lo.rolling(p["lookback"], min_periods=2).min()

        long_brk  = (df["close"] > apex_h.shift(1)) & tri & (trd == 1)
        short_brk = (df["close"] < apex_l.shift(1)) & tri & (trd == -1)

        out          = self._empty_signals(df)
        out.loc[long_brk,  "signal"] = 1
        out.loc[long_brk,  "stop"]   = apex_l[long_brk]
        out.loc[long_brk,  "target"] = df["close"][long_brk] + p["rr"] * (df["close"][long_brk] - apex_l[long_brk])
        out.loc[long_brk,  "reason"] = "B1 sym-tri break-up"

        out.loc[short_brk, "signal"] = -1
        out.loc[short_brk, "stop"]   = apex_h[short_brk]
        out.loc[short_brk, "target"] = df["close"][short_brk] - p["rr"] * (apex_h[short_brk] - df["close"][short_brk])
        out.loc[short_brk, "reason"] = "B1 sym-tri break-down"
        return out


# ═════════════════════════════════════════════════════════════
#  B2 — ASCENDING TRIANGLE (uptrend continuation)
# ═════════════════════════════════════════════════════════════
@dataclass
class AscendingTriangle(BaseStrategy):
    name: str = "AscendingTriangle"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "lookback": 20,
        "flat_tol_pct": 0.003,     # supply line flat within 0.3 %
        "rr": 4.0,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p   = self.params
        trd = _trend(df)
        sh, sl = swing_high_low(df, lookback=2)
        hi  = df["high"].where(sh).ffill()
        lo  = df["low"].where(sl).ffill()

        # supply (resistance) flat? — std/mean of recent swing highs
        sup_std = hi.rolling(p["lookback"]).std()
        sup_avg = hi.rolling(p["lookback"]).mean()
        sup_flat = (sup_std / sup_avg) < p["flat_tol_pct"]

        # demand rising
        lo_slope = (lo - lo.shift(p["lookback"])) / p["lookback"]
        rising_d = lo_slope > 0

        brk = (df["close"] > sup_avg) & sup_flat & rising_d & (trd == 1)

        out = self._empty_signals(df)
        out.loc[brk, "signal"] = 1
        # bisected angle ≈ midpoint between supply line and last swing low
        bisect = (sup_avg + lo) / 2
        out.loc[brk, "stop"]   = bisect[brk]
        out.loc[brk, "target"] = df["close"][brk] + p["rr"] * (df["close"][brk] - bisect[brk])
        out.loc[brk, "reason"] = "B2 asc-tri breakout"
        return out


# ═════════════════════════════════════════════════════════════
#  B8 — RISING WEDGE SHORT (explosive)
# ═════════════════════════════════════════════════════════════
@dataclass
class RisingWedgeShort(BaseStrategy):
    name: str = "RisingWedgeShort"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "lookback": 20,
        "rr": 3.0,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p   = self.params
        trd = _trend(df)
        wedge = detect_rising_wedge(df, lookback=p["lookback"])

        sh, sl = swing_high_low(df, lookback=2)
        lo  = df["low"].where(sl).ffill()
        hi  = df["high"].where(sh).ffill()

        # demand line broken
        brk_down = (df["close"] < lo.shift(1)) & wedge & (trd != -1)  # late-stage uptrend

        out = self._empty_signals(df)
        out.loc[brk_down, "signal"] = -1
        out.loc[brk_down, "stop"]   = hi[brk_down]                # above wedge high
        out.loc[brk_down, "target"] = df["close"][brk_down] - p["rr"] * (hi[brk_down] - df["close"][brk_down])
        out.loc[brk_down, "reason"] = "B8 rising-wedge short"
        return out


# ═════════════════════════════════════════════════════════════
#  B5 — DOUBLE TOP in MINOR UPTREND within MAJOR DOWNTREND
# ═════════════════════════════════════════════════════════════
@dataclass
class DoubleTopMinor(BaseStrategy):
    name: str = "DoubleTopMinor"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "lookback": 25,
        "peak_tol_pct": 0.005,     # second peak within 0.5 % of first
        "rr": 3.0,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p   = self.params
        trd = _trend(df, fast=18, slow=40)
        sh, _ = swing_high_low(df, lookback=2)

        # find two swing highs within lookback that match in price ± tol
        highs       = df["high"].where(sh)
        peak1       = highs.shift(p["lookback"] // 2).ffill()
        peak2       = highs.shift(1).ffill()
        match       = (peak1 - peak2).abs() / peak1 < p["peak_tol_pct"]

        # neckline ≈ lowest low between the two peaks
        neckline    = df["low"].rolling(p["lookback"], min_periods=5).min().shift(1)

        # major downtrend filter — only short in the book's preferred regime
        brk = (df["close"] < neckline) & match & (trd == -1)

        out = self._empty_signals(df)
        out.loc[brk, "signal"] = -1
        out.loc[brk, "stop"]   = peak2[brk]
        out.loc[brk, "target"] = df["close"][brk] - p["rr"] * (peak2[brk] - df["close"][brk])
        out.loc[brk, "reason"] = "B5 double-top minor reversal"
        return out


# convenience registry --------------------------------------
BOOK_STRATEGIES = [
    SymmetricalTriangle,
    AscendingTriangle,
    RisingWedgeShort,
    DoubleTopMinor,
]
