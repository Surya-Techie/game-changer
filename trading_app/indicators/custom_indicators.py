"""
Pure-pandas indicators. No external TA library required.
All functions take a price Series or OHLCV DataFrame and return a Series.

Implemented:
    sma, ema, rsi, atr, true_range, vwap, vwap_bands,
    macd, supertrend, bbands, swing_high_low,
    rolling_high, rolling_low, opening_range,
    relative_volume, slope, zscore,
    detect_bullish_engulfing, detect_bearish_engulfing,
    detect_rising_wedge, detect_falling_wedge,
    detect_symmetrical_triangle  (book pattern)
"""
from __future__ import annotations
from typing import Tuple

import numpy as np
import pandas as pd


# ── Moving averages ────────────────────────────────────────────
def sma(s: pd.Series, length: int) -> pd.Series:
    return s.rolling(length, min_periods=length).mean()


def ema(s: pd.Series, length: int) -> pd.Series:
    return s.ewm(span=length, adjust=False, min_periods=length).mean()


# ── True range / ATR ───────────────────────────────────────────
def true_range(df: pd.DataFrame) -> pd.Series:
    h, l, c = df["high"], df["low"], df["close"].shift(1)
    return pd.concat([(h - l), (h - c).abs(), (l - c).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, length: int = 14) -> pd.Series:
    return true_range(df).rolling(length, min_periods=length).mean()


# ── Momentum ───────────────────────────────────────────────────
def rsi(s: pd.Series, length: int = 14) -> pd.Series:
    delta = s.diff()
    gain  = delta.clip(lower=0.0)
    loss  = (-delta).clip(lower=0.0)
    avg_g = gain.ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    avg_l = loss.ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    rs = avg_g / avg_l.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def macd(s: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
         ) -> Tuple[pd.Series, pd.Series, pd.Series]:
    macd_line   = ema(s, fast) - ema(s, slow)
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    hist        = macd_line - signal_line
    return macd_line, signal_line, hist


# ── Volume / VWAP ──────────────────────────────────────────────
def vwap(df: pd.DataFrame, group_by_session: bool = True) -> pd.Series:
    """
    Volume-weighted average price. If group_by_session=True, resets daily
    (using df.index.date) — required for intraday VWAP.
    """
    tp  = (df["high"] + df["low"] + df["close"]) / 3.0
    pv  = tp * df["volume"]
    if group_by_session and isinstance(df.index, pd.DatetimeIndex):
        d   = df.index.date
        num = pv.groupby(d).cumsum()
        den = df["volume"].groupby(d).cumsum().replace(0, np.nan)
    else:
        num = pv.cumsum()
        den = df["volume"].cumsum().replace(0, np.nan)
    return num / den


def vwap_bands(df: pd.DataFrame, n_std: float = 2.0
               ) -> Tuple[pd.Series, pd.Series, pd.Series]:
    v   = vwap(df, group_by_session=True)
    tp  = (df["high"] + df["low"] + df["close"]) / 3.0
    if isinstance(df.index, pd.DatetimeIndex):
        d = df.index.date
        std = (tp - v).groupby(d).expanding().std().reset_index(level=0, drop=True)
    else:
        std = (tp - v).expanding().std()
    return v - n_std * std, v, v + n_std * std


def relative_volume(df: pd.DataFrame, lookback: int = 20) -> pd.Series:
    avg = df["volume"].rolling(lookback, min_periods=lookback).mean()
    return df["volume"] / avg.replace(0, np.nan)


# ── Supertrend ─────────────────────────────────────────────────
def supertrend(df: pd.DataFrame, length: int = 7, mult: float = 3.0
               ) -> Tuple[pd.Series, pd.Series]:
    """
    Returns (supertrend_value, direction[+1/-1]).
    """
    hl2 = (df["high"] + df["low"]) / 2.0
    a   = atr(df, length)
    upper = hl2 + mult * a
    lower = hl2 - mult * a

    # final bands
    fu = upper.copy()
    fl = lower.copy()
    for i in range(1, len(df)):
        fu.iloc[i] = min(upper.iloc[i], fu.iloc[i - 1]) \
            if (df["close"].iloc[i - 1] > fu.iloc[i - 1]) else upper.iloc[i]
        fl.iloc[i] = max(lower.iloc[i], fl.iloc[i - 1]) \
            if (df["close"].iloc[i - 1] < fl.iloc[i - 1]) else lower.iloc[i]

    st   = pd.Series(index=df.index, dtype=float)
    dir_ = pd.Series(index=df.index, dtype=float)
    st.iloc[0]   = fu.iloc[0]
    dir_.iloc[0] = -1
    for i in range(1, len(df)):
        if st.iloc[i - 1] == fu.iloc[i - 1]:
            if df["close"].iloc[i] > fu.iloc[i]:
                st.iloc[i], dir_.iloc[i] = fl.iloc[i], 1
            else:
                st.iloc[i], dir_.iloc[i] = fu.iloc[i], -1
        else:
            if df["close"].iloc[i] < fl.iloc[i]:
                st.iloc[i], dir_.iloc[i] = fu.iloc[i], -1
            else:
                st.iloc[i], dir_.iloc[i] = fl.iloc[i], 1
    return st, dir_


# ── Bollinger ──────────────────────────────────────────────────
def bbands(s: pd.Series, length: int = 20, mult: float = 2.0
           ) -> Tuple[pd.Series, pd.Series, pd.Series]:
    m  = s.rolling(length, min_periods=length).mean()
    sd = s.rolling(length, min_periods=length).std()
    return m - mult * sd, m, m + mult * sd


# ── Swings ─────────────────────────────────────────────────────
def swing_high_low(df: pd.DataFrame, lookback: int = 2
                   ) -> Tuple[pd.Series, pd.Series]:
    """
    Book's Power-of-Two swing detection (default lookback=2 bars each side).
    Returns (swing_high_bool, swing_low_bool).
    """
    h, l = df["high"], df["low"]
    is_high = pd.Series(False, index=df.index)
    is_low  = pd.Series(False, index=df.index)
    for i in range(lookback, len(df) - lookback):
        wh = h.iloc[i - lookback:i + lookback + 1]
        wl = l.iloc[i - lookback:i + lookback + 1]
        if h.iloc[i] == wh.max():
            is_high.iloc[i] = True
        if l.iloc[i] == wl.min():
            is_low.iloc[i] = True
    return is_high, is_low


def rolling_high(df: pd.DataFrame, n: int) -> pd.Series:
    return df["high"].rolling(n, min_periods=n).max()


def rolling_low(df: pd.DataFrame, n: int) -> pd.Series:
    return df["low"].rolling(n, min_periods=n).min()


# ── Opening range (intraday) ───────────────────────────────────
def opening_range(df_ist: pd.DataFrame, minutes: int = 15
                  ) -> Tuple[pd.Series, pd.Series]:
    """
    Expects df with IST DatetimeIndex.
    Returns (or_high, or_low) constant per day from 09:15 → 09:15+minutes.
    """
    from datetime import time as _time
    minutes = int(minutes)        # tolerate float (e.g. from optimizer grids)
    start = _time(9, 15)
    end_h = 9 + (15 + minutes) // 60
    end_m = (15 + minutes) % 60
    end   = _time(end_h, end_m)

    out_h = pd.Series(np.nan, index=df_ist.index)
    out_l = pd.Series(np.nan, index=df_ist.index)
    for day, g in df_ist.groupby(df_ist.index.date):
        win = g.between_time(start, end, inclusive="left")
        if win.empty:
            continue
        hi, lo = win["high"].max(), win["low"].min()
        out_h.loc[g.index] = hi
        out_l.loc[g.index] = lo
    return out_h, out_l


# ── Misc ───────────────────────────────────────────────────────
def slope(s: pd.Series, length: int = 5) -> pd.Series:
    """OLS slope of the last `length` values (per-bar, vectorized via diff sum)."""
    return (s - s.shift(length)) / length


def zscore(s: pd.Series, length: int = 20) -> pd.Series:
    m  = s.rolling(length).mean()
    sd = s.rolling(length).std()
    return (s - m) / sd.replace(0, np.nan)


# ── Candle patterns ────────────────────────────────────────────
def detect_bullish_engulfing(df: pd.DataFrame) -> pd.Series:
    o, c = df["open"], df["close"]
    prev_red    = c.shift(1) < o.shift(1)
    cur_green   = c > o
    engulf_body = (c >= o.shift(1)) & (o <= c.shift(1))
    return prev_red & cur_green & engulf_body


def detect_bearish_engulfing(df: pd.DataFrame) -> pd.Series:
    o, c = df["open"], df["close"]
    prev_green  = c.shift(1) > o.shift(1)
    cur_red     = c < o
    engulf_body = (o >= c.shift(1)) & (c <= o.shift(1))
    return prev_green & cur_red & engulf_body


# ── Book patterns (simplified detectors) ───────────────────────
def detect_symmetrical_triangle(df: pd.DataFrame, lookback: int = 20,
                                slope_tol: float = 0.4) -> pd.Series:
    """
    Detect a converging triangle: upper trendline sloping down, lower up.
    Returns boolean Series — True on bars where pattern is currently in force.

    Heuristic (good enough for intraday):
      - 4-bar swing highs trending DOWN (slope < -slope_tol·ATR)
      - 4-bar swing lows  trending UP   (slope > +slope_tol·ATR)
      - Range contracting (last-bar range < first-bar range)
    """
    sh, sl = swing_high_low(df, lookback=2)
    a       = atr(df, 14)
    out     = pd.Series(False, index=df.index)
    h       = df["high"].where(sh)
    l       = df["low"].where(sl)
    h_last  = h.ffill()
    l_last  = l.ffill()
    h_slope = (h_last - h_last.shift(lookback)) / lookback
    l_slope = (l_last - l_last.shift(lookback)) / lookback
    cond = (
        (h_slope < -slope_tol * a) &
        (l_slope >  slope_tol * a) &
        (df["high"] - df["low"] < (df["high"] - df["low"]).shift(lookback))
    )
    return cond.fillna(False)


def detect_rising_wedge(df: pd.DataFrame, lookback: int = 20) -> pd.Series:
    """
    Rising wedge = both highs AND lows rising, but highs rising slower → converging up.
    Book: short on lower-trendline break.
    """
    sh, sl = swing_high_low(df, lookback=2)
    h_last = df["high"].where(sh).ffill()
    l_last = df["low"].where(sl).ffill()
    h_slope = (h_last - h_last.shift(lookback)) / lookback
    l_slope = (l_last - l_last.shift(lookback)) / lookback
    return ((h_slope > 0) & (l_slope > 0) & (l_slope > h_slope)).fillna(False)


def detect_falling_wedge(df: pd.DataFrame, lookback: int = 20) -> pd.Series:
    sh, sl = swing_high_low(df, lookback=2)
    h_last = df["high"].where(sh).ffill()
    l_last = df["low"].where(sl).ffill()
    h_slope = (h_last - h_last.shift(lookback)) / lookback
    l_slope = (l_last - l_last.shift(lookback)) / lookback
    return ((h_slope < 0) & (l_slope < 0) & (h_slope > l_slope)).fillna(False)


# ── divergence helper (used by RSIDivergenceReversal) ──────────
def bullish_divergence(price: pd.Series, ind: pd.Series, lookback: int = 20
                       ) -> pd.Series:
    """
    Price makes a lower low within `lookback`, indicator makes a higher low.
    Computed using rolling argmin.
    """
    out = pd.Series(False, index=price.index)
    for i in range(lookback, len(price)):
        p_win = price.iloc[i - lookback:i + 1]
        i_win = ind.iloc[i - lookback:i + 1]
        if len(p_win) < 5:
            continue
        # current low vs earlier low (split window in halves)
        half        = lookback // 2
        p_low_recent  = p_win.iloc[half:].min()
        p_low_earlier = p_win.iloc[:half].min()
        i_low_recent  = i_win.iloc[half:].min()
        i_low_earlier = i_win.iloc[:half].min()
        if p_low_recent < p_low_earlier and i_low_recent > i_low_earlier:
            out.iloc[i] = True
    return out


def bearish_divergence(price: pd.Series, ind: pd.Series, lookback: int = 20
                       ) -> pd.Series:
    out = pd.Series(False, index=price.index)
    for i in range(lookback, len(price)):
        p_win = price.iloc[i - lookback:i + 1]
        i_win = ind.iloc[i - lookback:i + 1]
        if len(p_win) < 5:
            continue
        half = lookback // 2
        p_h_recent  = p_win.iloc[half:].max()
        p_h_earlier = p_win.iloc[:half].max()
        i_h_recent  = i_win.iloc[half:].max()
        i_h_earlier = i_win.iloc[:half].max()
        if p_h_recent > p_h_earlier and i_h_recent < i_h_earlier:
            out.iloc[i] = True
    return out
