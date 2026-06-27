"""Pure-Python technical indicators.

Designed for small candle windows (200–500 bars) where pandas/numpy speed
is not material. All functions accept lists and return lists or floats.
Output arrays are aligned to the input length, with leading None values
for warmup periods.
"""

from __future__ import annotations

from typing import List, Optional, Tuple


# -------- moving averages --------

def sma(values: List[float], period: int) -> List[Optional[float]]:
    out: List[Optional[float]] = []
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= period:
            s -= values[i - period]
        out.append(s / period if i >= period - 1 else None)
    return out


def ema(values: List[float], period: int) -> List[Optional[float]]:
    out: List[Optional[float]] = []
    if not values:
        return out
    k = 2.0 / (period + 1)
    prev: Optional[float] = None
    for i, v in enumerate(values):
        if i < period - 1:
            out.append(None)
            continue
        if prev is None:
            # seed with SMA of first `period` values
            prev = sum(values[: period]) / period
            out.append(prev)
            continue
        prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


# -------- oscillators --------

def rsi(closes: List[float], period: int = 14) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d > 0:
            gains += d
        else:
            losses -= d
    avg_gain = gains / period
    avg_loss = losses / period

    def _rsi_from_avgs(g: float, l: float) -> float:
        # Flat market (no gain, no loss) → neutral 50, not 100.
        if l == 0 and g == 0:
            return 50.0
        if l == 0:
            return 100.0
        return 100.0 - 100.0 / (1.0 + (g / l))

    out[period] = _rsi_from_avgs(avg_gain, avg_loss)
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = max(d, 0.0)
        loss = max(-d, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = _rsi_from_avgs(avg_gain, avg_loss)
    return out


def stochastic_rsi(closes: List[float], period: int = 14, smooth_k: int = 3, smooth_d: int = 3) -> Tuple[List[Optional[float]], List[Optional[float]]]:
    r = rsi(closes, period)
    # min/max of RSI over period
    k_raw: List[Optional[float]] = [None] * len(closes)
    for i in range(period * 2, len(closes)):
        window = [x for x in r[i - period + 1 : i + 1] if x is not None]
        if len(window) < period:
            continue
        lo, hi = min(window), max(window)
        denom = hi - lo
        k_raw[i] = 0.0 if denom == 0 else (r[i] - lo) / denom * 100.0  # type: ignore[operator]
    k = sma([v if v is not None else 0.0 for v in k_raw], smooth_k)
    d = sma([v if v is not None else 0.0 for v in k], smooth_d)
    # restore None alignment
    k_aligned = [None if k_raw[i] is None else k[i] for i in range(len(closes))]
    d_aligned = [None if k_raw[i] is None else d[i] for i in range(len(closes))]
    return k_aligned, d_aligned


def macd(closes: List[float], fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[List[Optional[float]], List[Optional[float]], List[Optional[float]]]:
    ef = ema(closes, fast)
    es = ema(closes, slow)
    line: List[Optional[float]] = []
    for i in range(len(closes)):
        if ef[i] is None or es[i] is None:
            line.append(None)
        else:
            line.append(ef[i] - es[i])  # type: ignore[operator]
    line_floats = [v if v is not None else 0.0 for v in line]
    sig = ema(line_floats, signal)
    # align signal to None where line is None
    sig_aligned = [None if line[i] is None else sig[i] for i in range(len(closes))]
    hist: List[Optional[float]] = []
    for i in range(len(closes)):
        if line[i] is None or sig_aligned[i] is None:
            hist.append(None)
        else:
            hist.append(line[i] - sig_aligned[i])  # type: ignore[operator]
    return line, sig_aligned, hist


# -------- volatility --------

def true_range(highs: List[float], lows: List[float], closes: List[float]) -> List[float]:
    out = [highs[0] - lows[0]]
    for i in range(1, len(closes)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        out.append(tr)
    return out


def atr(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> List[Optional[float]]:
    tr = true_range(highs, lows, closes)
    out: List[Optional[float]] = [None] * len(closes)
    if len(closes) < period:
        return out
    prev = sum(tr[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(closes)):
        prev = (prev * (period - 1) + tr[i]) / period
        out[i] = prev
    return out


def adx(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> Tuple[List[Optional[float]], List[Optional[float]], List[Optional[float]]]:
    """Returns (adx, +DI, -DI). ADX measures trend strength regardless of direction."""
    n = len(closes)
    if n < period + 2:
        return [None] * n, [None] * n, [None] * n
    tr = true_range(highs, lows, closes)
    plus_dm: List[float] = [0.0]
    minus_dm: List[float] = [0.0]
    for i in range(1, n):
        up = highs[i] - highs[i - 1]
        down = lows[i - 1] - lows[i]
        plus_dm.append(up if (up > down and up > 0) else 0.0)
        minus_dm.append(down if (down > up and down > 0) else 0.0)

    # Wilder smoothing
    def wilder(values: List[float]) -> List[Optional[float]]:
        out: List[Optional[float]] = [None] * n
        if n < period:
            return out
        s = sum(values[:period])
        out[period - 1] = s
        for i in range(period, n):
            s = s - s / period + values[i]
            out[i] = s
        return out

    tr_s = wilder(tr)
    plus_dm_s = wilder(plus_dm)
    minus_dm_s = wilder(minus_dm)

    plus_di: List[Optional[float]] = [None] * n
    minus_di: List[Optional[float]] = [None] * n
    dx: List[Optional[float]] = [None] * n
    for i in range(period - 1, n):
        if tr_s[i] in (None, 0):
            continue
        pd = 100.0 * (plus_dm_s[i] or 0) / tr_s[i]  # type: ignore[operator]
        nd = 100.0 * (minus_dm_s[i] or 0) / tr_s[i]  # type: ignore[operator]
        plus_di[i] = pd
        minus_di[i] = nd
        denom = pd + nd
        dx[i] = 100.0 * abs(pd - nd) / denom if denom > 0 else 0.0

    adx_out: List[Optional[float]] = [None] * n
    # ADX is Wilder-smoothed average of DX
    first = period - 1 + period
    if n > first:
        seed = [v for v in dx[period - 1 : first] if v is not None]
        if len(seed) == period:
            prev = sum(seed) / period
            adx_out[first - 1] = prev
            for i in range(first, n):
                v = dx[i] if dx[i] is not None else prev
                prev = (prev * (period - 1) + v) / period
                adx_out[i] = prev
    return adx_out, plus_di, minus_di


def bollinger(closes: List[float], period: int = 20, mult: float = 2.0) -> Tuple[List[Optional[float]], List[Optional[float]], List[Optional[float]]]:
    mid = sma(closes, period)
    upper: List[Optional[float]] = [None] * len(closes)
    lower: List[Optional[float]] = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1 : i + 1]
        m = mid[i]
        if m is None:
            continue
        var = sum((x - m) ** 2 for x in window) / period
        sd = var ** 0.5
        upper[i] = m + mult * sd
        lower[i] = m - mult * sd
    return upper, mid, lower


# -------- volume --------

def vwap(highs: List[float], lows: List[float], closes: List[float], volumes: List[float]) -> List[Optional[float]]:
    """Running session VWAP from start of provided series."""
    out: List[Optional[float]] = []
    cum_pv = 0.0
    cum_v = 0.0
    for i in range(len(closes)):
        tp = (highs[i] + lows[i] + closes[i]) / 3.0
        cum_pv += tp * volumes[i]
        cum_v += volumes[i]
        out.append(cum_pv / cum_v if cum_v else None)
    return out


# -------- supertrend --------

def supertrend(
    highs: List[float],
    lows: List[float],
    closes: List[float],
    period: int = 10,
    multiplier: float = 3.0,
) -> Tuple[List[Optional[float]], List[Optional[int]]]:
    """Returns (line, direction) where direction is +1 (uptrend) or -1 (downtrend)."""
    a = atr(highs, lows, closes, period)
    line: List[Optional[float]] = [None] * len(closes)
    direction: List[Optional[int]] = [None] * len(closes)
    prev_upper: Optional[float] = None
    prev_lower: Optional[float] = None
    prev_dir: Optional[int] = None
    for i in range(len(closes)):
        if a[i] is None:
            continue
        hl2 = (highs[i] + lows[i]) / 2.0
        upper = hl2 + multiplier * a[i]  # type: ignore[operator]
        lower = hl2 - multiplier * a[i]  # type: ignore[operator]
        # tightening rules
        if prev_upper is not None and closes[i - 1] <= prev_upper:
            upper = min(upper, prev_upper)
        if prev_lower is not None and closes[i - 1] >= prev_lower:
            lower = max(lower, prev_lower)
        if prev_dir is None:
            d = 1 if closes[i] > upper else -1
        elif prev_dir == 1:
            d = -1 if closes[i] < lower else 1
        else:
            d = 1 if closes[i] > upper else -1
        line[i] = lower if d == 1 else upper
        direction[i] = d
        prev_upper = upper
        prev_lower = lower
        prev_dir = d
    return line, direction


# -------- ichimoku --------

def ichimoku(
    highs: List[float],
    lows: List[float],
    closes: List[float],
    tenkan_p: int = 9,
    kijun_p: int = 26,
    senkou_b_p: int = 52,
) -> dict:
    def donchian_mid(p: int) -> List[Optional[float]]:
        out: List[Optional[float]] = [None] * len(closes)
        for i in range(p - 1, len(closes)):
            window_h = highs[i - p + 1 : i + 1]
            window_l = lows[i - p + 1 : i + 1]
            out[i] = (max(window_h) + min(window_l)) / 2.0
        return out

    tenkan = donchian_mid(tenkan_p)
    kijun = donchian_mid(kijun_p)
    senkou_a: List[Optional[float]] = []
    for i in range(len(closes)):
        if tenkan[i] is None or kijun[i] is None:
            senkou_a.append(None)
        else:
            senkou_a.append((tenkan[i] + kijun[i]) / 2.0)  # type: ignore[operator]
    senkou_b = donchian_mid(senkou_b_p)
    chikou = closes[kijun_p:] + [None] * kijun_p
    return {
        "tenkan": tenkan,
        "kijun": kijun,
        "senkouA": senkou_a,
        "senkouB": senkou_b,
        "chikou": chikou,
    }
