"""Feature extractors for the three auxiliary Gainz Alpha models.

Each model gets a different "view" of the same OHLCV bar:

  • Model 1 — classical technical indicators (RSI / MACD / ADX / BB / ATR).
  • Model 2 — volume anomaly + a price-momentum-as-sentiment proxy
              (real news scoring would replace the proxy when wired).
  • Model 3 — pure price-action momentum (multi-horizon returns, range
              compression, gap behaviour).

All three predict the SAME target so they can be ensembled coherently:
  was the close 5 bars later higher than the close at "now"?
"""

from __future__ import annotations

from typing import List

import numpy as np
import pandas as pd


# Forward horizon for the binary up/down label.
LABEL_HORIZON_BARS = 5


# ───────────────────────────────────────────────────────────────────────
# Indicator primitives (pandas-native, vectorised)
# ───────────────────────────────────────────────────────────────────────

def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _macd(close: pd.Series, fast=12, slow=26, signal=9) -> pd.DataFrame:
    ema_f = close.ewm(span=fast, adjust=False).mean()
    ema_s = close.ewm(span=slow, adjust=False).mean()
    line = ema_f - ema_s
    sig = line.ewm(span=signal, adjust=False).mean()
    hist = line - sig
    return pd.DataFrame({"macd": line, "macd_signal": sig, "macd_hist": hist})


