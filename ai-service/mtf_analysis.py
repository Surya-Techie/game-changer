"""Multi-timeframe analysis: per-TF trend, RSI, MACD bias, Supertrend bias, signal."""

from __future__ import annotations

from typing import Dict, List

from indicators import macd, rsi, sma, supertrend
from multitimeframe import resample


def _analyse_tf(candles: List[dict]) -> dict:
    if len(candles) < 30:
        return {"bars": len(candles), "trend": "FLAT", "rsi": None, "macd": "neutral", "supertrend": 0, "signal": "FLAT"}
    closes = [c["c"] for c in candles]
    highs = [c["h"] for c in candles]
    lows = [c["l"] for c in candles]

    fast = sma(closes, 9)[-1] or closes[-1]
    slow = sma(closes, 21)[-1] or closes[-1]
    trend = "UP" if fast > slow * 1.0005 else "DOWN" if fast < slow * 0.9995 else "FLAT"

    r = rsi(closes, 14)[-1]
    r_val = round(r, 1) if r is not None else None

    macd_line, macd_sig, macd_hist = macd(closes)
    hist = macd_hist[-1] or 0
    macd_bias = "bull" if hist > 0 else "bear" if hist < 0 else "neutral"

    _, st_dir = supertrend(highs, lows, closes)
    st_now = st_dir[-1] if st_dir[-1] is not None else 0

    # Aggregate signal.
    bull = 0
    bear = 0
    if trend == "UP": bull += 1
    elif trend == "DOWN": bear += 1
    if macd_bias == "bull": bull += 1
    elif macd_bias == "bear": bear += 1
    if st_now == 1: bull += 1
    elif st_now == -1: bear += 1
    if r_val is not None:
        if r_val > 55: bull += 1
        elif r_val < 45: bear += 1

    if bull >= 3 and bull > bear:
        signal = "BULL"
    elif bear >= 3 and bear > bull:
        signal = "BEAR"
    else:
        signal = "NEUTRAL"

    return {
        "bars": len(candles),
        "trend": trend,
        "rsi": r_val,
        "macd": macd_bias,
        "supertrend": int(st_now),
        "signal": signal,
        "bullVotes": bull,
        "bearVotes": bear,
    }


def mtf_summary(candles_1m: List[dict]) -> dict:
    """Compute per-timeframe analysis + alignment score."""
    timeframes = {
        "1m": candles_1m,
        "5m": resample(candles_1m, 5),
        "15m": resample(candles_1m, 15),
        "1h": resample(candles_1m, 60),
        "1D": resample(candles_1m, 60 * 24),
    }
    per_tf = {label: _analyse_tf(bars) for label, bars in timeframes.items()}

    # Alignment: how many TFs agree on direction.
    signals = [v["signal"] for v in per_tf.values()]
    bull = signals.count("BULL")
    bear = signals.count("BEAR")
    aligned_count = max(bull, bear)
    aligned_dir = "BULL" if bull >= bear else "BEAR"
    if aligned_count == bear and bear > bull:
        aligned_dir = "BEAR"

    return {
        "timeframes": per_tf,
        "alignment": {
            "score": aligned_count,
            "outOf": len(per_tf),
            "direction": aligned_dir if aligned_count > 0 else "NEUTRAL",
        },
    }
