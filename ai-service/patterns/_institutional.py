"""Institutional / smart-money pattern detectors.

These are the higher-edge setups: Wyckoff (Spring/Upthrust), ICT/SMC
(FVG, Order Block, Breaker Block, Mitigation Block, Inducement, OTE,
Liquidity Sweep, Power of 3), volatility-compression (NR7, NR4, VCP),
and momentum context bars (Inside, Outside, Pin, Fakey, WRB,
Consolidation Breakout). Each detector returns the extended PatternResult
with trendline_points / entry_price / target_price / stop_price / risk_reward
so the Chart can overlay measured-move markers.
"""

from __future__ import annotations

from typing import List, Optional

import numpy as np
import pandas as pd

from ._helpers import (
    PatternResult,
    TrendlinePoint,
    abs_body,
    adx,
    atr,
    candle_range,
    empty_result,
    ensure_df,
    is_bear,
    is_bull,
    lower_shadow,
    make_extended_result,
    upper_shadow,
    volume_ratio,
    _val,
)


# ─── shared ────────────────────────────────────────────────────────────────

def _idx(df: pd.DataFrame, idx: Optional[int]) -> int:
    return (len(df) - 1) if idx is None else (idx if idx >= 0 else len(df) + idx)


def _point(df: pd.DataFrame, i: int, price: float) -> TrendlinePoint:
    try:
        t = int(df["time"].iloc[i])
    except Exception:
        t = i
    return {"time": t, "price": float(price)}


# ─── Inside / Outside Bar ──────────────────────────────────────────────────

