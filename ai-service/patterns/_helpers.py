"""Shared geometry + indicator helpers for pattern detectors.

Every detector in this package takes a pandas.DataFrame indexed by integer
position with columns: open, high, low, close, volume. These helpers
encapsulate the common per-candle math (body/range/wicks) and the
multi-bar context (swing pivots, ATR, ADX, EMA, volume ratio) so individual
detectors stay focused on the pattern rule rather than the plumbing.

All helpers are vectorized where reasonable and return plain Python floats or
numpy arrays — no shared mutable state.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, List, Literal, Optional, TypedDict

import numpy as np
import pandas as pd


# ─── Result type ────────────────────────────────────────────────────────────

Direction = Literal["bullish", "bearish", "continuation", "neutral"]


class TrendlinePoint(TypedDict):
    time: int
    price: float


class PatternResult(TypedDict, total=False):
    """Standard shape every detector returns.

    `detected=False` results still carry pattern_name/direction so callers
    can iterate detector outputs generically.

    Western chart patterns + institutional patterns additionally populate
    trendline_points / entry_price / target_price / stop_price / risk_reward.
    """

    pattern_name: str
    detected: bool
    direction: Direction
    candle_indices: List[int]
    strength: float
    description: str
    historical_win_rate: float
    # Western + institutional only:
    trendline_points: List[TrendlinePoint]
    entry_price: Optional[float]
    target_price: Optional[float]
    stop_price: Optional[float]
    risk_reward: Optional[float]


# ─── Historical win-rate baseline ───────────────────────────────────────────
# These are conservative public-domain baselines (Bulkowski, Nison, Bull) used
# as a default before PatternAccuracy from MongoDB overrides them. They're
# intentionally a touch below the literature so a fresh install is humble
# about confidence rather than overstating performance.

HISTORICAL_WIN_RATE: dict[str, float] = {
    # Single-candle
    "Hammer": 0.60, "Inverted Hammer": 0.55, "Shooting Star": 0.59,
    "Hanging Man": 0.55, "Doji": 0.50, "Long-Legged Doji": 0.52,
    "Gravestone Doji": 0.58, "Dragonfly Doji": 0.60, "Spinning Top": 0.50,
    "Bullish Marubozu": 0.63, "Bearish Marubozu": 0.62,
    "Bullish Belt Hold": 0.61, "Bearish Belt Hold": 0.59, "High Wave": 0.50,
    # Two-candle
    "Bullish Engulfing": 0.67, "Bearish Engulfing": 0.66,
    "Bullish Harami": 0.55, "Bearish Harami": 0.54,
    "Bullish Harami Cross": 0.59, "Bearish Harami Cross": 0.58,
    "Piercing Line": 0.64, "Dark Cloud Cover": 0.63,
    "Tweezer Bottom": 0.58, "Tweezer Top": 0.57,
    "On-Neck Pattern": 0.55, "In-Neck Pattern": 0.55, "Thrusting Pattern": 0.55,
    "Bullish Kicker": 0.74, "Bearish Kicker": 0.73,
    "Bullish Meeting Lines": 0.58, "Bearish Meeting Lines": 0.57,
    # Three-candle
    "Morning Star": 0.78, "Evening Star": 0.72,
    "Morning Doji Star": 0.76, "Evening Doji Star": 0.71,
    "Three White Soldiers": 0.78, "Three Black Crows": 0.77,
    "Three Inside Up": 0.65, "Three Inside Down": 0.63,
    "Three Outside Up": 0.69, "Three Outside Down": 0.67,
    "Bullish Abandoned Baby": 0.70, "Bearish Abandoned Baby": 0.69,
    "Advance Block": 0.65, "Deliberation": 0.60,
    "Stick Sandwich": 0.62, "Ladder Bottom": 0.61, "Ladder Top": 0.60,
    "Unique Three River Bottom": 0.61,
    "Two Crows": 0.61, "Upside Gap Two Crows": 0.59,
    "Bullish Mat Hold": 0.78, "Bearish Mat Hold": 0.75,
    # Multi-candle complex
    "Rising Three Methods": 0.74, "Falling Three Methods": 0.71,
    "Three Stars in the South": 0.62,
    "Concealing Baby Swallow": 0.60,
    "Bullish Breakaway": 0.63, "Bearish Breakaway": 0.62,
    "Bullish Eight New Price Lines": 0.55, "Bearish Eight New Price Lines": 0.55,
    # Western
    "Bull Flag": 0.67, "Bear Flag": 0.66,
    "Bull Pennant": 0.62, "Bear Pennant": 0.61,
    "Ascending Triangle": 0.63, "Descending Triangle": 0.61,
    "Symmetrical Triangle": 0.56,
    "Rising Wedge": 0.62, "Falling Wedge": 0.66,
    "Ascending Channel": 0.55, "Descending Channel": 0.55,
    "Horizontal Channel": 0.53,
    "Cup and Handle": 0.65, "Inverse Cup and Handle": 0.61,
    "Head and Shoulders": 0.66, "Inverse Head and Shoulders": 0.68,
    "Double Top": 0.65, "Double Bottom": 0.66,
    "Triple Top": 0.60, "Triple Bottom": 0.62,
    "Rounding Bottom": 0.61, "Rounding Top": 0.55,
    "Rectangle": 0.58,
    "Bullish Island Reversal": 0.60, "Bearish Island Reversal": 0.59,
    "Bump and Run Reversal": 0.58,
    "Diamond Top": 0.59, "Diamond Bottom": 0.60,
    # Institutional
    "Inside Bar": 0.61, "Outside Bar": 0.58,
    "Bullish Pin Bar": 0.66, "Bearish Pin Bar": 0.66,
    "Bullish Fakey": 0.68, "Bearish Fakey": 0.67,
    "Wyckoff Spring": 0.71, "Wyckoff Upthrust": 0.70,
    "Bullish Consolidation Breakout": 0.65, "Bearish Consolidation Breakout": 0.64,
    "Volatility Contraction Pattern": 0.69,
    "NR7": 0.60, "NR4": 0.57,
    "Bullish Wide Range Bar": 0.62, "Bearish Wide Range Bar": 0.61,
    "Bullish Power of 3": 0.65, "Bearish Power of 3": 0.64,
    "Bullish Liquidity Sweep": 0.69, "Bearish Liquidity Sweep": 0.68,
    "Bullish Fair Value Gap": 0.58, "Bearish Fair Value Gap": 0.57,
    "Bullish Order Block": 0.66, "Bearish Order Block": 0.65,
    "Bullish Breaker Block": 0.61, "Bearish Breaker Block": 0.60,
    "Bullish Mitigation Block": 0.60, "Bearish Mitigation Block": 0.59,
    "Bullish Inducement": 0.62, "Bearish Inducement": 0.61,
    "Bullish OTE": 0.70, "Bearish OTE": 0.69,
}


def baseline_win_rate(name: str) -> float:
    """Lookup the conservative baseline. Unknown name → 0.50 (coin flip)."""
    return HISTORICAL_WIN_RATE.get(name, 0.50)


# ─── DataFrame normalisation ────────────────────────────────────────────────

_REQUIRED_COLS = ("open", "high", "low", "close")


def ensure_df(data: Any) -> pd.DataFrame:
    """Accept a DataFrame or a list-of-dicts and return a normalized DataFrame.

    Accepts both lowercase (open/high/low/close/volume) and the AI-service's
    compact form (o/h/l/c/v + t). Adds a `volume` column of zeros if missing
    so volume-aware detectors still run.
    """
    if isinstance(data, pd.DataFrame):
        df = data.copy()
    elif isinstance(data, list):
        df = pd.DataFrame(data)
    else:
        raise TypeError(f"ensure_df: unsupported type {type(data)!r}")

    # Compact → standard column rename, only if standard isn't already present.
    rename: dict[str, str] = {}
    for short, long in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close"), ("v", "volume"), ("t", "time")):
        if short in df.columns and long not in df.columns:
            rename[short] = long
    if rename:
        df = df.rename(columns=rename)

    for col in _REQUIRED_COLS:
        if col not in df.columns:
            raise ValueError(f"ensure_df: missing required column '{col}'")
        # numeric coercion so downstream math doesn't get tripped by str.
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if "volume" not in df.columns:
        df["volume"] = 0.0
    else:
        df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0.0)
    if "time" not in df.columns:
        # Fall back to positional time.
        df["time"] = np.arange(len(df), dtype="int64")
    df = df.reset_index(drop=True)
    return df


# ─── Per-candle geometry (works on row-like dict or DataFrame row) ──────────

def _val(row: Any, key: str) -> float:
    """Read a column from a pandas Series, dict, or namedtuple."""
    try:
        return float(row[key])
    except (KeyError, TypeError):
        return float(getattr(row, key))


def body(row: Any) -> float:
    return _val(row, "close") - _val(row, "open")


def abs_body(row: Any) -> float:
    return abs(body(row))


def candle_range(row: Any) -> float:
    return max(_val(row, "high") - _val(row, "low"), 1e-9)


def upper_shadow(row: Any) -> float:
    return _val(row, "high") - max(_val(row, "open"), _val(row, "close"))


def lower_shadow(row: Any) -> float:
    return min(_val(row, "open"), _val(row, "close")) - _val(row, "low")


def is_bull(row: Any) -> bool:
    return _val(row, "close") > _val(row, "open")


def is_bear(row: Any) -> bool:
    return _val(row, "close") < _val(row, "open")


def is_doji(row: Any, *, body_to_range: float = 0.10) -> bool:
    return abs_body(row) <= body_to_range * candle_range(row)


# ─── Indicators ─────────────────────────────────────────────────────────────

def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False, min_periods=1).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(window=period, min_periods=1).mean()


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Wilder's ATR. Returns a Series aligned to df.index."""
    high = df["high"]
    low = df["low"]
    close = df["close"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean()


def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """ADX (Wilder). Returns the ADX series (0..100)."""
    high = df["high"]
    low = df["low"]
    close = df["close"]
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = ((up_move > down_move) & (up_move > 0)).astype(float) * up_move.clip(lower=0)
    minus_dm = ((down_move > up_move) & (down_move > 0)).astype(float) * down_move.clip(lower=0)
    tr = pd.concat(
        [(high - low), (high - close.shift(1)).abs(), (low - close.shift(1)).abs()],
        axis=1,
    ).max(axis=1)
    atr_w = tr.ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean()
    safe_atr = atr_w.replace(0, np.nan)
    plus_di = 100 * plus_dm.ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean() / safe_atr
    minus_di = 100 * minus_dm.ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean() / safe_atr
    denom = (plus_di + minus_di).replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / denom
    adx_series = dx.ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean().fillna(0.0)
    return adx_series


def avg_body(df: pd.DataFrame, window: int = 20) -> pd.Series:
    """Rolling mean of |close-open| — the typical body size."""
    return (df["close"] - df["open"]).abs().rolling(window=window, min_periods=1).mean()


def volume_ratio(df: pd.DataFrame, window: int = 20, idx: int = -1) -> float:
    """volume[idx] divided by the SMA of the prior `window` bars."""
    if len(df) < 2 or "volume" not in df.columns:
        return 1.0
    i = idx if idx >= 0 else len(df) + idx
    if i <= 0:
        return 1.0
    start = max(0, i - window)
    prior = df["volume"].iloc[start:i]
    if len(prior) == 0:
        return 1.0
    avg = float(prior.mean())
    if avg <= 0:
        return 1.0
    return float(df["volume"].iloc[i]) / avg


def trend_classify(df: pd.DataFrame) -> Literal["uptrend", "downtrend", "sideways"]:
    """Classify trend from EMA20 vs EMA50 slope + ADX."""
    if len(df) < 50:
        return "sideways"
    close = df["close"]
    ema20 = ema(close, 20)
    ema50 = ema(close, 50)
    adx_val = float(adx(df, 14).iloc[-1])
    last20 = float(ema20.iloc[-1])
    last50 = float(ema50.iloc[-1])
    prev20 = float(ema20.iloc[-5]) if len(ema20) >= 5 else last20
    slope = last20 - prev20
    if adx_val < 18:
        return "sideways"
    if last20 > last50 and slope > 0:
        return "uptrend"
    if last20 < last50 and slope < 0:
        return "downtrend"
    return "sideways"


# ─── Swing pivot detection ──────────────────────────────────────────────────

@dataclass
class Pivot:
    idx: int
    price: float
    kind: str  # 'H' or 'L'

    def as_point(self, df: pd.DataFrame) -> TrendlinePoint:
        try:
            t = int(df["time"].iloc[self.idx])
        except Exception:
            t = self.idx
        return {"time": t, "price": float(self.price)}


def find_pivots(df: pd.DataFrame, lookback: int = 3) -> List[Pivot]:
    """Mark a bar as a swing high/low if it is the strict max/min within ±lookback."""
    highs = df["high"].to_numpy()
    lows = df["low"].to_numpy()
    n = len(df)
    out: List[Pivot] = []
    for i in range(lookback, n - lookback):
        window_h = highs[i - lookback : i + lookback + 1]
        window_l = lows[i - lookback : i + lookback + 1]
        if highs[i] == window_h.max() and (window_h == highs[i]).sum() == 1:
            out.append(Pivot(i, float(highs[i]), "H"))
        elif lows[i] == window_l.min() and (window_l == lows[i]).sum() == 1:
            out.append(Pivot(i, float(lows[i]), "L"))
    return out


def alternating_pivots(pivots: List[Pivot]) -> List[Pivot]:
    """Filter pivots to a strict alternating H/L sequence, keeping the more
    extreme one when two pivots of the same kind appear back-to-back."""
    out: List[Pivot] = []
    for p in pivots:
        if not out or out[-1].kind != p.kind:
            out.append(p)
        else:
            if p.kind == "H" and p.price > out[-1].price:
                out[-1] = p
            elif p.kind == "L" and p.price < out[-1].price:
                out[-1] = p
    return out


def fit_line(points: List[tuple[int, float]]) -> tuple[float, float]:
    """Least-squares fit y = m*x + b → (slope, intercept). Empty input → (0, 0)."""
    if len(points) < 2:
        return 0.0, (points[0][1] if points else 0.0)
    xs = np.array([p[0] for p in points], dtype=float)
    ys = np.array([p[1] for p in points], dtype=float)
    if xs.std() == 0:
        return 0.0, float(ys.mean())
    m, b = np.polyfit(xs, ys, 1)
    return float(m), float(b)


# ─── Result builders ────────────────────────────────────────────────────────

def empty_result(name: str, direction: Direction = "neutral") -> PatternResult:
    """Standard "not detected" payload — keeps the return shape stable."""
    return {
        "pattern_name": name,
        "detected": False,
        "direction": direction,
        "candle_indices": [],
        "strength": 0.0,
        "description": "",
        "historical_win_rate": baseline_win_rate(name),
    }


def make_result(
    name: str,
    *,
    direction: Direction,
    indices: Iterable[int],
    strength: float,
    description: str,
    win_rate: Optional[float] = None,
) -> PatternResult:
    return {
        "pattern_name": name,
        "detected": True,
        "direction": direction,
        "candle_indices": [int(i) for i in indices],
        "strength": float(max(0.0, min(1.0, strength))),
        "description": description,
        "historical_win_rate": float(win_rate if win_rate is not None else baseline_win_rate(name)),
    }


def make_extended_result(
    name: str,
    *,
    direction: Direction,
    indices: Iterable[int],
    strength: float,
    description: str,
    entry_price: float,
    target_price: float,
    stop_price: float,
    trendline_points: Optional[List[TrendlinePoint]] = None,
    win_rate: Optional[float] = None,
) -> PatternResult:
    """Result variant for Western + institutional patterns: adds chart overlay
    coordinates, entry / target / stop, and the derived risk:reward."""
    risk = abs(entry_price - stop_price)
    reward = abs(target_price - entry_price)
    rr = (reward / risk) if risk > 1e-9 else 0.0
    base = make_result(
        name,
        direction=direction,
        indices=indices,
        strength=strength,
        description=description,
        win_rate=win_rate,
    )
    base["entry_price"] = float(entry_price)
    base["target_price"] = float(target_price)
    base["stop_price"] = float(stop_price)
    base["risk_reward"] = float(round(rr, 3))
    base["trendline_points"] = trendline_points or []
    return base


# ─── Misc utilities ─────────────────────────────────────────────────────────

def gap_up(prev: Any, curr: Any) -> bool:
    return _val(curr, "low") > _val(prev, "high")


def gap_down(prev: Any, curr: Any) -> bool:
    return _val(curr, "high") < _val(prev, "low")


def near_long_ema_support(df: pd.DataFrame, *, period: int = 200, tol_pct: float = 0.01) -> bool:
    if len(df) < period // 2:
        return False
    e = float(ema(df["close"], period).iloc[-1])
    last = float(df["close"].iloc[-1])
    return abs(last - e) / max(last, 1e-9) <= tol_pct


def round_pct(x: float, digits: int = 3) -> float:
    return round(float(x), digits)
