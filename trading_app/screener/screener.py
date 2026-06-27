"""
Pre-market screener — run daily ~8:45 AM IST.
Picks top-5 candidates ranked by composite score.

Criteria:
    pre-market gap %        (2-10 %)
    yesterday volume        > 2× 20-day average
    ATR %                   > 3 %
    price range             ₹100 – ₹3000
    relative strength       vs Nifty50
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List

import numpy as np
import pandas as pd

from .. import config
from ..data.fetcher import fetch
from ..indicators.custom_indicators import atr

log = logging.getLogger(__name__)


@dataclass
class ScreenResult:
    symbol:        str
    last_close:    float
    gap_pct:       float
    vol_ratio:     float
    atr_pct:       float
    rel_strength:  float
    sr_high:       float
    sr_low:        float
    recommended:   str           # ORB / GapGo / Breakout
    confidence:    float         # 0-10


# ── scoring helpers ────────────────────────────────────────────
def _score(r: ScreenResult) -> float:
    score = 0.0
    # gap component (sweet spot 3-7%)
    if 0.03 <= abs(r.gap_pct) <= 0.07:
        score += 3.0
    elif 0.02 <= abs(r.gap_pct) <= 0.10:
        score += 1.5
    # vol component
    if r.vol_ratio > 3.0:
        score += 2.5
    elif r.vol_ratio > 2.0:
        score += 1.5
    # ATR component
    if r.atr_pct > 0.05:
        score += 2.0
    elif r.atr_pct > 0.03:
        score += 1.0
    # rel strength
    if abs(r.rel_strength) > 0.02:
        score += 1.5
    elif abs(r.rel_strength) > 0.01:
        score += 0.5
    # price in tradeable band
    if 100 <= r.last_close <= 3000:
        score += 1.0
    return min(score, 10.0)


def _recommend(r: ScreenResult) -> str:
    if abs(r.gap_pct) >= 0.03:
        return "GapAndGo"
    if r.atr_pct > 0.04 and r.vol_ratio > 2.0:
        return "OpeningRangeBreakout"
    return "VolumeBreakout"


# ── screen one symbol ──────────────────────────────────────────
def screen_symbol(symbol: str, benchmark_ret: float | None = None
                  ) -> ScreenResult | None:
    df = fetch(symbol, interval="1d", days=60)
    if df.empty or len(df) < 25:
        return None
    last_close = float(df["close"].iloc[-1])
    prev_close = float(df["close"].iloc[-2])
    gap_pct    = (last_close - prev_close) / prev_close

    vol_ratio  = float(df["volume"].iloc[-1] /
                       df["volume"].iloc[-21:-1].mean())
    a          = float(atr(df, 14).iloc[-1])
    atr_pct    = a / last_close

    # relative strength: stock 20-day return vs nifty
    stk_ret    = (last_close / df["close"].iloc[-21]) - 1
    rel_str    = stk_ret - (benchmark_ret or 0.0)

    sr_high    = float(df["high"].iloc[-20:].max())
    sr_low     = float(df["low"].iloc[-20:].min())

    res = ScreenResult(
        symbol       = symbol,
        last_close   = last_close,
        gap_pct      = gap_pct,
        vol_ratio    = vol_ratio,
        atr_pct      = atr_pct,
        rel_strength = rel_str,
        sr_high      = sr_high,
        sr_low       = sr_low,
        recommended  = "",
        confidence   = 0.0,
    )
    res.recommended = _recommend(res)
    res.confidence  = _score(res)
    return res


# ── top-N over a universe ──────────────────────────────────────
def top_picks(
    universe: List[str] | None = None,
    n: int = 5,
    benchmark: str = None,
) -> pd.DataFrame:
    universe  = universe  or config.NSE_STOCKS
    benchmark = benchmark or config.BENCHMARK

    bench_df  = fetch(benchmark, interval="1d", days=30)
    bench_ret = (
        (bench_df["close"].iloc[-1] / bench_df["close"].iloc[-21]) - 1
        if len(bench_df) > 21 else 0.0
    )

    rows = []
    for sym in universe:
        try:
            r = screen_symbol(sym, benchmark_ret=float(bench_ret))
        except Exception as e:                              # pragma: no cover
            log.warning("screen failed %s: %s", sym, e)
            continue
        if r is not None:
            rows.append(r)

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame([r.__dict__ for r in rows])
    df = df.sort_values("confidence", ascending=False).head(n).reset_index(drop=True)
    return df


# ── CLI ────────────────────────────────────────────────────────
if __name__ == "__main__":                                  # pragma: no cover
    logging.basicConfig(level=logging.INFO)
    print(top_picks(n=5).to_string(index=False))
