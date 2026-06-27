"""
Strategy 7 — Master Confluence.

8-signal vote system. Only trades on score ≥ 5.

  +1 Supertrend bullish
  +1 EMA aligned (9 > 21 > 50)
  +1 RSI between 40-70
  +1 Price above VWAP
  +1 Volume > 1.5x average
  +1 Near key support/resistance (20-bar high/low touch)
  +1 Breakout from 20-bar consolidation
  +1 Book strategy signal confirms (symmetrical or ascending triangle)

TARGET: 5% or 3:1 R:R (whichever closer)
STOP:   1.5 × ATR
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict

import numpy as np
import pandas as pd

from .base_strategy import BaseStrategy
from ..indicators.custom_indicators import (
    ema, supertrend, rsi, vwap, atr, relative_volume,
    rolling_high, rolling_low,
    detect_symmetrical_triangle,
)


@dataclass
class MasterConfluence(BaseStrategy):
    name: str = "MasterConfluence"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "min_score":         5,
        "supertrend_period": 7,
        "supertrend_mult":   3.0,
        "ema_fast":          9,
        "ema_slow":         21,
        "ema_trend":        50,
        "rsi_period":       14,
        "consol_bars":      20,
        "vol_mult":          1.5,
        "target_pct":        0.05,
        "rr":                3.0,
        "atr_stop_mult":     1.5,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.params

        # ---- compute ingredients ----
        _, dir_  = supertrend(df, p["supertrend_period"], p["supertrend_mult"])
        e_f      = ema(df["close"], p["ema_fast"])
        e_s      = ema(df["close"], p["ema_slow"])
        e_t      = ema(df["close"], p["ema_trend"])
        r        = rsi(df["close"], p["rsi_period"])
        v        = vwap(df, group_by_session=True)
        rv       = relative_volume(df, 20)
        a        = atr(df, 14)
        hi_20    = rolling_high(df, p["consol_bars"])
        lo_20    = rolling_low (df, p["consol_bars"])
        tri      = detect_symmetrical_triangle(df, lookback=p["consol_bars"])

        # ── LONG votes ──
        s_long = pd.DataFrame(index=df.index)
        s_long["st"]      = (dir_ == 1).astype(int)
        s_long["ema"]     = ((e_f > e_s) & (e_s > e_t)).astype(int)
        s_long["rsi"]     = r.between(40, 70).astype(int)
        s_long["vwap"]    = (df["close"] > v).astype(int)
        s_long["vol"]     = (rv > p["vol_mult"]).astype(int)
        # Support-test vote: low TOUCHED prior support (within 0.5%) but held.
        # Touched-and-held means low dipped into the support band but close
        # recovered above it — that's a rejection, not a breakdown.
        prev_lo = lo_20.shift(1)
        touched_support = (df["low"] <= prev_lo * 1.005) & (df["low"] >= prev_lo * 0.99)
        held_support = df["close"] > prev_lo
        s_long["sr"]      = (touched_support & held_support).astype(int)
        s_long["brk"]     = (df["close"] > hi_20.shift(1)).astype(int)
        s_long["book"]    = (tri.astype(int))
        score_long = s_long.sum(axis=1)

        # ── SHORT votes ──
        s_short = pd.DataFrame(index=df.index)
        s_short["st"]   = (dir_ == -1).astype(int)
        s_short["ema"]  = ((e_f < e_s) & (e_s < e_t)).astype(int)
        s_short["rsi"]  = r.between(30, 60).astype(int)
        s_short["vwap"] = (df["close"] < v).astype(int)
        s_short["vol"]  = (rv > p["vol_mult"]).astype(int)
        # Resistance-test vote: high tagged prior resistance but rejected back.
        prev_hi = hi_20.shift(1)
        touched_resistance = (df["high"] >= prev_hi * 0.995) & (df["high"] <= prev_hi * 1.01)
        rejected_resistance = df["close"] < prev_hi
        s_short["sr"]   = (touched_resistance & rejected_resistance).astype(int)
        s_short["brk"]  = (df["close"] < lo_20.shift(1)).astype(int)
        s_short["book"] = (tri.astype(int))
        score_short = s_short.sum(axis=1)

        long_sig  = score_long  >= p["min_score"]
        short_sig = (score_short >= p["min_score"]) & ~long_sig

        out = self._empty_signals(df)

        # entries
        stop_long  = df["close"] - p["atr_stop_mult"] * a
        tgt_3r     = df["close"] + p["rr"] * (df["close"] - stop_long)
        tgt_5pct   = df["close"] * (1 + p["target_pct"])
        # take the closer of the two targets
        tgt_long   = pd.concat([tgt_3r, tgt_5pct], axis=1).min(axis=1)

        out.loc[long_sig, "signal"] = 1
        out.loc[long_sig, "stop"]   = stop_long[long_sig]
        out.loc[long_sig, "target"] = tgt_long[long_sig]
        out.loc[long_sig, "reason"] = "Master long (score " + score_long[long_sig].astype(int).astype(str) + "/8)"

        stop_short  = df["close"] + p["atr_stop_mult"] * a
        tgt_3r_s    = df["close"] - p["rr"] * (stop_short - df["close"])
        tgt_5pct_s  = df["close"] * (1 - p["target_pct"])
        tgt_short   = pd.concat([tgt_3r_s, tgt_5pct_s], axis=1).max(axis=1)

        out.loc[short_sig, "signal"] = -1
        out.loc[short_sig, "stop"]   = stop_short[short_sig]
        out.loc[short_sig, "target"] = tgt_short[short_sig]
        out.loc[short_sig, "reason"] = "Master short (score " + score_short[short_sig].astype(int).astype(str) + "/8)"
        return out
