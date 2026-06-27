"""Composite strategy layers — five professional strategies + weighted composer.

Each strategy returns a StrategySignal {signal ∈ {-1,0,1}, confidence ∈ [0,1],
reason, metadata}. StrategyComposer aggregates them to a 0..100 composite score
and a recommendation (STRONG BUY / BUY / NEUTRAL / SELL / STRONG SELL).

All calcs are pandas+numpy. Candles arrive as list[dict] from the Node side
and are converted to an OHLCV DataFrame via `candles_to_df`.

Pairs trading needs a peer (sector/market) index DataFrame; the Node backend
builds one from the rest of the watch universe and injects it. Sentiment needs
macro inputs (FII/DII, India VIX, A/D ratio, PCR) — pass them on the API call;
unset values are skipped, never faked.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


# ============================================================================
# DataFrame helpers
# ============================================================================

def candles_to_df(candles: List[dict]) -> pd.DataFrame:
    """Convert [{t,o,h,l,c,v}, ...] to an OHLCV DataFrame indexed by time."""
    if not candles:
        return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])
    df = pd.DataFrame(candles)
    df["t"] = pd.to_datetime(df["t"], unit="ms", utc=True)
    df = df.set_index("t").rename(
        columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume"}
    )
    return df[["Open", "High", "Low", "Close", "Volume"]].astype(float).sort_index()


# ============================================================================
# Indicators (pandas)
# ============================================================================

def ema(s: pd.Series, period: int) -> pd.Series:
    return s.ewm(span=period, adjust=False).mean()


def rsi(s: pd.Series, period: int = 14) -> pd.Series:
    delta = s.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50.0)


def vwap_series(df: pd.DataFrame) -> pd.Series:
    tp = (df["High"] + df["Low"] + df["Close"]) / 3.0
    pv = (tp * df["Volume"]).cumsum()
    vv = df["Volume"].cumsum().replace(0, np.nan)
    return (pv / vv).bfill()


def atr_series(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = df["High"], df["Low"], df["Close"]
    tr = pd.concat(
        [(high - low), (high - close.shift()).abs(), (low - close.shift()).abs()],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def adx_series(df: pd.DataFrame, period: int = 14):
    high, low, close = df["High"], df["Low"], df["Close"]
    up = high.diff()
    down = -low.diff()
    plus_dm = up.where((up > down) & (up > 0), 0.0)
    minus_dm = down.where((down > up) & (down > 0), 0.0)
    tr = pd.concat(
        [(high - low), (high - close.shift()).abs(), (low - close.shift()).abs()],
        axis=1,
    ).max(axis=1)
    a = tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / a
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / a
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean(), plus_di, minus_di


def supertrend_series(df: pd.DataFrame, period: int = 10, mult: float = 3.0):
    a = atr_series(df, period)
    hl2 = (df["High"] + df["Low"]) / 2.0
    upper_basic = (hl2 + mult * a).to_numpy()
    lower_basic = (hl2 - mult * a).to_numpy()
    close = df["Close"].to_numpy()
    n = len(df)
    final_upper = np.full(n, np.nan)
    final_lower = np.full(n, np.nan)
    direction = np.zeros(n, dtype=int)
    line = np.full(n, np.nan)
    for i in range(n):
        if np.isnan(upper_basic[i]) or np.isnan(lower_basic[i]):
            continue
        if i == 0 or np.isnan(final_upper[i - 1]):
            final_upper[i] = upper_basic[i]
            final_lower[i] = lower_basic[i]
            direction[i] = 1 if close[i] >= upper_basic[i] else -1
        else:
            final_upper[i] = (
                upper_basic[i]
                if (upper_basic[i] < final_upper[i - 1] or close[i - 1] > final_upper[i - 1])
                else final_upper[i - 1]
            )
            final_lower[i] = (
                lower_basic[i]
                if (lower_basic[i] > final_lower[i - 1] or close[i - 1] < final_lower[i - 1])
                else final_lower[i - 1]
            )
            if direction[i - 1] == 1:
                direction[i] = -1 if close[i] < final_lower[i] else 1
            else:
                direction[i] = 1 if close[i] > final_upper[i] else -1
        line[i] = final_lower[i] if direction[i] == 1 else final_upper[i]
    return pd.Series(line, index=df.index), pd.Series(direction, index=df.index)


# ============================================================================
# Signal model + base
# ============================================================================

@dataclass
class StrategySignal:
    name: str
    signal: int            # -1, 0, 1
    confidence: float      # 0..1
    reason: str
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "signal": int(self.signal),
            "confidence": round(float(self.confidence), 4),
            "reason": self.reason,
            "metadata": self.metadata,
        }


class BaseStrategy(ABC):
    name: str = "base"

    @abstractmethod
    def compute(self, df: pd.DataFrame, context: Optional[dict] = None) -> StrategySignal:
        ...

    @staticmethod
    def _empty(name: str, reason: str = "insufficient data") -> StrategySignal:
        return StrategySignal(name=name, signal=0, confidence=0.0, reason=reason)


# ============================================================================
# 1. Trend Following — EMA cross + ADX + Supertrend
# ============================================================================

class TrendFollowingStrategy(BaseStrategy):
    name = "trend"

    def __init__(
        self,
        fast_ema: int = 9,
        slow_ema: int = 21,
        adx_period: int = 14,
        adx_threshold: float = 25.0,
        st_period: int = 10,
        st_mult: float = 3.0,
        cross_lookback: int = 3,
    ):
        self.fast = fast_ema
        self.slow = slow_ema
        self.adx_period = adx_period
        self.adx_threshold = adx_threshold
        self.st_period = st_period
        self.st_mult = st_mult
        self.cross_lookback = cross_lookback

    def compute(self, df: pd.DataFrame, context: Optional[dict] = None) -> StrategySignal:
        if len(df) < max(self.slow, self.adx_period * 2, self.st_period * 2):
            return self._empty(self.name)

        close = df["Close"]
        ema_fast = ema(close, self.fast)
        ema_slow = ema(close, self.slow)
        adx_s, plus_di, minus_di = adx_series(df, self.adx_period)
        _, st_dir = supertrend_series(df, self.st_period, self.st_mult)

        adx_now = float(adx_s.iloc[-1]) if not np.isnan(adx_s.iloc[-1]) else 0.0
        st_now = int(st_dir.iloc[-1])
        diff = ema_fast - ema_slow
        spread_pct = float(diff.iloc[-1]) / float(close.iloc[-1])
        direction = 1 if spread_pct > 0 else -1 if spread_pct < 0 else 0

        fresh_bull = fresh_bear = False
        for k in range(1, self.cross_lookback + 1):
            if k + 1 > len(diff):
                break
            if diff.iloc[-k - 1] <= 0 < diff.iloc[-k]:
                fresh_bull = True
                break
            if diff.iloc[-k - 1] >= 0 > diff.iloc[-k]:
                fresh_bear = True
                break

        trend_aligned = direction == st_now
        adx_pass = adx_now >= self.adx_threshold
        signal = direction if (direction != 0 and trend_aligned and adx_pass) else 0

        c_adx = max(0.0, min(1.0, (adx_now - 15) / 35.0))
        c_spread = max(0.0, min(1.0, abs(spread_pct) * 50))
        c_st = 1.0 if trend_aligned else 0.0
        c_fresh = 1.0 if (fresh_bull or fresh_bear) else 0.6
        confidence = 0.35 * c_adx + 0.25 * c_spread + 0.25 * c_st + 0.15 * c_fresh
        if signal == 0:
            confidence = min(confidence, 0.45)

        reason = (
            f"EMA{self.fast}/{self.slow} "
            + ("bull" if direction > 0 else "bear" if direction < 0 else "flat")
            + (" (fresh cross)" if (fresh_bull or fresh_bear) else "")
            + f"; ADX {adx_now:.1f}"
            + (" ≥" if adx_pass else " <")
            + f" {self.adx_threshold}; Supertrend "
            + ("+1" if st_now > 0 else "-1" if st_now < 0 else "0")
        )

        return StrategySignal(
            name=self.name,
            signal=signal,
            confidence=round(confidence, 4),
            reason=reason,
            metadata={
                "adx": round(adx_now, 2),
                "plus_di": round(float(plus_di.iloc[-1]), 2) if not np.isnan(plus_di.iloc[-1]) else None,
                "minus_di": round(float(minus_di.iloc[-1]), 2) if not np.isnan(minus_di.iloc[-1]) else None,
                "ema_spread_pct": round(spread_pct * 100, 3),
                "supertrend_dir": st_now,
                "fresh_bull": fresh_bull,
                "fresh_bear": fresh_bear,
            },
        )


# ============================================================================
# 2. Mean Reversion — BB z-score + RSI extremes + VWAP deviation
# ============================================================================

class MeanReversionStrategy(BaseStrategy):
    name = "reversion"

    def __init__(
        self,
        bb_period: int = 20,
        bb_mult: float = 2.0,
        rsi_period: int = 14,
        rsi_low: float = 30.0,
        rsi_high: float = 70.0,
        z_trigger: float = 2.0,
        vwap_atr_trigger: float = 1.5,
    ):
        self.bb_period = bb_period
        self.bb_mult = bb_mult
        self.rsi_period = rsi_period
        self.rsi_low = rsi_low
        self.rsi_high = rsi_high
        self.z_trigger = z_trigger
        self.vwap_atr_trigger = vwap_atr_trigger

    def compute(self, df: pd.DataFrame, context: Optional[dict] = None) -> StrategySignal:
        if len(df) < max(self.bb_period, self.rsi_period * 2, 20):
            return self._empty(self.name)

        close = df["Close"]
        mid = close.rolling(self.bb_period).mean()
        sd = close.rolling(self.bb_period).std(ddof=0)
        z = float((close.iloc[-1] - mid.iloc[-1]) / sd.iloc[-1]) if sd.iloc[-1] > 0 else 0.0
        r = float(rsi(close, self.rsi_period).iloc[-1])
        v = vwap_series(df)
        a = atr_series(df, 14)
        vwap_dev_atr = float((close.iloc[-1] - v.iloc[-1]) / max(a.iloc[-1], 1e-9)) if not np.isnan(a.iloc[-1]) else 0.0

        bull = bear = 0
        if z <= -self.z_trigger:
            bull += 1
        if z >= self.z_trigger:
            bear += 1
        if r <= self.rsi_low:
            bull += 1
        if r >= self.rsi_high:
            bear += 1
        if vwap_dev_atr <= -self.vwap_atr_trigger:
            bull += 1
        if vwap_dev_atr >= self.vwap_atr_trigger:
            bear += 1

        signal = 1 if (bull >= 2 and bull > bear) else -1 if (bear >= 2 and bear > bull) else 0

        mag = max(
            abs(z) / max(self.z_trigger, 1.0),
            ((self.rsi_low - r) / self.rsi_low) if r < self.rsi_low else 0.0,
            ((r - self.rsi_high) / (100 - self.rsi_high)) if r > self.rsi_high else 0.0,
            abs(vwap_dev_atr) / max(self.vwap_atr_trigger, 1.0),
        )
        confidence = (
            min(0.95, max(0.0, mag * 0.55 + (max(bull, bear) - 1) * 0.15))
            if signal != 0
            else min(0.4, mag * 0.3)
        )

        reason = (
            f"BB z={z:+.2f}, RSI={r:.1f}, VWAP dev (ATR)={vwap_dev_atr:+.2f} → "
            + ("BULL revert" if signal > 0 else "BEAR revert" if signal < 0 else "no reversion")
        )

        return StrategySignal(
            name=self.name,
            signal=signal,
            confidence=round(confidence, 4),
            reason=reason,
            metadata={
                "bb_z": round(z, 3),
                "rsi": round(r, 2),
                "vwap_dev_atr": round(vwap_dev_atr, 3),
                "vwap": round(float(v.iloc[-1]), 2),
                "bb_mid": round(float(mid.iloc[-1]), 2),
                "bb_upper": round(float(mid.iloc[-1] + self.bb_mult * sd.iloc[-1]), 2),
                "bb_lower": round(float(mid.iloc[-1] - self.bb_mult * sd.iloc[-1]), 2),
            },
        )


# ============================================================================
# 3. Breakout — Donchian + volume spike + squeeze
# ============================================================================

class BreakoutStrategy(BaseStrategy):
    name = "breakout"

    def __init__(
        self,
        donchian_period: int = 20,
        volume_lookback: int = 20,
        volume_mult: float = 2.0,
        squeeze_period: int = 20,
        squeeze_pct: float = 0.04,
    ):
        self.donchian_period = donchian_period
        self.volume_lookback = volume_lookback
        self.volume_mult = volume_mult
        self.squeeze_period = squeeze_period
        self.squeeze_pct = squeeze_pct

    def compute(self, df: pd.DataFrame, context: Optional[dict] = None) -> StrategySignal:
        if len(df) < max(self.donchian_period, self.volume_lookback, self.squeeze_period) + 2:
            return self._empty(self.name)

        last_close = float(df["Close"].iloc[-1])
        prior = df.iloc[:-1]
        d_hi = float(prior["High"].tail(self.donchian_period).max())
        d_lo = float(prior["Low"].tail(self.donchian_period).min())
        broke_high = last_close > d_hi
        broke_low = last_close < d_lo

        avg_vol = float(df["Volume"].tail(self.volume_lookback).mean())
        cur_vol = float(df["Volume"].iloc[-1])
        vol_ratio = cur_vol / avg_vol if avg_vol > 0 else 0.0
        vol_confirm = vol_ratio >= self.volume_mult

        prior_close = prior["Close"]
        if len(prior_close) >= self.squeeze_period:
            mid = prior_close.rolling(self.squeeze_period).mean().iloc[-1]
            sd = prior_close.rolling(self.squeeze_period).std(ddof=0).iloc[-1]
            bb_width_pct = (4 * sd) / mid if mid > 0 else np.nan
        else:
            bb_width_pct = np.nan
        squeeze = (not np.isnan(bb_width_pct)) and bb_width_pct <= self.squeeze_pct

        signal = 1 if (broke_high and vol_confirm) else -1 if (broke_low and vol_confirm) else 0

        if broke_high:
            stretch = (last_close - d_hi) / max(d_hi, 1e-9)
        elif broke_low:
            stretch = (d_lo - last_close) / max(d_lo, 1e-9)
        else:
            stretch = 0.0
        c_stretch = min(1.0, stretch * 30)
        c_vol = min(1.0, max(0.0, (vol_ratio - 1.0) / 3.0))
        c_squeeze = 0.2 if squeeze else 0.0
        confidence = (
            min(0.95, 0.4 * c_stretch + 0.4 * c_vol + c_squeeze)
            if signal != 0
            else min(0.4, c_vol * 0.25)
        )

        reason = (
            ("UP" if broke_high else "DOWN" if broke_low else "inside")
            + f" {self.donchian_period}-bar range; vol {vol_ratio:.1f}× avg"
            + (", squeeze prior" if squeeze else "")
        )

        return StrategySignal(
            name=self.name,
            signal=signal,
            confidence=round(confidence, 4),
            reason=reason,
            metadata={
                "donchian_high": round(d_hi, 2),
                "donchian_low": round(d_lo, 2),
                "broke_high": bool(broke_high),
                "broke_low": bool(broke_low),
                "volume_ratio": round(vol_ratio, 2),
                "squeeze": bool(squeeze),
                "bb_width_pct": round(float(bb_width_pct), 4) if not np.isnan(bb_width_pct) else None,
            },
        )


# ============================================================================
# 4. Pairs Trading — spread z-score vs peer/sector index
# ============================================================================

class PairsTradingStrategy(BaseStrategy):
    name = "pairs"

    def __init__(self, lookback: int = 60, z_threshold: float = 2.0, min_corr: float = 0.3):
        self.lookback = lookback
        self.z_threshold = z_threshold
        self.min_corr = min_corr

    def compute(self, df: pd.DataFrame, context: Optional[dict] = None) -> StrategySignal:
        if len(df) < self.lookback + 5:
            return self._empty(self.name)
        peer_df: Optional[pd.DataFrame] = (context or {}).get("peer_df")
        if peer_df is None or peer_df.empty:
            return self._empty(self.name, "peer index unavailable")

        peer_aligned = peer_df.reindex(df.index).ffill()
        if peer_aligned["Close"].isna().tail(self.lookback).all():
            return self._empty(self.name, "peer index has no data over lookback")

        stock_lr = np.log(df["Close"]).diff()
        peer_lr = np.log(peer_aligned["Close"]).diff()
        spread = (stock_lr - peer_lr).rolling(self.lookback).sum()
        mu = spread.rolling(self.lookback).mean()
        sigma = spread.rolling(self.lookback).std(ddof=0)
        z = (spread - mu) / sigma.replace(0, np.nan)
        z_now = float(z.iloc[-1]) if not np.isnan(z.iloc[-1]) else 0.0

        signal = 1 if z_now <= -self.z_threshold else -1 if z_now >= self.z_threshold else 0

        joined = pd.concat([stock_lr, peer_lr], axis=1).dropna().tail(self.lookback)
        corr = float(joined.iloc[:, 0].corr(joined.iloc[:, 1])) if len(joined) > 5 else 0.0
        if signal != 0 and corr < self.min_corr:
            signal = 0
            note = " (filtered: low corr)"
        else:
            note = ""

        confidence = (
            min(0.95, abs(z_now) / 4.0 * (0.5 + 0.5 * max(corr, 0)))
            if signal != 0
            else min(0.4, abs(z_now) / 10.0)
        )

        reason = (
            f"spread z={z_now:+.2f}, peer corr={corr:.2f} → "
            + (
                "revert LONG (stock cheap vs peer)"
                if signal > 0
                else "fade SHORT (stock rich vs peer)"
                if signal < 0
                else "inside band"
            )
            + note
        )

        return StrategySignal(
            name=self.name,
            signal=signal,
            confidence=round(confidence, 4),
            reason=reason,
            metadata={
                "spread_z": round(z_now, 3),
                "correlation": round(corr, 3),
                "lookback": self.lookback,
            },
        )


# ============================================================================
# 5. Macro Sentiment — FII/DII + India VIX + A/D ratio + PCR
# ============================================================================

@dataclass
class SentimentInputs:
    fii_dii_net_cr: Optional[float] = None
    india_vix: Optional[float] = None
    ad_ratio: Optional[float] = None
    pcr: Optional[float] = None
    news_sentiment: Optional[float] = None  # extra: average news score [-1, +1]


class MacroSentimentStrategy(BaseStrategy):
    name = "sentiment"

    def __init__(
        self,
        vix_calm: float = 13.0,
        vix_stressed: float = 22.0,
        pcr_bull: float = 0.85,
        pcr_bear: float = 1.30,
        ad_bull: float = 1.50,
        ad_bear: float = 0.65,
        fii_dii_scale_cr: float = 2000.0,
    ):
        self.vix_calm = vix_calm
        self.vix_stressed = vix_stressed
        self.pcr_bull = pcr_bull
        self.pcr_bear = pcr_bear
        self.ad_bull = ad_bull
        self.ad_bear = ad_bear
        self.fii_dii_scale_cr = fii_dii_scale_cr

    def compute(self, df: pd.DataFrame, context: Optional[dict] = None) -> StrategySignal:
        inputs: Optional[SentimentInputs] = (context or {}).get("sentiment_inputs")
        if inputs is None:
            return self._empty(self.name, "no sentiment inputs available")

        votes: List[float] = []
        components: Dict[str, Optional[float]] = {}

        if inputs.fii_dii_net_cr is not None:
            v = max(-1.0, min(1.0, inputs.fii_dii_net_cr / self.fii_dii_scale_cr))
            votes.append(v)
            components["fii_dii"] = round(v, 3)

        if inputs.india_vix is not None:
            x = inputs.india_vix
            if x <= self.vix_calm:
                v = 0.5
            elif x >= self.vix_stressed:
                v = -1.0
            else:
                v = 0.5 - (x - self.vix_calm) / (self.vix_stressed - self.vix_calm) * 1.5
            votes.append(v)
            components["india_vix"] = round(v, 3)

        if inputs.ad_ratio is not None:
            if inputs.ad_ratio >= self.ad_bull:
                v = min(1.0, inputs.ad_ratio - 1.0)
            elif inputs.ad_ratio <= self.ad_bear:
                v = max(-1.0, -(1.0 - inputs.ad_ratio))
            else:
                v = inputs.ad_ratio - 1.0
            votes.append(v)
            components["ad_ratio"] = round(v, 3)

        if inputs.pcr is not None:
            if inputs.pcr <= self.pcr_bull:
                v = 0.7
            elif inputs.pcr >= self.pcr_bear:
                v = -0.7
            else:
                v = 0.7 - (inputs.pcr - self.pcr_bull) / (self.pcr_bear - self.pcr_bull) * 1.4
            votes.append(v)
            components["pcr"] = round(v, 3)

        if inputs.news_sentiment is not None:
            v = max(-1.0, min(1.0, inputs.news_sentiment))
            votes.append(v)
            components["news"] = round(v, 3)

        if not votes:
            return self._empty(self.name, "no sentiment components")

        avg = sum(votes) / len(votes)
        signal = 1 if avg >= 0.35 else -1 if avg <= -0.35 else 0
        confidence = min(0.9, abs(avg) * (0.5 + 0.1 * len(votes)))

        reason = (
            "Macro sentiment "
            + ("bullish" if signal > 0 else "bearish" if signal < 0 else "neutral")
            + f" (avg {avg:+.2f}, {len(votes)} input(s))"
        )

        return StrategySignal(
            name=self.name,
            signal=signal,
            confidence=round(confidence, 4),
            reason=reason,
            metadata={
                "avg_score": round(avg, 3),
                "components": components,
                "raw": {
                    "fii_dii_net_cr": inputs.fii_dii_net_cr,
                    "india_vix": inputs.india_vix,
                    "ad_ratio": inputs.ad_ratio,
                    "pcr": inputs.pcr,
                    "news_sentiment": inputs.news_sentiment,
                },
            },
        )


# ============================================================================
# Composer + Recommendation + Backtest
# ============================================================================

DEFAULT_WEIGHTS: Dict[str, float] = {
    "trend": 0.25,
    "reversion": 0.15,
    "breakout": 0.25,
    "pairs": 0.10,
    "sentiment": 0.25,
}

RECOMMENDATION_BANDS = [
    (75.0, "STRONG BUY"),
    (60.0, "BUY"),
    (40.0, "NEUTRAL"),
    (25.0, "SELL"),
    (0.0, "STRONG SELL"),
]


def classify(score_0_100: float) -> str:
    for thr, label in RECOMMENDATION_BANDS:
        if score_0_100 >= thr:
            return label
    return "STRONG SELL"


@dataclass
class CompositeResult:
    symbol: str
    asof: str
    signals: Dict[str, dict]
    weighted_score: float
    composite_score: float
    recommendation: str
    confidence: float
    weights: Dict[str, float]
    bars: int

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "asof": self.asof,
            "bars": self.bars,
            "signals": self.signals,
            "weighted_score": round(self.weighted_score, 4),
            "composite_score": round(self.composite_score, 2),
            "recommendation": self.recommendation,
            "confidence": round(self.confidence, 4),
            "weights": self.weights,
        }


class StrategyComposer:
    """Aggregates strategy signals into a 0..100 composite score + recommendation."""

    def __init__(
        self,
        strategies: Optional[Iterable[BaseStrategy]] = None,
        weights: Optional[Dict[str, float]] = None,
    ):
        self.strategies: List[BaseStrategy] = (
            list(strategies)
            if strategies is not None
            else [
                TrendFollowingStrategy(),
                MeanReversionStrategy(),
                BreakoutStrategy(),
                PairsTradingStrategy(),
                MacroSentimentStrategy(),
            ]
        )
        self.weights = {**DEFAULT_WEIGHTS, **(weights or {})}

    def evaluate(
        self,
        df: pd.DataFrame,
        symbol: str = "?",
        peer_df: Optional[pd.DataFrame] = None,
        sentiment_inputs: Optional[SentimentInputs] = None,
    ) -> CompositeResult:
        if df is None or df.empty:
            raise ValueError("df is empty")
        ctx = {"symbol": symbol, "peer_df": peer_df, "sentiment_inputs": sentiment_inputs}

        signal_dict: Dict[str, dict] = {}
        weighted_sum = 0.0
        weight_total = 0.0
        confidence_sum = 0.0
        confidence_weight = 0.0

        for strat in self.strategies:
            w = self.weights.get(strat.name, 0.0)
            try:
                sig = strat.compute(df, ctx)
            except Exception as e:  # noqa: BLE001
                logger.exception("Strategy %s failed", strat.name)
                sig = StrategySignal(name=strat.name, signal=0, confidence=0.0, reason=f"error: {e}")
            signal_dict[strat.name] = sig.to_dict()
            if w > 0:
                weighted_sum += w * sig.signal * sig.confidence
                weight_total += w
                confidence_sum += w * sig.confidence
                confidence_weight += w

        weighted_score = weighted_sum / weight_total if weight_total > 0 else 0.0
        agg_confidence = confidence_sum / max(confidence_weight, 1e-9)
        composite_score = (weighted_score + 1.0) / 2.0 * 100.0

        return CompositeResult(
            symbol=symbol,
            asof=df.index[-1].isoformat(),
            signals=signal_dict,
            weighted_score=float(weighted_score),
            composite_score=float(round(composite_score, 2)),
            recommendation=classify(composite_score),
            confidence=float(agg_confidence),
            weights=self.weights,
            bars=len(df),
        )

    # ------------------------------------------------------------- backtest

    def backtest(
        self,
        df: pd.DataFrame,
        symbol: str = "?",
        peer_df: Optional[pd.DataFrame] = None,
        sentiment_inputs: Optional[SentimentInputs] = None,
        warmup: int = 60,
        entry_score: float = 65.0,
        exit_score: float = 50.0,
        sl_pct: float = 0.02,
        tp_pct: Optional[float] = 0.05,
        allow_short: bool = True,
        periods_per_year: int = 94500,  # 1m bars in NSE (252 days × 6.25h × 60)
    ) -> dict:
        if len(df) < warmup + 10:
            return {"error": f"Need at least {warmup + 10} bars, got {len(df)}"}

        position = 0
        entry_price = 0.0
        entry_idx: Optional[int] = None
        trades: List[dict] = []
        equity = 1.0
        equity_curve: List[dict] = []
        peak = equity
        max_dd = 0.0
        bar_returns: List[float] = []
        last_eq = equity

        for i in range(warmup, len(df)):
            window = df.iloc[: i + 1]
            peer_window = peer_df.iloc[: i + 1] if peer_df is not None else None
            bar = window.iloc[-1]
            price = float(bar["Close"])

            res = self.evaluate(window, symbol=symbol, peer_df=peer_window, sentiment_inputs=sentiment_inputs)
            score = res.composite_score

            # Manage existing position.
            if position != 0:
                if position > 0:
                    ret = (price - entry_price) / entry_price
                    exit_signal = score < exit_score
                else:
                    ret = (entry_price - price) / entry_price
                    exit_signal = score > (100 - exit_score)
                sl_hit = ret <= -sl_pct
                tp_hit = tp_pct is not None and ret >= tp_pct
                if sl_hit or tp_hit or exit_signal:
                    reason = "SL" if sl_hit else "TP" if tp_hit else "EXIT"
                    equity *= 1 + ret
                    trades.append({
                        "side": "LONG" if position > 0 else "SHORT",
                        "entry_idx": int(entry_idx) if entry_idx is not None else None,
                        "exit_idx": int(i),
                        "entry_price": round(entry_price, 4),
                        "exit_price": round(price, 4),
                        "ret_pct": round(ret * 100, 4),
                        "reason": reason,
                        "exit_score": round(score, 2),
                    })
                    position = 0
                    entry_price = 0.0
                    entry_idx = None

            # Entry.
            if position == 0:
                if score >= entry_score:
                    position = 1
                    entry_price = price
                    entry_idx = i
                elif allow_short and score <= (100 - entry_score):
                    position = -1
                    entry_price = price
                    entry_idx = i

            # Mark-to-market.
            mtm = equity
            if position != 0:
                if position > 0:
                    mtm = equity * (1 + (price - entry_price) / entry_price)
                else:
                    mtm = equity * (1 + (entry_price - price) / entry_price)
            peak = max(peak, mtm)
            dd = (peak - mtm) / peak * 100.0 if peak > 0 else 0.0
            max_dd = max(max_dd, dd)
            equity_curve.append({
                "t": int(bar.name.value // 1_000_000) if hasattr(bar.name, "value") else 0,
                "equity": round(mtm, 6),
                "drawdown_pct": round(dd, 4),
                "score": round(score, 2),
                "position": int(position),
            })
            bar_returns.append((mtm - last_eq) / last_eq if last_eq > 0 else 0.0)
            last_eq = mtm

        # Force-close.
        if position != 0:
            last_price = float(df["Close"].iloc[-1])
            ret = (last_price - entry_price) / entry_price if position > 0 else (entry_price - last_price) / entry_price
            equity *= 1 + ret
            trades.append({
                "side": "LONG" if position > 0 else "SHORT",
                "entry_idx": int(entry_idx) if entry_idx is not None else None,
                "exit_idx": int(len(df) - 1),
                "entry_price": round(entry_price, 4),
                "exit_price": round(last_price, 4),
                "ret_pct": round(ret * 100, 4),
                "reason": "FORCED_CLOSE",
                "exit_score": None,
            })

        wins = [t for t in trades if t["ret_pct"] > 0]
        losses = [t for t in trades if t["ret_pct"] <= 0]
        gross_profit = sum(t["ret_pct"] for t in wins)
        gross_loss = -sum(t["ret_pct"] for t in losses)
        profit_factor = (
            (gross_profit / gross_loss)
            if gross_loss > 0
            else (float("inf") if gross_profit > 0 else 0.0)
        )
        mean_r = float(np.mean(bar_returns)) if bar_returns else 0.0
        std_r = float(np.std(bar_returns, ddof=0)) if bar_returns else 0.0
        sharpe = (mean_r / std_r * np.sqrt(periods_per_year)) if std_r > 0 else 0.0

        return {
            "symbol": symbol,
            "summary": {
                "trades": len(trades),
                "wins": len(wins),
                "losses": len(losses),
                "win_rate": round(len(wins) / len(trades), 4) if trades else 0.0,
                "profit_factor": round(profit_factor, 3) if profit_factor != float("inf") else None,
                "total_return_pct": round((equity - 1.0) * 100, 4),
                "max_drawdown_pct": round(max_dd, 4),
                "sharpe": round(sharpe, 3),
                "avg_win_pct": round(np.mean([t["ret_pct"] for t in wins]), 4) if wins else 0.0,
                "avg_loss_pct": round(np.mean([t["ret_pct"] for t in losses]), 4) if losses else 0.0,
            },
            "trades": trades,
            "equity_curve": equity_curve,
        }
