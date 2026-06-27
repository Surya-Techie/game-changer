"""Stan Weinstein's 4-stage trend model — the master filter.

Stages (from "Secrets for Profiting in Bull and Bear Markets"):
    1 Basing      — price flat after decline, 30W MA flattening, vol drying
    2 Advancing   — price ABOVE rising 30W MA, higher highs + lows (BUY ZONE)
    3 Distribution — choppy near highs, MA flattening, distribution volume
    4 Declining   — price BELOW declining 30W MA (avoid / short only)

The single most important question this engine answers:
    "Is this stock in Stage 2 right now?"

Anything outside Stage 2 has its confidence capped at 0.40 by every
upstream caller. This stops the system from emitting BUY signals during
distribution or downtrends regardless of how strong the local pattern is.

INPUT: weekly OHLCV dataframe with columns: open, high, low, close, volume.
       Minimum 52 weeks of history.
OUTPUT: dict (see detect_stage docstring).
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

# risk_config lives at ai-service/risk_config.py. ai-service is on the
# uvicorn sys.path at runtime, so an absolute import works from inside
# this package as well.
from risk_config import RISK_CONFIG, apply_risk_caps


# ─── 30-week MA + slope + price-position helpers ────────────────────────────

def _ma30_and_slope(close: pd.Series) -> tuple[float, float, pd.Series]:
    """Return (current MA30, %/week slope over last 8 weeks, full MA series).

    yfinance often returns NaN on the most recent weekly row (the in-
    progress week). We use the last VALID (non-NaN) MA value so this
    stays stable regardless of the data source's edge-case behaviour.
    """
    ma30 = close.rolling(30, min_periods=30).mean()
    ma30_valid = ma30.dropna()
    if ma30_valid.empty:
        return float("nan"), 0.0, ma30
    cur = float(ma30_valid.iloc[-1])
    lookback = min(8, len(ma30_valid) - 1)
    if lookback < 2:
        return cur, 0.0, ma30
    prior = float(ma30_valid.iloc[-1 - lookback])
    if prior <= 0:
        return cur, 0.0, ma30
    slope_pct_per_week = (cur - prior) / prior / lookback * 100.0
    return cur, slope_pct_per_week, ma30


def _classify_stage(
    price: float,
    ma30: float,
    ma30_slope_pct: float,
) -> int:
    """4-stage classification from the price ↔ MA30 relationship.

    Slope thresholds in %/week:
        > +0.15 = rising
        < -0.15 = falling
        in-between = flat
    """
    if pd.isna(ma30):
        return 1                              # not enough history → call it basing
    above = price > ma30
    rising = ma30_slope_pct > 0.15
    falling = ma30_slope_pct < -0.15
    if above and rising:
        return 2                              # Stage 2 — advancing
    if not above and falling:
        return 4                              # Stage 4 — declining
    if above and not rising:                  # above but flat/turning
        return 3                              # Stage 3 — distribution
    return 1                                  # Stage 1 — basing


def _stage_duration_weeks(
    close: pd.Series, ma30: pd.Series, current_stage: int,
) -> int:
    """Walk backward from the latest bar counting consecutive weeks in
    the same stage (uses a 4-week slope window for the back-walk).
    """
    n = min(len(close), len(ma30))
    duration = 0
    for i in range(n - 1, 0, -1):
        if pd.isna(ma30.iloc[i]):
            break
        slope_window = 4 if i >= 4 else i
        prior = ma30.iloc[i - slope_window]
        if prior is None or pd.isna(prior) or prior <= 0:
            break
        slope = (ma30.iloc[i] - prior) / prior / slope_window * 100.0
        s = _classify_stage(float(close.iloc[i]), float(ma30.iloc[i]), float(slope))
        if s != current_stage:
            break
        duration += 1
    return duration


def _base_duration_before_breakout(close: pd.Series, ma30: pd.Series) -> int:
    """Count Stage-1 weeks immediately before the current Stage-2 period."""
    n = min(len(close), len(ma30))
    in_stage1 = False
    duration = 0
    for i in range(n - 1, 0, -1):
        if pd.isna(ma30.iloc[i]):
            break
        slope_window = 4 if i >= 4 else i
        prior = ma30.iloc[i - slope_window]
        if pd.isna(prior) or prior <= 0:
            break
        slope = (ma30.iloc[i] - prior) / prior / slope_window * 100.0
        s = _classify_stage(float(close.iloc[i]), float(ma30.iloc[i]), float(slope))
        if s == 2 and not in_stage1:
            continue                          # still in current Stage 2 — keep scanning back
        if s == 1:
            in_stage1 = True
            duration += 1
        else:
            if in_stage1:
                break
    return duration


def _volume_trend(volume: pd.Series, lookback: int = 8) -> str:
    """'expanding' if recent 4-week avg > earlier 4-week avg, else 'contracting'."""
    if len(volume) < lookback:
        return "contracting"
    recent = float(volume.tail(lookback // 2).mean())
    earlier = float(volume.iloc[-lookback:-lookback // 2].mean())
    if earlier <= 0:
        return "contracting"
    return "expanding" if recent > earlier else "contracting"


def _relative_strength_positive(
    close: pd.Series, benchmark: Optional[pd.Series], lookback: int = 26,
) -> bool:
    """Stock return > benchmark return over the last `lookback` weeks.

    Benchmark is optional. When not supplied (typical for single-symbol
    requests), we use the stock's own trailing trend as a rough proxy:
    positive RS = stock up over the period.
    """
    if len(close) < lookback + 1:
        return False
    stock_ret = float(close.iloc[-1] / close.iloc[-lookback - 1] - 1)
    if benchmark is None or len(benchmark) < lookback + 1:
        return stock_ret > 0
    bench_ret = float(benchmark.iloc[-1] / benchmark.iloc[-lookback - 1] - 1)
    return stock_ret > bench_ret


# ─── public API ─────────────────────────────────────────────────────────────

def detect_stage(
    df_weekly: pd.DataFrame,
    *,
    benchmark_weekly: Optional[pd.Series] = None,
) -> dict:
    """Classify the current Stage and emit a tradeable verdict.

    df_weekly: weekly OHLCV with columns open, high, low, close, volume.
               Index ignored (numerical positions used). Minimum 30 weeks
               for the MA to be defined; results stabilise around 52+.
    benchmark_weekly: optional weekly close series for a market index
               (Nifty 50 in NSE context). Used for relative-strength check.
    """
    try:
        if df_weekly is None or len(df_weekly) < 30:
            return _empty_stage_result(reason="insufficient_weekly_history")

        # Tolerate Capitalized columns from upstream OHLCV fetchers.
        cols = {c.lower(): c for c in df_weekly.columns}
        close_col = cols.get("close")
        vol_col = cols.get("volume")
        if close_col is None:
            return _empty_stage_result(reason="missing_close_column")

        close = df_weekly[close_col].astype(float)
        volume = df_weekly[vol_col].astype(float) if vol_col else pd.Series([1.0] * len(close))
        # Use the last NON-NaN close so we don't get tripped up by in-progress
        # weekly bars from yfinance.
        close_valid = close.dropna()
        if close_valid.empty:
            return _empty_stage_result(reason="all_close_nan")
        price = float(close_valid.iloc[-1])

        ma30_now, ma30_slope_pct, ma30_series = _ma30_and_slope(close)
        current_stage = _classify_stage(price, ma30_now, ma30_slope_pct)
        stage_duration = _stage_duration_weeks(close, ma30_series, current_stage)

        # Stage-2 breakout detection: just crossed from Stage 1 → 2 (within
        # the last 4 weeks) AND on volume > 2× the prior 10-week average.
        stage_2_breakout = False
        stage_2_breakout_weeks_ago = -1
        base_duration_weeks = 0
        breakout_volume_ratio = 1.0

        if current_stage == 2:
            base_duration_weeks = _base_duration_before_breakout(close, ma30_series)
            # Look at the last 4 weeks for the crossover.
            for back in range(0, min(4, len(close) - 1)):
                if pd.isna(ma30_series.iloc[-(back + 2)]):
                    continue
                prior_price = float(close.iloc[-(back + 2)])
                prior_ma = float(ma30_series.iloc[-(back + 2)])
                if prior_price <= prior_ma:
                    stage_2_breakout = True
                    stage_2_breakout_weeks_ago = back
                    # Volume ratio at breakout.
                    if len(volume) >= 11 + back:
                        recent_vol = float(volume.iloc[-(back + 1)])
                        avg_vol = float(volume.iloc[-(back + 11):-(back + 1)].mean())
                        if avg_vol > 0:
                            breakout_volume_ratio = recent_vol / avg_vol
                    break

        vol_trend = _volume_trend(volume)
        rs_positive = _relative_strength_positive(close, benchmark_weekly)
        price_vs_ma30_pct = ((price - ma30_now) / ma30_now * 100.0) if ma30_now > 0 else 0.0

        # ── Confidence scoring per spec ────────────────────────────────
        if current_stage == 2:
            confidence = 0.40
            if stage_2_breakout:
                confidence += 0.20
            if base_duration_weeks >= 12:
                confidence += 0.10
            if breakout_volume_ratio > 3.0:
                confidence += 0.10
            if ma30_slope_pct > 0.5:
                confidence += 0.10
            if rs_positive:
                confidence += 0.10
        else:
            confidence = min(0.30, 0.10 + (0.05 if stage_duration > 4 else 0.0))
        confidence = max(0.0, min(1.0, confidence))

        # ── Risk envelope (Stage 2 only) ───────────────────────────────
        entry_price = stop_price = target_price = float("nan")
        rr = float("nan")
        if current_stage == 2:
            entry = price
            raw_stop = ma30_now * 0.98 if ma30_now > 0 else entry * 0.96
            raw_target = entry * 1.10
            capped = apply_risk_caps(entry, raw_stop, raw_target, direction="bullish")
            if capped is not None:
                entry_price, stop_price, target_price, rr = capped

        stage_label = {
            1: "Stage 1 — Basing (accumulation)",
            2: "Stage 2 — Advancing (BUY ZONE)",
            3: "Stage 3 — Distribution (take profits)",
            4: "Stage 4 — Declining (short or stay out)",
        }[current_stage]

        warning = None
        if current_stage == 3:
            warning = "Stage 3 rollover risk — distribution underway"
        elif current_stage == 4:
            warning = "Stage 4 downtrend — do not buy"
        elif current_stage == 1 and stage_duration < 8:
            warning = "Stage 1 too young — wait for base to mature (≥8 weeks)"

        return {
            "detected": True,
            "pattern_name": "Stage Analysis (Weinstein)",
            "current_stage": current_stage,
            "stage_label": stage_label,
            "stage_duration_weeks": int(stage_duration),
            "stage_2_breakout": bool(stage_2_breakout),
            "stage_2_breakout_weeks_ago": int(stage_2_breakout_weeks_ago)
                                          if stage_2_breakout else -1,
            "ma30_price": round(float(ma30_now), 4) if not pd.isna(ma30_now) else None,
            "ma30_slope": round(float(ma30_slope_pct), 4),
            "price_vs_ma30_pct": round(float(price_vs_ma30_pct), 3),
            "relative_strength_positive": bool(rs_positive),
            "volume_trend": vol_trend,
            "base_duration_weeks": int(base_duration_weeks),
            "breakout_volume_ratio": round(float(breakout_volume_ratio), 3),
            "tradeable": current_stage == 2,
            "entry_price": round(float(entry_price), 2) if not pd.isna(entry_price) else None,
            "stop_price": round(float(stop_price), 2) if not pd.isna(stop_price) else None,
            "target_price": round(float(target_price), 2) if not pd.isna(target_price) else None,
            "reward_risk": round(float(rr), 3) if not pd.isna(rr) else None,
            "confidence": round(confidence, 3),
            "warning": warning,
            "direction": "bullish" if current_stage == 2 else "bearish",
        }
    except Exception as exc:                  # noqa: BLE001
        return _empty_stage_result(reason=f"error:{type(exc).__name__}")


def _empty_stage_result(reason: str) -> dict:
    return {
        "detected": False,
        "pattern_name": "Stage Analysis (Weinstein)",
        "current_stage": 0,
        "stage_label": "unknown",
        "stage_duration_weeks": 0,
        "stage_2_breakout": False,
        "stage_2_breakout_weeks_ago": -1,
        "ma30_price": None,
        "ma30_slope": 0.0,
        "price_vs_ma30_pct": 0.0,
        "relative_strength_positive": False,
        "volume_trend": "contracting",
        "base_duration_weeks": 0,
        "breakout_volume_ratio": 1.0,
        "tradeable": False,
        "entry_price": None,
        "stop_price": None,
        "target_price": None,
        "reward_risk": None,
        "confidence": 0.0,
        "warning": reason,
        "direction": "neutral",
    }
