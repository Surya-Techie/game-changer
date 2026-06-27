"""Rule-based pattern engine — orchestrates every detector in the library.

This module is the single entry point upstream code (FastAPI router,
backend service, backtester) uses to get the full list of currently-active
patterns for an OHLCV window. It applies the spec's three quality filters
(trend / volume / ATR) and, when the caller passes a higher-timeframe
DataFrame, the multi-timeframe agreement filter.

The actual pattern logic lives in `pattern_definitions.py` — this module
is intentionally thin so the detector library can grow without touching
the orchestrator.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, List, Optional

import pandas as pd

from ._helpers import (
    adx,
    atr,
    avg_body,
    candle_range,
    ema,
    ensure_df,
    trend_classify,
    volume_ratio,
    _val,
)
from .pattern_definitions import (
    ALL_DETECTORS,
    CATEGORY_BY_DETECTOR,
    PatternResult,
    run_detector_safely,
)


# ─── Config ────────────────────────────────────────────────────────────────

@dataclass
class RuleEngineConfig:
    lookback: int = 100
    # Volume filter: latest bar volume must be ≥ this multiple of 20-bar avg.
    volume_min_ratio: float = 1.2
    # Volume filter is skipped when no volume data is present.
    skip_volume_if_zero: bool = True
    # ATR filter: current candle range must be > atr_min_mult × ATR(14).
    atr_min_mult: float = 0.3
    # Trend filter: ADX < adx_min_for_trend ⇒ trend label = sideways.
    adx_min_for_trend: float = 18.0
    # MTF: if a higher-tf DataFrame is provided, require its trend to match
    # the pattern direction (or be sideways) for the pattern to keep its
    # full strength. Otherwise we down-weight to 0.6×.
    mtf_disagree_penalty: float = 0.6
    # Categories the caller can opt out of (UI multi-select).
    enabled_categories: Optional[frozenset[str]] = None


@dataclass
class EnrichedPatternResult:
    """The PatternResult dict plus the filter metadata the engine attached.
    Returned as a plain dict for API serialization, but constructed via this
    dataclass internally to keep the keys disciplined."""

    result: PatternResult
    category: str
    passes_volume: bool
    passes_atr: bool
    passes_trend: bool
    passes_mtf: bool
    trend: str
    volume_ratio: float
    atr_value: float

    def to_dict(self) -> dict:
        out = dict(self.result)
        out["category"] = self.category
        out["filters"] = {
            "volume": self.passes_volume,
            "atr": self.passes_atr,
            "trend": self.passes_trend,
            "mtf": self.passes_mtf,
            "trend_label": self.trend,
            "volume_ratio": round(self.volume_ratio, 3),
            "atr_value": round(self.atr_value, 4),
        }
        return out


# ─── Internal helpers ──────────────────────────────────────────────────────

def _normalize_window(df: pd.DataFrame, lookback: int) -> pd.DataFrame:
    """Crop to the most recent `lookback` bars and re-index. We always pass a
    DataFrame indexed by integer position so detectors don't have to think
    about timestamp indices."""
    df = ensure_df(df)
    if len(df) > lookback:
        df = df.iloc[-lookback:].reset_index(drop=True)
    return df


def _trend_compatible(direction: str, trend: str) -> bool:
    """Continuation/neutral are always trend-compatible. Bull patterns prefer
    uptrend or sideways; bear patterns prefer downtrend or sideways."""
    if direction in ("continuation", "neutral"):
        return True
    if trend == "sideways":
        return True
    if direction == "bullish":
        return trend == "uptrend"
    if direction == "bearish":
        return trend == "downtrend"
    return True


# ─── Public API ────────────────────────────────────────────────────────────

def run_all_patterns(
    df: pd.DataFrame,
    *,
    config: Optional[RuleEngineConfig] = None,
    higher_tf_df: Optional[pd.DataFrame] = None,
) -> List[dict]:
    """Run every registered detector against `df` and return the enriched
    detections that passed at least one filter band.

    Parameters
    ----------
    df             : OHLCV DataFrame (or list[dict]) — latest bar last.
    config         : Optional override of RuleEngineConfig.
    higher_tf_df   : Optional higher-timeframe OHLCV used for MTF agreement.
                     If passed, the pattern direction must match the higher
                     timeframe's trend or it's flagged `passes_mtf = False`
                     (but the pattern is still returned — the caller may
                     choose to filter on this).

    Returns
    -------
    list[dict] — each dict is a `PatternResult` augmented with `category`
    and a `filters` sub-dict reporting which gates passed. Detections that
    failed *no* gates and were not even detected are dropped — callers see
    only meaningful rows. Sorted by `strength` descending.
    """
    cfg = config or RuleEngineConfig()
    work = _normalize_window(df, cfg.lookback)
    n = len(work)
    if n < 5:
        return []

    # ─── Context computed once per call ──────────────────────────────────
    trend = trend_classify(work)
    has_volume = "volume" in work.columns and float(work["volume"].abs().sum()) > 0
    vr = volume_ratio(work, window=20, idx=n - 1) if has_volume else 1.0
    atr_series = atr(work, 14)
    atr_now = float(atr_series.iloc[-1])
    last_range = candle_range(work.iloc[-1])
    adx_now = float(adx(work, 14).iloc[-1])

    higher_trend: Optional[str] = None
    if higher_tf_df is not None:
        higher_work = ensure_df(higher_tf_df)
        if len(higher_work) >= 50:
            higher_trend = trend_classify(higher_work)

    enabled = cfg.enabled_categories  # may be None → all categories

    enriched: List[EnrichedPatternResult] = []
    for det in ALL_DETECTORS:
        category = CATEGORY_BY_DETECTOR.get(det.__name__, "unknown")
        if enabled is not None and category not in enabled:
            continue

        res = run_detector_safely(det, work)
        if not res.get("detected"):
            continue

        direction = res.get("direction", "neutral")
        # Volume filter: skip when no volume data and config allows.
        passes_volume = True
        if has_volume:
            passes_volume = vr >= cfg.volume_min_ratio
        elif not cfg.skip_volume_if_zero:
            passes_volume = False

        # ATR filter: last bar must have meaningful range.
        passes_atr = last_range > cfg.atr_min_mult * max(atr_now, 1e-9)

        # Trend filter: not a hard veto — we report it; the confidence
        # engine downstream will reward agreement and penalize fight.
        passes_trend = _trend_compatible(direction, trend) if adx_now >= cfg.adx_min_for_trend else True

        # Multi-timeframe filter.
        passes_mtf = True
        if higher_trend is not None and direction in ("bullish", "bearish"):
            if higher_trend == "sideways":
                passes_mtf = True
            else:
                passes_mtf = _trend_compatible(direction, higher_trend)

        # Trim the pattern's strength when fighting higher timeframe.
        if not passes_mtf:
            res = dict(res)
            res["strength"] = float(max(0.0, res.get("strength", 0.0) * cfg.mtf_disagree_penalty))

        enriched.append(
            EnrichedPatternResult(
                result=res,
                category=category,
                passes_volume=passes_volume,
                passes_atr=passes_atr,
                passes_trend=passes_trend,
                passes_mtf=passes_mtf,
                trend=trend,
                volume_ratio=vr,
                atr_value=atr_now,
            )
        )

    enriched.sort(key=lambda e: float(e.result.get("strength", 0.0)), reverse=True)
    return [e.to_dict() for e in enriched]


def context_snapshot(df: pd.DataFrame) -> dict:
    """Lightweight context summary that callers (e.g. the explainer) can
    consume without re-deriving indicators. Pure read; safe to call often."""
    work = ensure_df(df)
    n = len(work)
    if n < 5:
        return {"ok": False, "reason": "insufficient bars"}
    atr_now = float(atr(work, 14).iloc[-1])
    adx_now = float(adx(work, 14).iloc[-1])
    last = float(work["close"].iloc[-1])
    ema20 = float(ema(work["close"], 20).iloc[-1])
    ema50 = float(ema(work["close"], 50).iloc[-1])
    return {
        "ok": True,
        "last": round(last, 4),
        "trend": trend_classify(work),
        "adx14": round(adx_now, 2),
        "atr14": round(atr_now, 4),
        "atr_pct": round(atr_now / max(last, 1e-9) * 100, 3),
        "ema20": round(ema20, 4),
        "ema50": round(ema50, 4),
        "volume_ratio_20": round(volume_ratio(work, window=20, idx=n - 1), 3),
    }
