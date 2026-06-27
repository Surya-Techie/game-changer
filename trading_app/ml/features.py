"""
Feature engineering for the PPS ML model.

Each row represents one OHLCV bar with derived features that mirror
the PPS book (18/40 MA filter, swing structure, pattern flags) plus
modern technical context (RSI, ATR%, VWAP distance, volume ratio).

Public API:
    FEATURE_COLS                          -> ordered list of feature names
    build_features(df)  -> pd.DataFrame   -> same index as df, NaN dropped
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..indicators.custom_indicators import (
    sma, ema, rsi, atr, vwap, relative_volume, macd, bbands,
    swing_high_low, true_range,
    detect_symmetrical_triangle as _sym,
    detect_rising_wedge        as _wedge_up,
    detect_falling_wedge       as _wedge_dn,
)


FEATURE_COLS = [
    # momentum (multi-period)
    "rsi_5", "rsi_9", "rsi_14", "rsi_20",
    # MACD
    "macd_hist", "macd_hist_chg",
    # volatility
    "atr_pct", "atr_pct_chg",
    # location relative to anchors
    "dist_vwap", "dist_ma18", "dist_ma40", "dist_ema9", "dist_ema21",
    # trend strength
    "ma18_slope", "ma40_slope", "trend_regime",
    # bollinger
    "bb_pos",  # 0..1 position inside band
    # liquidity
    "vol_ratio", "vol_ratio_chg",
    # short-term momentum
    "ret_1", "ret_5", "ret_20",
    "roc_10",
    # swing structure
    "dist_swing_high", "dist_swing_low",
    # PPS book pattern flags
    "tri_active", "wedge_up_active", "wedge_dn_active",
    # range expansion
    "range_pct", "range_pct_chg",
    # context
    "hour_of_day", "minute_of_day",
]


def _safe_pct(num: pd.Series, den: pd.Series) -> pd.Series:
    den = den.replace(0, np.nan)
    return (num / den) - 1.0


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    df: OHLCV with DatetimeIndex (any tz).
    Returns DataFrame with FEATURE_COLS; rows with any NaN dropped.
    """
    if df is None or len(df) < 60:
        return pd.DataFrame(columns=FEATURE_COLS)

    close = df["close"]
    out = pd.DataFrame(index=df.index)

    # ── momentum (multi-period RSI) ──
    out["rsi_5"]  = rsi(close, 5)
    out["rsi_9"]  = rsi(close, 9)
    out["rsi_14"] = rsi(close, 14)
    out["rsi_20"] = rsi(close, 20)

    # ── MACD histogram + change ──
    _, _, hist = macd(close, 12, 26, 9)
    out["macd_hist"]     = hist
    out["macd_hist_chg"] = hist.diff()

    # ── volatility ──
    a = atr(df, 14)
    out["atr_pct"]     = a / close
    out["atr_pct_chg"] = (a / close).pct_change(3)

    # ── anchors ──
    v    = vwap(df, group_by_session=True)
    ma18 = sma(close, 18)
    ma40 = sma(close, 40)
    e9   = ema(close, 9)
    e21  = ema(close, 21)
    out["dist_vwap"]  = _safe_pct(close, v)
    out["dist_ma18"]  = _safe_pct(close, ma18)
    out["dist_ma40"]  = _safe_pct(close, ma40)
    out["dist_ema9"]  = _safe_pct(close, e9)
    out["dist_ema21"] = _safe_pct(close, e21)

    # ── trend slopes ──
    out["ma18_slope"] = ma18.pct_change(3)
    out["ma40_slope"] = ma40.pct_change(5)

    # ── book's trend regime ──
    up = (ma18 > ma40) & (ma18.diff() > 0) & (ma40.diff() >= 0)
    dn = (ma18 < ma40) & (ma18.diff() < 0) & (ma40.diff() <= 0)
    trend = pd.Series(0, index=df.index, dtype=int)
    trend[up] =  1
    trend[dn] = -1
    out["trend_regime"] = trend

    # ── Bollinger position (0=low band, 1=high band) ──
    bb_lo, bb_mid, bb_up = bbands(close, 20, 2.0)
    width  = (bb_up - bb_lo).replace(0, np.nan)
    out["bb_pos"] = ((close - bb_lo) / width).clip(-0.5, 1.5)

    # ── volume ──
    rv = relative_volume(df, 20).fillna(1.0)
    out["vol_ratio"]     = rv
    out["vol_ratio_chg"] = rv.pct_change(3)

    # ── short-term returns + ROC ──
    out["ret_1"]  = close.pct_change(1)
    out["ret_5"]  = close.pct_change(5)
    out["ret_20"] = close.pct_change(20)
    out["roc_10"] = close.pct_change(10)

    # ── swing structure (book's power-of-two) ──
    sh, sl = swing_high_low(df, lookback=2)
    h_last = df["high"].where(sh).ffill()
    l_last = df["low"].where(sl).ffill()
    out["dist_swing_high"] = _safe_pct(close, h_last)
    out["dist_swing_low"]  = _safe_pct(close, l_last)

    # ── PPS-book pattern flags ──
    out["tri_active"]      = _sym(df, lookback=20).astype(int)
    out["wedge_up_active"] = _wedge_up(df, lookback=20).astype(int)
    out["wedge_dn_active"] = _wedge_dn(df, lookback=20).astype(int)

    # ── range expansion ──
    bar_rng = df["high"] - df["low"]
    rng_pct = (bar_rng / bar_rng.rolling(20).mean()).fillna(1.0)
    out["range_pct"]     = rng_pct
    out["range_pct_chg"] = rng_pct.pct_change(3)

    # ── time-of-day context (intraday session position) ──
    if isinstance(df.index, pd.DatetimeIndex):
        out["hour_of_day"]   = df.index.hour.astype(float)
        out["minute_of_day"] = (df.index.hour * 60 + df.index.minute).astype(float)
    else:
        out["hour_of_day"]   = 0.0
        out["minute_of_day"] = 0.0

    out = out[FEATURE_COLS]
    out = out.replace([np.inf, -np.inf], np.nan).dropna()
    return out