def detect_inside_bar(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    """Inside Bar with trend filter: only fires when ADX > 20 so we're not
    flagging consolidation in chop. Direction follows the prevailing trend."""
    name = "Inside Bar"
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 15:
        return empty_result(name, "continuation")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (_val(curr, "high") < _val(prev, "high") and _val(curr, "low") > _val(prev, "low")):
        return empty_result(name, "continuation")
    adx_now = float(adx(df, 14).iloc[i])
    if adx_now < 20:
        return empty_result(name, "continuation")
    # Use prior bar trend as direction.
    direction = "bullish" if _val(prev, "close") > _val(prev, "open") else "bearish"
    if direction == "bullish":
        entry = float(_val(prev, "high"))
        stop = float(_val(prev, "low"))
        target = entry + 2 * (entry - stop)
    else:
        entry = float(_val(prev, "low"))
        stop = float(_val(prev, "high"))
        target = entry - 2 * (stop - entry)
    tps = [_point(df, i - 1, float(_val(prev, "high"))), _point(df, i, float(_val(prev, "high"))),
           _point(df, i - 1, float(_val(prev, "low"))), _point(df, i, float(_val(prev, "low")))]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=[i - 1, i],
        strength=min(1.0, 0.50 + (adx_now - 20) / 80),
        description=f"Inside bar inside the prior 'mother bar' range with ADX {adx_now:.0f} — compression before trend continuation.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_outside_bar(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    """Outside / engulfing-range bar — both high and low extend beyond prior."""
    name = "Outside Bar"
    df = ensure_df(df)
    i = _idx(df, idx)
    if i < 3:
        return empty_result(name, "neutral")
    prev = df.iloc[i - 1]
    curr = df.iloc[i]
    if not (_val(curr, "high") > _val(prev, "high") and _val(curr, "low") < _val(prev, "low")):
        return empty_result(name, "neutral")
    direction = "bullish" if is_bull(curr) else "bearish"
    if direction == "bullish":
        entry = float(_val(curr, "high"))
        stop = float(_val(curr, "low"))
        target = entry + (entry - stop) * 1.5
    else:
        entry = float(_val(curr, "low"))
        stop = float(_val(curr, "high"))
        target = entry - (stop - entry) * 1.5
    rng = candle_range(curr)
    prev_rng = candle_range(prev)
    strength = min(1.0, 0.50 + 0.25 * min(rng / max(prev_rng, 1e-9), 3.0) / 3.0)
    tps = [_point(df, i - 1, float(_val(prev, "high"))), _point(df, i, float(_val(curr, "high"))),
           _point(df, i - 1, float(_val(prev, "low"))), _point(df, i, float(_val(curr, "low")))]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=[i - 1, i],
        strength=strength,
        description=f"Outside bar — current range {rng / max(prev_rng, 1e-9):.1f}× prior — expansion in the {direction} direction.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Pin Bar (precise) ─────────────────────────────────────────────────────

def detect_bullish_pin_bar(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    """Pin bar: wick ≥ 2.5× body, close in top 35% of range."""
    name = "Bullish Pin Bar"
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if body_a == 0 or rng == 0:
        return empty_result(name, "bullish")
    lw = lower_shadow(row)
    uw = upper_shadow(row)
    if lw < 2.5 * body_a or uw > 0.25 * rng:
        return empty_result(name, "bullish")
    # Close in top 35% of range.
    close_pos = (_val(row, "close") - _val(row, "low")) / rng
    if close_pos < 0.65:
        return empty_result(name, "bullish")
    entry = float(_val(row, "high"))
    stop = float(_val(row, "low"))
    target = entry + 2 * (entry - stop)
    strength = min(1.0, 0.55 + 0.20 * min(lw / body_a, 6.0) / 6.0 + 0.10 * (close_pos - 0.65) / 0.35)
    tps = [_point(df, i, float(_val(row, "high"))), _point(df, i, float(_val(row, "low")))]
    return make_extended_result(
        name,
        direction="bullish",
        indices=[i],
        strength=strength,
        description=f"Bullish pin bar — lower wick {lw / body_a:.1f}× body, close in top {close_pos * 100:.0f}% of range. Strong rejection of lows.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bearish_pin_bar(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Bearish Pin Bar"
    df = ensure_df(df)
    i = _idx(df, idx)
    row = df.iloc[i]
    rng = candle_range(row)
    body_a = abs_body(row)
    if body_a == 0 or rng == 0:
        return empty_result(name, "bearish")
    lw = lower_shadow(row)
    uw = upper_shadow(row)
    if uw < 2.5 * body_a or lw > 0.25 * rng:
        return empty_result(name, "bearish")
    close_pos = (_val(row, "close") - _val(row, "low")) / rng
    if close_pos > 0.35:
        return empty_result(name, "bearish")
    entry = float(_val(row, "low"))
    stop = float(_val(row, "high"))
    target = entry - 2 * (stop - entry)
    strength = min(1.0, 0.55 + 0.20 * min(uw / body_a, 6.0) / 6.0 + 0.10 * (0.35 - close_pos) / 0.35)
    tps = [_point(df, i, float(_val(row, "high"))), _point(df, i, float(_val(row, "low")))]
    return make_extended_result(
        name,
        direction="bearish",
        indices=[i],
        strength=strength,
        description=f"Bearish pin bar — upper wick {uw / body_a:.1f}× body, close in bottom {close_pos * 100:.0f}% of range. Strong rejection of highs.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Fakey (Inside Bar false breakout) ─────────────────────────────────────

def _detect_fakey(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Fakey" if direction == "bullish" else "Bearish Fakey"
    df = ensure_df(df)
    i = _idx(df, None)
    if i < 4:
        return empty_result(name, direction)  # type: ignore[arg-type]
    mother = df.iloc[i - 2]
    inside = df.iloc[i - 1]
    trigger = df.iloc[i]
    # Inside bar inside mother bar.
    if not (_val(inside, "high") < _val(mother, "high") and _val(inside, "low") > _val(mother, "low")):
        return empty_result(name, direction)  # type: ignore[arg-type]
    if direction == "bullish":
        # Trigger pokes below mother low then closes back above it (failed breakdown).
        if _val(trigger, "low") >= _val(mother, "low"):
            return empty_result(name, "bullish")
        if _val(trigger, "close") <= _val(mother, "low"):
            return empty_result(name, "bullish")
        if not is_bull(trigger):
            return empty_result(name, "bullish")
        entry = float(_val(mother, "high"))
        stop = float(_val(trigger, "low"))
        target = entry + 2 * (entry - stop)
    else:
        if _val(trigger, "high") <= _val(mother, "high"):
            return empty_result(name, "bearish")
        if _val(trigger, "close") >= _val(mother, "high"):
            return empty_result(name, "bearish")
        if not is_bear(trigger):
            return empty_result(name, "bearish")
        entry = float(_val(mother, "low"))
        stop = float(_val(trigger, "high"))
        target = entry - 2 * (stop - entry)
    tps = [_point(df, i - 2, float(_val(mother, "high"))), _point(df, i - 2, float(_val(mother, "low"))),
           _point(df, i, float(_val(trigger, "high"))), _point(df, i, float(_val(trigger, "low")))]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=[i - 2, i - 1, i],
        strength=0.62,
        description=f"Inside bar false breakout in the {'opposite' if direction == 'bullish' else 'opposite'} direction — classic stop-hunt fakeout setup.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bullish_fakey(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_fakey(df, "bullish")


def detect_bearish_fakey(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_fakey(df, "bearish")


# ─── Wyckoff Spring / Upthrust ─────────────────────────────────────────────

def detect_wyckoff_spring(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Wyckoff Spring"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "bullish")
    # Identify the support of the prior ~20-bar range, then look for a
    # current bar that pokes below it and closes back inside.
    lookback = 20
    base = df.iloc[n - 1 - lookback : n - 1]
    support = float(base["low"].min())
    curr = df.iloc[n - 1]
    if _val(curr, "low") >= support:
        return empty_result(name, "bullish")
    if _val(curr, "close") <= support:
        return empty_result(name, "bullish")
    # Optional volume confirmation — higher volume = stronger spring.
    vr = volume_ratio(df, window=lookback, idx=n - 1)
    body_recover = (_val(curr, "close") - _val(curr, "low")) / max(candle_range(curr), 1e-9)
    if body_recover < 0.5:
        return empty_result(name, "bullish")
    rng = float(base["high"].max()) - support
    entry = float(_val(curr, "close"))
    stop = float(_val(curr, "low"))
    target = entry + rng * 0.7
    tps = [_point(df, n - 1 - lookback, support), _point(df, n - 1, support),
           _point(df, n - 1, float(_val(curr, "low"))), _point(df, n - 1, float(_val(curr, "close")))]
    strength = min(1.0, 0.55 + 0.15 * body_recover + 0.10 * min(vr, 3.0) / 3.0)
    return make_extended_result(
        name,
        direction="bullish",
        indices=[n - 1 - lookback, n - 1],
        strength=strength,
        description=f"Price spiked below the {lookback}-bar support (Wyckoff Spring) then closed back inside — institutional accumulation; vol×{vr:.2f}.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_wyckoff_upthrust(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    name = "Wyckoff Upthrust"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, "bearish")
    lookback = 20
    base = df.iloc[n - 1 - lookback : n - 1]
    resistance = float(base["high"].max())
    curr = df.iloc[n - 1]
    if _val(curr, "high") <= resistance:
        return empty_result(name, "bearish")
    if _val(curr, "close") >= resistance:
        return empty_result(name, "bearish")
    vr = volume_ratio(df, window=lookback, idx=n - 1)
    body_recover = (_val(curr, "high") - _val(curr, "close")) / max(candle_range(curr), 1e-9)
    if body_recover < 0.5:
        return empty_result(name, "bearish")
    rng = resistance - float(base["low"].min())
    entry = float(_val(curr, "close"))
    stop = float(_val(curr, "high"))
    target = entry - rng * 0.7
    tps = [_point(df, n - 1 - lookback, resistance), _point(df, n - 1, resistance),
           _point(df, n - 1, float(_val(curr, "high"))), _point(df, n - 1, float(_val(curr, "close")))]
    strength = min(1.0, 0.55 + 0.15 * body_recover + 0.10 * min(vr, 3.0) / 3.0)
    return make_extended_result(
        name,
        direction="bearish",
        indices=[n - 1 - lookback, n - 1],
        strength=strength,
        description=f"Price spiked above the {lookback}-bar resistance (Wyckoff Upthrust) then closed back inside — institutional distribution; vol×{vr:.2f}.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── Consolidation Breakout (20-bar) ───────────────────────────────────────

def _detect_consolidation_breakout(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Consolidation Breakout" if direction == "bullish" else "Bearish Consolidation Breakout"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, direction)  # type: ignore[arg-type]
    base = df.iloc[n - 1 - 20 : n - 1]
    hi = float(base["high"].max())
    lo = float(base["low"].min())
    curr = df.iloc[n - 1]
    vr = volume_ratio(df, window=20, idx=n - 1)
    if vr < 1.5:
        return empty_result(name, direction)  # type: ignore[arg-type]
    if direction == "bullish":
        if _val(curr, "close") <= hi:
            return empty_result(name, "bullish")
        rng = hi - lo
        entry = float(_val(curr, "close"))
        stop = hi - rng * 0.25
        target = entry + rng
    else:
        if _val(curr, "close") >= lo:
            return empty_result(name, "bearish")
        rng = hi - lo
        entry = float(_val(curr, "close"))
        stop = lo + rng * 0.25
        target = entry - rng
    tps = [_point(df, n - 1 - 20, hi), _point(df, n - 1, hi),
           _point(df, n - 1 - 20, lo), _point(df, n - 1, lo)]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=list(range(n - 1 - 20, n)),
        strength=min(1.0, 0.55 + 0.20 * min(vr - 1.5, 1.5) / 1.5),
        description=f"Close broke the 20-bar { 'resistance' if direction == 'bullish' else 'support' } on volume {vr:.2f}× average — momentum breakout.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bullish_consolidation_breakout(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_consolidation_breakout(df, "bullish")


def detect_bearish_consolidation_breakout(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_consolidation_breakout(df, "bearish")


# ─── VCP (Volatility Contraction Pattern) ─────────────────────────────────

def detect_volatility_contraction_pattern(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    """3+ progressively smaller pullbacks with declining volume — Minervini's VCP.

    We detect contractions on swings of 5-bar pivots and require:
      • at least 3 contractions
      • each new contraction ≤ ~60% of the prior contraction's range
      • cumulative volume across each contraction trending down
    """
    name = "Volatility Contraction Pattern"
    df = ensure_df(df)
    n = len(df)
    if n < 30:
        return empty_result(name, "bullish")
    closes = df["close"].to_numpy()
    highs = df["high"].to_numpy()
    lows = df["low"].to_numpy()
    vols = df["volume"].to_numpy()
    # Identify rolling-5 swing highs/lows up to current bar.
    swing_highs: List[int] = []
    swing_lows: List[int] = []
    for i in range(3, n - 3):
        win_h = highs[i - 3 : i + 4]
        win_l = lows[i - 3 : i + 4]
        if highs[i] == win_h.max() and (win_h == highs[i]).sum() == 1:
            swing_highs.append(i)
        elif lows[i] == win_l.min() and (win_l == lows[i]).sum() == 1:
            swing_lows.append(i)
    if len(swing_highs) < 3 or len(swing_lows) < 3:
        return empty_result(name, "bullish")
    # Build contractions: each high → next low.
    contractions: List[tuple[int, int, float, float]] = []  # (start, end, range_pct, avg_vol)
    pivots = sorted([(i, "H", float(highs[i])) for i in swing_highs] + [(i, "L", float(lows[i])) for i in swing_lows])
    for k in range(len(pivots) - 1):
        a_idx, a_kind, a_price = pivots[k]
        b_idx, b_kind, b_price = pivots[k + 1]
        if a_kind == "H" and b_kind == "L":
            rng_pct = (a_price - b_price) / max(a_price, 1e-9)
            avg_vol = float(vols[a_idx : b_idx + 1].mean())
            contractions.append((a_idx, b_idx, rng_pct, avg_vol))
    if len(contractions) < 3:
        return empty_result(name, "bullish")
    last_three = contractions[-3:]
    # Ranges must be decreasing.
    if not (last_three[0][2] > last_three[1][2] > last_three[2][2]):
        return empty_result(name, "bullish")
    if last_three[1][2] > last_three[0][2] * 0.7 or last_three[2][2] > last_three[1][2] * 0.7:
        return empty_result(name, "bullish")
    # Volume should be drying up overall (best 2-of-3).
    decreases = sum(1 for k in range(2) if last_three[k + 1][3] < last_three[k][3])
    if decreases < 1:
        return empty_result(name, "bullish")
    pivot_high = max(highs[c[0]] for c in last_three)
    pivot_low = min(lows[c[1]] for c in last_three)
    height = pivot_high - pivot_low
    entry = float(pivot_high)
    stop = float(min(lows[last_three[-1][1]], lows[last_three[-1][0]]))
    target = entry + height
    tps = [_point(df, c[0], float(highs[c[0]])) for c in last_three] + [_point(df, c[1], float(lows[c[1]])) for c in last_three]
    contraction_str = " → ".join(f"{c[2] * 100:.1f}%" for c in last_three)
    return make_extended_result(
        name,
        direction="bullish",
        indices=list(range(last_three[0][0], n)),
        strength=0.68,
        description=f"Three+ progressively tighter pullbacks ({contraction_str}) with drying volume — Minervini VCP setup; breakout above {pivot_high:.2f} initiates the move.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


# ─── NR7 / NR4 (Narrowest Range bars) ──────────────────────────────────────

def _detect_nrk(df: pd.DataFrame, k: int) -> PatternResult:
    name = f"NR{k}"
    df = ensure_df(df)
    n = len(df)
    if n < k + 2:
        return empty_result(name, "continuation")
    window = df.iloc[n - k : n]
    ranges = (window["high"] - window["low"]).to_numpy()
    if ranges.argmin() != k - 1:
        return empty_result(name, "continuation")
    curr = df.iloc[n - 1]
    direction = "bullish" if _val(curr, "close") >= _val(curr, "open") else "bearish"
    atr14 = float(atr(df, 14).iloc[-1])
    # Buy-stop above current high / sell-stop below current low; classic NR setup.
    if direction == "bullish":
        entry = float(_val(curr, "high"))
        stop = float(_val(curr, "low"))
        target = entry + 2 * atr14
    else:
        entry = float(_val(curr, "low"))
        stop = float(_val(curr, "high"))
        target = entry - 2 * atr14
    tps = [_point(df, n - 1, float(_val(curr, "high"))), _point(df, n - 1, float(_val(curr, "low")))]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=[n - 1],
        strength=0.55,
        description=f"Narrowest range of last {k} bars — extreme volatility compression; explosive move often follows in the breakout direction.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_nr7(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_nrk(df, 7)


def detect_nr4(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_nrk(df, 4)


# ─── Wide Range Bar ────────────────────────────────────────────────────────

def _detect_wrb(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Wide Range Bar" if direction == "bullish" else "Bearish Wide Range Bar"
    df = ensure_df(df)
    n = len(df)
    if n < 21:
        return empty_result(name, direction)  # type: ignore[arg-type]
    curr = df.iloc[n - 1]
    if direction == "bullish" and not is_bull(curr):
        return empty_result(name, "bullish")
    if direction == "bearish" and not is_bear(curr):
        return empty_result(name, "bearish")
    body_a = abs_body(curr)
    bodies = (df["close"] - df["open"]).abs().iloc[n - 21 : n - 1]
    avg = float(bodies.mean()) or 1e-9
    if body_a < 2 * avg:
        return empty_result(name, direction)  # type: ignore[arg-type]
    vr = volume_ratio(df, window=20, idx=n - 1)
    if vr < 1.2:
        return empty_result(name, direction)  # type: ignore[arg-type]
    if direction == "bullish":
        entry = float(_val(curr, "close"))
        stop = float(_val(curr, "low"))
        target = entry + body_a
    else:
        entry = float(_val(curr, "close"))
        stop = float(_val(curr, "high"))
        target = entry - body_a
    tps = [_point(df, n - 1, float(_val(curr, "high"))), _point(df, n - 1, float(_val(curr, "low")))]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=[n - 1],
        strength=min(1.0, 0.55 + 0.20 * min(body_a / max(avg, 1e-9), 4.0) / 4.0 + 0.10 * min(vr - 1.2, 1.8) / 1.8),
        description=f"Wide-range {direction} bar — body {body_a / max(avg, 1e-9):.1f}× avg with volume {vr:.2f}× — large institutional print.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bullish_wide_range_bar(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_wrb(df, "bullish")


def detect_bearish_wide_range_bar(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_wrb(df, "bearish")


# ─── Power of 3 (AMD: Accumulation → Manipulation → Distribution) ─────────

def _detect_power_of_3(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Power of 3" if direction == "bullish" else "Bearish Power of 3"
    df = ensure_df(df)
    n = len(df)
    if n < 24:
        return empty_result(name, direction)  # type: ignore[arg-type]
    # Slice into three equal phases (8 bars each).
    third = n // 3
    p1 = df.iloc[n - 3 * 8 : n - 2 * 8]
    p2 = df.iloc[n - 2 * 8 : n - 8]
    p3 = df.iloc[n - 8 : n]
    if len(p1) < 6 or len(p2) < 6 or len(p3) < 6:
        return empty_result(name, direction)  # type: ignore[arg-type]
    p1_range_pct = (float(p1["high"].max()) - float(p1["low"].min())) / max(float(p1["close"].mean()), 1e-9)
    if p1_range_pct > 0.025:  # accumulation should be tight
        return empty_result(name, direction)  # type: ignore[arg-type]

    p1_high = float(p1["high"].max())
    p1_low = float(p1["low"].min())

    if direction == "bullish":
        # Manipulation = sweep p1 low.
        if float(p2["low"].min()) >= p1_low:
            return empty_result(name, "bullish")
        # Distribution = strong rally above p1 high.
        if float(p3["close"].iloc[-1]) <= p1_high:
            return empty_result(name, "bullish")
        entry = float(p1_high)
        stop = float(p2["low"].min())
        target = entry + (p1_high - p2["low"].min()) * 1.5
    else:
        if float(p2["high"].max()) <= p1_high:
            return empty_result(name, "bearish")
        if float(p3["close"].iloc[-1]) >= p1_low:
            return empty_result(name, "bearish")
        entry = float(p1_low)
        stop = float(p2["high"].max())
        target = entry - (p2["high"].max() - p1_low) * 1.5
    tps = [
        _point(df, n - 3 * 8, p1_high), _point(df, n - 2 * 8 - 1, p1_high),
        _point(df, n - 3 * 8, p1_low), _point(df, n - 2 * 8 - 1, p1_low),
        _point(df, n - 2 * 8, float(p2["low"].min() if direction == "bullish" else p2["high"].max())),
        _point(df, n - 1, float(p3["close"].iloc[-1])),
    ]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=list(range(n - 3 * 8, n)),
        strength=0.62,
        description=(
            "3-phase ICT setup: accumulation range → manipulation sweep of the opposite side → distribution drive. Most reliable on session opens."
        ),
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bullish_power_of_3(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_power_of_3(df, "bullish")


def detect_bearish_power_of_3(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_power_of_3(df, "bearish")


# ─── Liquidity Sweep Reversal ──────────────────────────────────────────────

def _detect_liquidity_sweep(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Liquidity Sweep" if direction == "bullish" else "Bearish Liquidity Sweep"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, direction)  # type: ignore[arg-type]
    base = df.iloc[n - 21 : n - 1]
    curr = df.iloc[n - 1]
    if direction == "bullish":
        prev_low = float(base["low"].min())
        if _val(curr, "low") >= prev_low:
            return empty_result(name, "bullish")
        if _val(curr, "close") <= prev_low:
            return empty_result(name, "bullish")
        if not is_bull(curr):
            return empty_result(name, "bullish")
        depth = prev_low - _val(curr, "low")
        entry = float(_val(curr, "close"))
        stop = float(_val(curr, "low"))
        target = entry + depth * 4
    else:
        prev_high = float(base["high"].max())
        if _val(curr, "high") <= prev_high:
            return empty_result(name, "bearish")
        if _val(curr, "close") >= prev_high:
            return empty_result(name, "bearish")
        if not is_bear(curr):
            return empty_result(name, "bearish")
        depth = _val(curr, "high") - prev_high
        entry = float(_val(curr, "close"))
        stop = float(_val(curr, "high"))
        target = entry - depth * 4
    tps = [_point(df, n - 21, prev_low if direction == "bullish" else prev_high),
           _point(df, n - 1, prev_low if direction == "bullish" else prev_high),
           _point(df, n - 1, float(_val(curr, "low" if direction == "bullish" else "high"))),
           _point(df, n - 1, float(_val(curr, "close")))]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=[n - 21, n - 1],
        strength=0.68,
        description=f"Price swept the prior swing {'low' if direction == 'bullish' else 'high'} by {depth:.2f} and reversed — stop-hunt completion; high-RR reversal.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bullish_liquidity_sweep(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_liquidity_sweep(df, "bullish")


def detect_bearish_liquidity_sweep(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_liquidity_sweep(df, "bearish")


# ─── Fair Value Gap (3-candle imbalance) ──────────────────────────────────

def _detect_fvg(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Fair Value Gap" if direction == "bullish" else "Bearish Fair Value Gap"
    df = ensure_df(df)
    n = len(df)
    if n < 3:
        return empty_result(name, direction)  # type: ignore[arg-type]
    a = df.iloc[n - 3]
    b = df.iloc[n - 2]
    c = df.iloc[n - 1]
    if direction == "bullish":
        if not (_val(a, "high") < _val(c, "low")):
            return empty_result(name, "bullish")
        gap_lo = float(_val(a, "high"))
        gap_hi = float(_val(c, "low"))
        size = gap_hi - gap_lo
        entry = float(_val(c, "close"))
        stop = gap_lo
        target = entry + size * 3
    else:
        if not (_val(a, "low") > _val(c, "high")):
            return empty_result(name, "bearish")
        gap_hi = float(_val(a, "low"))
        gap_lo = float(_val(c, "high"))
        size = gap_hi - gap_lo
        entry = float(_val(c, "close"))
        stop = gap_hi
        target = entry - size * 3
    tps = [_point(df, n - 3, float(_val(a, "high" if direction == "bullish" else "low"))),
           _point(df, n - 1, float(_val(c, "low" if direction == "bullish" else "high"))),
           _point(df, n - 2, float(_val(b, "high"))),
           _point(df, n - 2, float(_val(b, "low")))]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=[n - 3, n - 2, n - 1],
        strength=min(1.0, 0.50 + min(size / max(candle_range(b), 1e-9), 2.0) / 4),
        description=f"Fair Value Gap — candle 1 {'high' if direction == 'bullish' else 'low'} sits {'below' if direction == 'bullish' else 'above'} candle 3 {'low' if direction == 'bullish' else 'high'} ({size:.2f} imbalance).",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bullish_fair_value_gap(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_fvg(df, "bullish")


def detect_bearish_fair_value_gap(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_fvg(df, "bearish")


# ─── Order Block ──────────────────────────────────────────────────────────

def _detect_order_block(df: pd.DataFrame, direction: str) -> PatternResult:
    """Bullish OB: last bearish candle immediately before a strong bullish
    impulse (≥ 3 consecutive bull candles or single body ≥ 2× ATR)."""
    name = "Bullish Order Block" if direction == "bullish" else "Bearish Order Block"
    df = ensure_df(df)
    n = len(df)
    if n < 6:
        return empty_result(name, direction)  # type: ignore[arg-type]
    atr14 = float(atr(df, 14).iloc[-1])
    # Walk back from the most recent bar to find the OB.
    for k in range(1, min(12, n - 1)):
        impulse_start = n - k
        impulse = df.iloc[impulse_start:n]
        if len(impulse) < 2:
            continue
        if direction == "bullish":
            if all(is_bull(impulse.iloc[m]) for m in range(len(impulse))) and (
                abs_body(impulse.iloc[0]) >= 1.5 * atr14 or len(impulse) >= 3
            ):
                ob = df.iloc[impulse_start - 1]
                if not is_bear(ob):
                    continue
                ob_hi = float(_val(ob, "high"))
                ob_lo = float(_val(ob, "low"))
                entry = ob_hi
                stop = ob_lo
                target = entry + (entry - stop) * 3
                tps = [_point(df, impulse_start - 1, ob_hi), _point(df, n - 1, ob_hi),
                       _point(df, impulse_start - 1, ob_lo), _point(df, n - 1, ob_lo)]
                return make_extended_result(
                    name,
                    direction="bullish",
                    indices=[impulse_start - 1, n - 1],
                    strength=0.62,
                    description=f"Bullish Order Block: last bear candle before {len(impulse)}-bar bull impulse — institutional bid zone.",
                    entry_price=entry,
                    target_price=target,
                    stop_price=stop,
                    trendline_points=tps,
                )
        else:
            if all(is_bear(impulse.iloc[m]) for m in range(len(impulse))) and (
                abs_body(impulse.iloc[0]) >= 1.5 * atr14 or len(impulse) >= 3
            ):
                ob = df.iloc[impulse_start - 1]
                if not is_bull(ob):
                    continue
                ob_hi = float(_val(ob, "high"))
                ob_lo = float(_val(ob, "low"))
                entry = ob_lo
                stop = ob_hi
                target = entry - (stop - entry) * 3
                tps = [_point(df, impulse_start - 1, ob_hi), _point(df, n - 1, ob_hi),
                       _point(df, impulse_start - 1, ob_lo), _point(df, n - 1, ob_lo)]
                return make_extended_result(
                    name,
                    direction="bearish",
                    indices=[impulse_start - 1, n - 1],
                    strength=0.62,
                    description=f"Bearish Order Block: last bull candle before {len(impulse)}-bar bear impulse — institutional offer zone.",
                    entry_price=entry,
                    target_price=target,
                    stop_price=stop,
                    trendline_points=tps,
                )
    return empty_result(name, direction)  # type: ignore[arg-type]


def detect_bullish_order_block(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_order_block(df, "bullish")


def detect_bearish_order_block(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_order_block(df, "bearish")


# ─── Breaker Block (failed order block that flips polarity) ───────────────

def _detect_breaker_block(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Breaker Block" if direction == "bullish" else "Bearish Breaker Block"
    df = ensure_df(df)
    n = len(df)
    if n < 15:
        return empty_result(name, direction)  # type: ignore[arg-type]
    atr14 = float(atr(df, 14).iloc[-1])
    # Bullish breaker: prior bearish OB was violated (price closed above its high),
    # price has now returned to its high zone from above — old supply flips into demand.
    if direction == "bullish":
        # Find a bearish OB candidate (single big bear within last 20 bars).
        for k in range(5, min(20, n - 2)):
            ob_idx = n - 1 - k
            ob = df.iloc[ob_idx]
            if not is_bear(ob) or abs_body(ob) < 1.5 * atr14:
                continue
            # Was its high violated AFTER ob_idx (some close above ob.high)?
            window = df.iloc[ob_idx + 1 : n]
            if not (window["close"] > _val(ob, "high")).any():
                continue
            # Is current bar revisiting the ob.high zone from above?
            curr = df.iloc[n - 1]
            tol = 0.005 * _val(ob, "high")
            if not (abs(_val(curr, "low") - _val(ob, "high")) <= tol and _val(curr, "close") > _val(ob, "high")):
                continue
            entry = float(_val(curr, "close"))
            stop = float(_val(ob, "low"))
            target = entry + (entry - stop) * 2
            tps = [_point(df, ob_idx, float(_val(ob, "high"))), _point(df, n - 1, float(_val(ob, "high"))),
                   _point(df, ob_idx, float(_val(ob, "low"))), _point(df, n - 1, float(_val(ob, "low")))]
            return make_extended_result(
                name,
                direction="bullish",
                indices=[ob_idx, n - 1],
                strength=0.58,
                description="Failed bearish order block reclaimed from above — old supply flips to demand.",
                entry_price=entry,
                target_price=target,
                stop_price=stop,
                trendline_points=tps,
            )
        return empty_result(name, "bullish")
    else:
        for k in range(5, min(20, n - 2)):
            ob_idx = n - 1 - k
            ob = df.iloc[ob_idx]
            if not is_bull(ob) or abs_body(ob) < 1.5 * atr14:
                continue
            window = df.iloc[ob_idx + 1 : n]
            if not (window["close"] < _val(ob, "low")).any():
                continue
            curr = df.iloc[n - 1]
            tol = 0.005 * _val(ob, "low")
            if not (abs(_val(curr, "high") - _val(ob, "low")) <= tol and _val(curr, "close") < _val(ob, "low")):
                continue
            entry = float(_val(curr, "close"))
            stop = float(_val(ob, "high"))
            target = entry - (stop - entry) * 2
            tps = [_point(df, ob_idx, float(_val(ob, "high"))), _point(df, n - 1, float(_val(ob, "high"))),
                   _point(df, ob_idx, float(_val(ob, "low"))), _point(df, n - 1, float(_val(ob, "low")))]
            return make_extended_result(
                name,
                direction="bearish",
                indices=[ob_idx, n - 1],
                strength=0.58,
                description="Failed bullish order block reclaimed from below — old demand flips to supply.",
                entry_price=entry,
                target_price=target,
                stop_price=stop,
                trendline_points=tps,
            )
        return empty_result(name, "bearish")


def detect_bullish_breaker_block(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_breaker_block(df, "bullish")


def detect_bearish_breaker_block(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_breaker_block(df, "bearish")


# ─── Mitigation Block (price returns to origin) ───────────────────────────

def _detect_mitigation_block(df: pd.DataFrame, direction: str) -> PatternResult:
    name = "Bullish Mitigation Block" if direction == "bullish" else "Bearish Mitigation Block"
    df = ensure_df(df)
    n = len(df)
    if n < 10:
        return empty_result(name, direction)  # type: ignore[arg-type]
    atr14 = float(atr(df, 14).iloc[-1])
    # Find the origin of a strong directional move within last 15 bars.
    for k in range(5, min(15, n - 1)):
        origin = df.iloc[n - 1 - k]
        # Origin must be a candle that started the move with body ≥ ATR.
        if abs_body(origin) < atr14:
            continue
        if direction == "bullish" and not is_bull(origin):
            continue
        if direction == "bearish" and not is_bear(origin):
            continue
        # The move advanced ≥ 2× ATR away from origin.
        move_to = df.iloc[n - 1 - k : n - 1]
        excursion = (move_to["high"].max() - _val(origin, "close")) if direction == "bullish" else (_val(origin, "close") - move_to["low"].min())
        if excursion < 2 * atr14:
            continue
        # Current bar returns into origin body (within open/close range).
        curr = df.iloc[n - 1]
        body_lo = min(_val(origin, "open"), _val(origin, "close"))
        body_hi = max(_val(origin, "open"), _val(origin, "close"))
        if direction == "bullish":
            if not (body_lo <= _val(curr, "low") <= body_hi):
                continue
            entry = float(_val(curr, "close"))
            stop = float(body_lo) - 0.2 * abs_body(origin)
            target = entry + (entry - stop) * 2.5
        else:
            if not (body_lo <= _val(curr, "high") <= body_hi):
                continue
            entry = float(_val(curr, "close"))
            stop = float(body_hi) + 0.2 * abs_body(origin)
            target = entry - (stop - entry) * 2.5
        tps = [_point(df, n - 1 - k, body_hi), _point(df, n - 1, body_hi),
               _point(df, n - 1 - k, body_lo), _point(df, n - 1, body_lo)]
        return make_extended_result(
            name,
            direction=direction,  # type: ignore[arg-type]
            indices=[n - 1 - k, n - 1],
            strength=0.60,
            description=f"Price returned to mitigate the origin candle of the prior {direction} move — institutional re-entry zone.",
            entry_price=entry,
            target_price=target,
            stop_price=stop,
            trendline_points=tps,
        )
    return empty_result(name, direction)  # type: ignore[arg-type]


def detect_bullish_mitigation_block(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_mitigation_block(df, "bullish")


def detect_bearish_mitigation_block(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_mitigation_block(df, "bearish")


# ─── Inducement ───────────────────────────────────────────────────────────

def _detect_inducement(df: pd.DataFrame, direction: str) -> PatternResult:
    """Engineered minor swing High/Low designed to trap retail; price sweeps it
    then reverses sharply. We detect: a minor swing within last 15 bars,
    swept on the most recent bar, with an immediate reversal (close opposite).
    """
    name = "Bullish Inducement" if direction == "bullish" else "Bearish Inducement"
    df = ensure_df(df)
    n = len(df)
    if n < 15:
        return empty_result(name, direction)  # type: ignore[arg-type]
    window = df.iloc[n - 15 : n - 1]
    curr = df.iloc[n - 1]
    if direction == "bullish":
        # Minor low to induce shorts.
        minor_low = float(window["low"].min())
        if _val(curr, "low") >= minor_low:
            return empty_result(name, "bullish")
        if not (is_bull(curr) and _val(curr, "close") > minor_low):
            return empty_result(name, "bullish")
        entry = float(_val(curr, "close"))
        stop = float(_val(curr, "low"))
        target = entry + (entry - stop) * 3
    else:
        minor_high = float(window["high"].max())
        if _val(curr, "high") <= minor_high:
            return empty_result(name, "bearish")
        if not (is_bear(curr) and _val(curr, "close") < minor_high):
            return empty_result(name, "bearish")
        entry = float(_val(curr, "close"))
        stop = float(_val(curr, "high"))
        target = entry - (stop - entry) * 3
    tps = [_point(df, n - 15, minor_low if direction == "bullish" else minor_high),
           _point(df, n - 1, minor_low if direction == "bullish" else minor_high),
           _point(df, n - 1, float(_val(curr, "low" if direction == "bullish" else "high"))),
           _point(df, n - 1, float(_val(curr, "close")))]
    return make_extended_result(
        name,
        direction=direction,  # type: ignore[arg-type]
        indices=[n - 15, n - 1],
        strength=0.60,
        description="Minor swing point engineered to trap retail; the sweep + reverse reveals genuine flow.",
        entry_price=entry,
        target_price=target,
        stop_price=stop,
        trendline_points=tps,
    )


def detect_bullish_inducement(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_inducement(df, "bullish")


def detect_bearish_inducement(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_inducement(df, "bearish")


# ─── Optimal Trade Entry (OTE) ────────────────────────────────────────────

def _detect_ote(df: pd.DataFrame, direction: str) -> PatternResult:
    """OTE: pullback into 62–79% Fibonacci of the last impulse, ideally with
    an Order Block in the same zone for confluence."""
    name = "Bullish OTE" if direction == "bullish" else "Bearish OTE"
    df = ensure_df(df)
    n = len(df)
    if n < 25:
        return empty_result(name, direction)  # type: ignore[arg-type]
    # Identify last impulse swing — use last 20-bar range.
    window = df.iloc[n - 20 : n]
    if direction == "bullish":
        swing_low = float(window["low"].min())
        swing_low_idx = int(window["low"].idxmin())
        # swing high *after* swing low
        after_low = df.iloc[swing_low_idx + 1 : n] if swing_low_idx + 1 < n else pd.DataFrame()
        if after_low.empty:
            return empty_result(name, "bullish")
        swing_high = float(after_low["high"].max())
        swing_high_idx = int(after_low["high"].idxmax())
        impulse = swing_high - swing_low
        if impulse <= 0:
            return empty_result(name, "bullish")
        fib_62 = swing_high - 0.62 * impulse
        fib_79 = swing_high - 0.79 * impulse
        # Current bar's low touches the OTE zone and close inside or above it.
        curr = df.iloc[n - 1]
        if not (fib_79 <= _val(curr, "low") <= fib_62):
            return empty_result(name, "bullish")
        if _val(curr, "close") < fib_79:
            return empty_result(name, "bullish")
        entry = float(_val(curr, "close"))
        stop = float(swing_low)
        target = float(swing_high + impulse * 0.272)  # 1.272 extension
        tps = [_point(df, swing_low_idx, swing_low), _point(df, swing_high_idx, swing_high),
               _point(df, n - 1, fib_62), _point(df, n - 1, fib_79)]
        return make_extended_result(
            name,
            direction="bullish",
            indices=[swing_low_idx, swing_high_idx, n - 1],
            strength=0.66,
            description=f"Pullback into the 62–79% Fib retrace ({fib_79:.2f}–{fib_62:.2f}) of the recent impulse — Optimal Trade Entry zone.",
            entry_price=entry,
            target_price=target,
            stop_price=stop,
            trendline_points=tps,
        )
    else:
        swing_high = float(window["high"].max())
        swing_high_idx = int(window["high"].idxmax())
        after_high = df.iloc[swing_high_idx + 1 : n] if swing_high_idx + 1 < n else pd.DataFrame()
        if after_high.empty:
            return empty_result(name, "bearish")
        swing_low = float(after_high["low"].min())
        swing_low_idx = int(after_high["low"].idxmin())
        impulse = swing_high - swing_low
        if impulse <= 0:
            return empty_result(name, "bearish")
        fib_62 = swing_low + 0.62 * impulse
        fib_79 = swing_low + 0.79 * impulse
        curr = df.iloc[n - 1]
        if not (fib_62 <= _val(curr, "high") <= fib_79):
            return empty_result(name, "bearish")
        if _val(curr, "close") > fib_79:
            return empty_result(name, "bearish")
        entry = float(_val(curr, "close"))
        stop = float(swing_high)
        target = float(swing_low - impulse * 0.272)
        tps = [_point(df, swing_high_idx, swing_high), _point(df, swing_low_idx, swing_low),
               _point(df, n - 1, fib_62), _point(df, n - 1, fib_79)]
        return make_extended_result(
            name,
            direction="bearish",
            indices=[swing_high_idx, swing_low_idx, n - 1],
            strength=0.66,
            description=f"Rally into the 62–79% Fib retrace ({fib_62:.2f}–{fib_79:.2f}) of the recent decline — Optimal Trade Entry zone.",
            entry_price=entry,
            target_price=target,
            stop_price=stop,
            trendline_points=tps,
        )


def detect_bullish_ote(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_ote(df, "bullish")


def detect_bearish_ote(df: pd.DataFrame, *, idx: Optional[int] = None) -> PatternResult:
    return _detect_ote(df, "bearish")


INSTITUTIONAL_DETECTORS = [
    detect_inside_bar,
    detect_outside_bar,
    detect_bullish_pin_bar,
    detect_bearish_pin_bar,
    detect_bullish_fakey,
    detect_bearish_fakey,
    detect_wyckoff_spring,
    detect_wyckoff_upthrust,
    detect_bullish_consolidation_breakout,
    detect_bearish_consolidation_breakout,
    detect_volatility_contraction_pattern,
    detect_nr7,
    detect_nr4,
    detect_bullish_wide_range_bar,
    detect_bearish_wide_range_bar,
    detect_bullish_power_of_3,
    detect_bearish_power_of_3,
    detect_bullish_liquidity_sweep,
    detect_bearish_liquidity_sweep,
    detect_bullish_fair_value_gap,
    detect_bearish_fair_value_gap,
    detect_bullish_order_block,
    detect_bearish_order_block,
    detect_bullish_breaker_block,
    detect_bearish_breaker_block,
    detect_bullish_mitigation_block,
    detect_bearish_mitigation_block,
    detect_bullish_inducement,
    detect_bearish_inducement,
    detect_bullish_ote,
    detect_bearish_ote,
]
