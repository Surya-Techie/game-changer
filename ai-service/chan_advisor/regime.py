"""Market regime detection — proxies for the VIX-based rules in the prompt.

We don't always have live VIX for an arbitrary single-stock query, so we
compute a *regime-equivalent* from the symbol's own data:

  realized_vol_annualized = stdev(daily_returns_60d) * sqrt(252)
  trend_strength = ADX(14)
  hurst_exponent = Hurst on log-returns over the last 100 bars
  range_pct = (high - low over 30d) / mean_close * 100

These get mapped to the prompt's VIX bands (R-4):
    realized_vol < 15  → CALM
    realized_vol 15-25 → NORMAL
    realized_vol 25-30 → ELEVATED
    realized_vol > 30  → CRISIS
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np
import pandas as pd


RegimeBand = Literal["CALM", "NORMAL", "ELEVATED", "CRISIS"]
TrendState = Literal["UP", "DOWN", "RANGE"]


@dataclass
class MarketRegime:
    band: RegimeBand               # CALM/NORMAL/ELEVATED/CRISIS
    trend: TrendState              # UP/DOWN/RANGE
    realized_vol_pct: float        # annualised, %
    adx_14: float                  # trend strength
    hurst: float                   # <0.5 mean-reverting, >0.5 trending
    range_pct: float               # 30-day range / mean close
    is_stationary: bool            # ADF-style proxy
    leverage_haircut: float        # 1.0 = full, 0.5 = halved per R-4
    favored_style: Literal["MEAN_REVERSION", "MOMENTUM", "BALANCED", "REDUCE"]
    notes: list[str]


def _adx(df: pd.DataFrame, period: int = 14) -> float:
    h, l, c = df["high"], df["low"], df["close"]
    up = h.diff(); dn = -l.diff()
    plus_dm  = ((up > dn) & (up > 0)).astype(float) * up
    minus_dm = ((dn > up) & (dn > 0)).astype(float) * dn
    tr = pd.concat([(h - l), (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1).max(axis=1)
    atr = tr.rolling(period).mean()
    plus_di  = 100 * (plus_dm.rolling(period).mean()  / atr.replace(0, np.nan))
    minus_di = 100 * (minus_dm.rolling(period).mean() / atr.replace(0, np.nan))
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    val = dx.rolling(period).mean().iloc[-1]
    return float(val) if pd.notna(val) else 0.0


def _hurst(series: pd.Series, max_lag: int = 20) -> float:
    """Classic R/S Hurst exponent on the last 100 bars of log-returns."""
    s = np.log(series.replace(0, np.nan)).dropna().tail(100).values
    if len(s) < 30:
        return 0.5
    lags = range(2, min(max_lag, len(s) // 2))
    try:
        tau = [np.sqrt(np.std(np.subtract(s[lag:], s[:-lag]))) for lag in lags]
        # Filter zeros that would NaN the log.
        valid = [(l, t) for l, t in zip(lags, tau) if t > 0]
        if len(valid) < 3:
            return 0.5
        ls = np.log([l for l, _ in valid])
        ts = np.log([t for _, t in valid])
        # 2× slope per standard R/S Hurst.
        return float(np.polyfit(ls, ts, 1)[0] * 2)
    except Exception:
        return 0.5


def _trend(close: pd.Series) -> TrendState:
    """200-day SMA slope; falls back to 50-day if data is short."""
    period = 200 if len(close) >= 220 else 50 if len(close) >= 60 else 20
    sma = close.rolling(period).mean().dropna()
    if len(sma) < 10:
        return "RANGE"
    slope = (sma.iloc[-1] - sma.iloc[-10]) / max(abs(sma.iloc[-10]), 1e-9)
    if slope > 0.005:  return "UP"
    if slope < -0.005: return "DOWN"
    return "RANGE"


def _stationarity_proxy(close: pd.Series) -> bool:
    """Cheap proxy for the ADF test (R/S Hurst < 0.5 → mean-reverting)."""
    return _hurst(close) < 0.5


def detect_regime(df: pd.DataFrame, vix: Optional[float] = None) -> MarketRegime:
    """Build a MarketRegime from a daily OHLCV DataFrame.

    If a real VIX value is supplied we use it; otherwise we use realized
    volatility on the symbol as a stand-in (works fine for single-name
    decisions; for portfolio sizing pull the actual VIX upstream).
    """
    if df is None or len(df) < 30:
        return MarketRegime(
            band="NORMAL", trend="RANGE",
            realized_vol_pct=0, adx_14=0, hurst=0.5, range_pct=0,
            is_stationary=False, leverage_haircut=1.0,
            favored_style="BALANCED",
            notes=["insufficient_data"],
        )

    close = df["close"]
    rets = close.pct_change().dropna().tail(60)
    realized_vol_pct = float(rets.std() * np.sqrt(252) * 100) if len(rets) > 5 else 0.0
    vol_signal = float(vix) if vix is not None else realized_vol_pct

    if   vol_signal < 15: band = "CALM"
    elif vol_signal < 25: band = "NORMAL"
    elif vol_signal < 30: band = "ELEVATED"
    else:                  band = "CRISIS"

    adx = _adx(df)
    hurst = _hurst(close)
    trend = _trend(close)
    win = df.tail(30)
    range_pct = (win["high"].max() - win["low"].min()) / max(close.iloc[-30:].mean(), 1e-9) * 100
    is_stationary = hurst < 0.5

    # R-4 leverage haircut.
    haircut = {"CALM": 1.0, "NORMAL": 1.0, "ELEVATED": 0.7, "CRISIS": 0.4}[band]

    # HYB-2 style selection.
    if band == "CRISIS":
        style = "REDUCE"
    elif band == "ELEVATED" or (trend != "RANGE" and adx > 25):
        style = "MOMENTUM"
    elif band == "CALM" and is_stationary:
        style = "MEAN_REVERSION"
    else:
        style = "BALANCED"

    notes = []
    if not is_stationary and style == "MEAN_REVERSION":
        notes.append("symbol_not_stationary_avoid_pure_MR")
    if adx > 30: notes.append("strong_trend_present")
    if range_pct < 5: notes.append("range_compressed_breakout_setup")

    return MarketRegime(
        band=band, trend=trend, realized_vol_pct=round(realized_vol_pct, 2),
        adx_14=round(adx, 2), hurst=round(hurst, 3), range_pct=round(range_pct, 2),
        is_stationary=is_stationary, leverage_haircut=haircut,
        favored_style=style, notes=notes,
    )