def _atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    h, l, c = df["high"], df["low"], df["close"]
    prev_c = c.shift(1)
    tr = pd.concat([(h - l), (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def _adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    h, l, c = df["high"], df["low"], df["close"]
    up = h.diff()
    dn = -l.diff()
    plus_dm  = ((up > dn) & (up > 0)).astype(float) * up
    minus_dm = ((dn > up) & (dn > 0)).astype(float) * dn
    tr = pd.concat(
        [(h - l), (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1
    ).max(axis=1)
    atr = tr.rolling(period).mean()
    plus_di  = 100 * (plus_dm.rolling(period).mean()  / atr.replace(0, np.nan))
    minus_di = 100 * (minus_dm.rolling(period).mean() / atr.replace(0, np.nan))
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.rolling(period).mean()


def _bollinger_width(close: pd.Series, period: int = 20, mult: float = 2.0) -> pd.Series:
    sma = close.rolling(period).mean()
    std = close.rolling(period).std()
    upper = sma + mult * std
    lower = sma - mult * std
    return (upper - lower) / sma.replace(0, np.nan)


# ───────────────────────────────────────────────────────────────────────
# Per-model feature sets
# ───────────────────────────────────────────────────────────────────────

MODEL_1_FEATURES: List[str] = [
    "rsi_14",
    "macd_hist",
    "macd_signal_cross",   # 1 if MACD crossed above signal, -1 below, 0 same
    "ema_20_vs_50",        # (ema20 - ema50) / ema50
    "ema_50_vs_200",
    "adx_14",
    "atr_pct",             # ATR as % of close
    "bollinger_width",
    "price_vs_bb_mid",
]

MODEL_2_FEATURES: List[str] = [
    "volume_zscore_20",      # (vol - mean) / std over 20 bars
    "volume_change_5d",
    "volume_change_20d",
    "price_volume_corr_20",  # rolling corr(close, vol) over 20 bars
    "sentiment_proxy_5d",    # smoothed 5-bar return — stands in for news
    "sentiment_proxy_20d",
    "obv_slope_10",          # slope of On-Balance Volume over last 10 bars
]

MODEL_3_FEATURES: List[str] = [
    "ret_1d",
    "ret_5d",
    "ret_10d",
    "ret_20d",
    "true_range_pct",
    "range_compression_5_20",  # mean(range_5) / mean(range_20) — squeeze
    "gap_count_10",            # gaps > 0.5% in last 10 bars
    "body_to_range",           # |close-open| / (high-low)
    "close_position_in_range", # (close-low) / (high-low) — 0..1
]

ALL_AUX_FEATURES = MODEL_1_FEATURES + MODEL_2_FEATURES + MODEL_3_FEATURES


def build_feature_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Compute every aux feature for an OHLCV DataFrame.

    Returns a DataFrame with the same index plus all feature columns and
    the target column ``target`` (1 if close[t+HORIZON] > close[t]).
    """
    out = df.copy()
    c, h, l, v = out["close"], out["high"], out["low"], out["volume"]

    # ── Model 1: classical TA ─────────────────────────────────────────
    out["rsi_14"] = _rsi(c)
    macd_df = _macd(c)
    out["macd"] = macd_df["macd"]
    out["macd_signal"] = macd_df["macd_signal"]
    out["macd_hist"] = macd_df["macd_hist"]
    out["macd_signal_cross"] = np.sign(macd_df["macd"] - macd_df["macd_signal"]).diff().fillna(0)
    ema_20  = c.ewm(span=20,  adjust=False).mean()
    ema_50  = c.ewm(span=50,  adjust=False).mean()
    ema_200 = c.ewm(span=200, adjust=False).mean()
    out["ema_20_vs_50"]  = (ema_20  - ema_50)  / ema_50.replace(0, np.nan)
    out["ema_50_vs_200"] = (ema_50  - ema_200) / ema_200.replace(0, np.nan)
    out["adx_14"] = _adx(out)
    out["atr_pct"] = _atr(out) / c.replace(0, np.nan) * 100
    out["bollinger_width"] = _bollinger_width(c)
    bb_mid = c.rolling(20).mean()
    out["price_vs_bb_mid"] = (c - bb_mid) / bb_mid.replace(0, np.nan)

    # ── Model 2: volume + sentiment proxy ─────────────────────────────
    vol_mean = v.rolling(20).mean()
    vol_std  = v.rolling(20).std()
    out["volume_zscore_20"]    = (v - vol_mean) / vol_std.replace(0, np.nan)
    out["volume_change_5d"]    = v.pct_change(5)
    out["volume_change_20d"]   = v.pct_change(20)
    out["price_volume_corr_20"] = c.rolling(20).corr(v)
    ret_smooth = c.pct_change()
    out["sentiment_proxy_5d"]  = ret_smooth.rolling(5).mean()
    out["sentiment_proxy_20d"] = ret_smooth.rolling(20).mean()
    obv = (np.sign(c.diff()) * v).fillna(0).cumsum()
    out["obv_slope_10"] = (obv - obv.shift(10)) / 10.0

    # ── Model 3: price-action momentum ────────────────────────────────
    out["ret_1d"]  = c.pct_change(1)
    out["ret_5d"]  = c.pct_change(5)
    out["ret_10d"] = c.pct_change(10)
    out["ret_20d"] = c.pct_change(20)
    rng = (h - l)
    out["true_range_pct"] = rng / c.replace(0, np.nan) * 100
    range_5  = rng.rolling(5).mean()
    range_20 = rng.rolling(20).mean()
    out["range_compression_5_20"] = range_5 / range_20.replace(0, np.nan)
    gap_pct = ((out["open"] - c.shift(1)) / c.shift(1)).abs()
    out["gap_count_10"] = (gap_pct > 0.005).astype(int).rolling(10).sum()
    body = (c - out["open"]).abs()
    out["body_to_range"] = body / rng.replace(0, np.nan)
    out["close_position_in_range"] = (c - l) / rng.replace(0, np.nan)

    # ── Label: did close rise over the next HORIZON bars? ─────────────
    out["fwd_return"] = c.shift(-LABEL_HORIZON_BARS) / c - 1
    out["target"] = (out["fwd_return"] > 0).astype(int)

    return out


def extract_for_inference(df: pd.DataFrame) -> dict:
    """Compute features on the latest bar — used at /gainz-alpha/score time.

    Returns three sub-dicts keyed by feature-set name, suitable for
    ``GainzAlphaEngine.compute_alpha_score(indicator_features=...)``.
    """
    feats = build_feature_frame(df).iloc[-1]
    def grab(cols: List[str]) -> dict:
        return {k: float(feats[k]) if pd.notna(feats[k]) else 0.0 for k in cols}
    return {
        "model_1_features": grab(MODEL_1_FEATURES),
        "model_2_features": grab(MODEL_2_FEATURES),
        "model_3_features": grab(MODEL_3_FEATURES),
    }
