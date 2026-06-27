"""Flat indicator snapshot for a symbol/timeframe.

Used by the alertWatcher formula evaluator: it needs a single
dictionary of *current* indicator values to plug into condition checks
like "RSI is_below 30". Pulls candles from yfinance (delayed; cached
30s per (symbol, timeframe)) and runs the same indicator math as
strategy.py.

Output schema (all numeric, or null if not computable):
  RSI, MACD (= macd line), EMA_20, EMA_50, SMA_200, ADX, ATR,
  SUPERTREND (= trend direction +1/-1), VWAP, OBV
Plus the underlying close so the watcher can detect crosses.
"""
from __future__ import annotations

import time as _time
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query

import indicators as ind

try:
    import yfinance as _yf  # type: ignore
    _YF_OK = True
except Exception:  # pragma: no cover
    _YF_OK = False


# (symbol, timeframe) -> (snapshot, fetched_ts)
_SNAP_CACHE: Dict[Tuple[str, str], Tuple[Dict[str, Optional[float]], float]] = {}
_SNAP_TTL = 30.0


def _yf_interval(tf: str) -> Tuple[str, str]:
    """Returns (period, interval) suitable for yfinance.history()."""
    if tf == "M5":
        return ("5d", "5m")
    if tf == "M15":
        return ("10d", "15m")
    if tf == "H1":
        return ("60d", "60m")
    return ("1y", "1d")  # D1 default


def _supertrend_direction(highs: List[float], lows: List[float], closes: List[float]) -> Optional[float]:
    """Use the existing supertrend(); return last direction +1 / -1."""
    try:
        st_line, st_dir = ind.supertrend(highs, lows, closes)
    except Exception:
        return None
    if not st_dir:
        return None
    last = st_dir[-1]
    return float(last) if last is not None else None


def _obv(closes: List[float], volumes: List[float]) -> Optional[float]:
    if len(closes) < 2 or len(volumes) < 2:
        return None
    obv = 0.0
    for i in range(1, len(closes)):
        if closes[i] > closes[i - 1]:
            obv += volumes[i]
        elif closes[i] < closes[i - 1]:
            obv -= volumes[i]
    return obv


def _last(series: List[Optional[float]]) -> Optional[float]:
    if not series:
        return None
    v = series[-1]
    return float(v) if v is not None else None


def build_snapshot(symbol: str, timeframe: str) -> Dict[str, Optional[float]]:
    if not _YF_OK:
        raise HTTPException(status_code=503, detail="yfinance not installed")
    period, interval = _yf_interval(timeframe)
    try:
        sym = symbol.upper()
        if not (sym.endswith(".NS") or sym.endswith(".BO")):
            sym = sym + ".NS"
        hist = _yf.Ticker(sym).history(period=period, interval=interval)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"yfinance error: {e}")
    if hist is None or hist.empty or len(hist) < 30:
        raise HTTPException(status_code=404, detail=f"Insufficient candles for {symbol} {timeframe}")

    highs: List[float] = [float(x) for x in hist["High"].tolist()]
    lows: List[float] = [float(x) for x in hist["Low"].tolist()]
    closes: List[float] = [float(x) for x in hist["Close"].tolist()]
    volumes: List[float] = [float(x) for x in hist["Volume"].tolist()]

    macd_line, _signal, _hist = ind.macd(closes)
    adx_line, _plus_di, _minus_di = ind.adx(highs, lows, closes)
    vwap_series = ind.vwap(highs, lows, closes, volumes)

    snap: Dict[str, Optional[float]] = {
        "RSI": _last(ind.rsi(closes, 14)),
        "MACD": _last(macd_line),
        "EMA_20": _last(ind.ema(closes, 20)),
        "EMA_50": _last(ind.ema(closes, 50)),
        "SMA_200": _last(ind.sma(closes, 200)),
        "ADX": _last(adx_line),
        "ATR": _last(ind.atr(highs, lows, closes, 14)),
        "SUPERTREND": _supertrend_direction(highs, lows, closes),
        "VWAP": _last(vwap_series),
        "OBV": _obv(closes, volumes),
        "CLOSE": float(closes[-1]),
        "PREV_CLOSE": float(closes[-2]) if len(closes) >= 2 else None,
    }
    return snap


def cached_snapshot(symbol: str, timeframe: str) -> Dict[str, Optional[float]]:
    key = (symbol.upper(), timeframe)
    now = _time.time()
    cached = _SNAP_CACHE.get(key)
    if cached and now - cached[1] < _SNAP_TTL:
        return cached[0]
    snap = build_snapshot(key[0], timeframe)
    _SNAP_CACHE[key] = (snap, now)
    return snap


router = APIRouter()


@router.get("/indicators/snapshot/{symbol}")
def get_snapshot(symbol: str, timeframe: str = Query(default="M15", pattern="^(M5|M15|H1|D1)$")):
    return {
        "symbol": symbol.upper(),
        "timeframe": timeframe,
        "fetched_at": int(_time.time() * 1000),
        "values": cached_snapshot(symbol, timeframe),
    }
