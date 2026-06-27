"""FastAPI router for the pattern backtester (Phase 7).

Exposes:
  • POST /backtest/patterns — main entry point, per spec.
  • GET  /patterns/names    — list of every detector name the library
                              supports, so the frontend multi-select can
                              be populated without hard-coding.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from pattern_backtest import (
    PatternBacktestRequest,
    list_all_pattern_names,
    run_pattern_backtest,
)
from patterns._helpers import ensure_df


router = APIRouter(tags=["patterns-backtest"])


# ─── Pydantic ──────────────────────────────────────────────────────────────

Timeframe = Literal["M5", "M15", "H1", "D1"]


class BacktestPatternsRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=20)
    start_date: str = Field(..., description="YYYY-MM-DD")
    end_date: str = Field(..., description="YYYY-MM-DD")
    pattern_names: List[str] = Field(default_factory=list, description="[] means all patterns")
    timeframe: Timeframe = "D1"
    capital: float = Field(100_000.0, gt=0)
    risk_per_trade_pct: float = Field(1.0, gt=0, le=10)
    min_confidence: int = Field(60, ge=0, le=100)
    lookback: int = Field(100, ge=20, le=300)
    max_hold_bars: int = Field(30, ge=1, le=300)
    slippage_bps: float = Field(2.0, ge=0, le=100)
    brokerage_pct: float = Field(0.0, ge=0, le=1)


class PatternNamesResponse(BaseModel):
    count: int
    names: List[str]


# ─── yfinance helper ───────────────────────────────────────────────────────

_TF_INTERVAL = {"D1": "1d", "H1": "1h", "M15": "15m", "M5": "5m"}


def _fetch_ohlcv_range(symbol: str, timeframe: str, start_date: str, end_date: str) -> Optional[pd.DataFrame]:
    """Fetch by (start, end) — yfinance respects both for the daily interval
    and for intraday so long as the range stays within its intraday cap
    (60 days for 5m / 15m / 1h)."""
    try:
        import yfinance as yf  # type: ignore
    except Exception:
        return None
    sym = symbol.upper()
    if not (sym.endswith(".NS") or sym.endswith(".BO")):
        sym = sym + ".NS"
    interval = _TF_INTERVAL.get(timeframe)
    if interval is None:
        return None
    try:
        hist = yf.Ticker(sym).history(start=start_date, end=end_date, interval=interval, auto_adjust=False)
    except Exception:
        return None
    if hist is None or hist.empty:
        return None
    df = hist.rename(columns={
        "Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume",
    })[["open", "high", "low", "close", "volume"]].copy()
    idx = df.index
    if idx.tz is not None:
        idx = idx.tz_convert('UTC').tz_localize(None)
    df["time"] = idx.astype('datetime64[ms]').astype('int64')
    return ensure_df(df.reset_index(drop=True))


# ─── Endpoints ────────────────────────────────────────────────────────────

@router.get("/patterns/names", response_model=PatternNamesResponse)
def patterns_names() -> PatternNamesResponse:
    names = list_all_pattern_names()
    return PatternNamesResponse(count=len(names), names=names)


@router.post("/backtest/patterns")
def backtest_patterns(req: BacktestPatternsRequest) -> dict:
    # Date sanity.
    try:
        sd = datetime.strptime(req.start_date, "%Y-%m-%d").date()
        ed = datetime.strptime(req.end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="start_date / end_date must be YYYY-MM-DD")
    if sd >= ed:
        raise HTTPException(status_code=400, detail="start_date must be before end_date")

    df = _fetch_ohlcv_range(req.symbol, req.timeframe, req.start_date, req.end_date)
    if df is None or len(df) < 60:
        raise HTTPException(status_code=404, detail=f"insufficient OHLCV for {req.symbol} {req.timeframe} between {req.start_date}/{req.end_date}")

    # Periods/year for Sharpe — daily=252, M5≈252*75, etc.
    ppy_map = {"D1": 252, "H1": 252 * 7, "M15": 252 * 25, "M5": 252 * 75}

    bt_req = PatternBacktestRequest(
        symbol=req.symbol.upper(),
        capital=req.capital,
        risk_per_trade_pct=req.risk_per_trade_pct,
        min_confidence=req.min_confidence,
        timeframe=req.timeframe,
        pattern_names=req.pattern_names or None,
        lookback=req.lookback,
        max_hold_bars=req.max_hold_bars,
        slippage_bps=req.slippage_bps,
        brokerage_pct=req.brokerage_pct,
        periods_per_year=ppy_map.get(req.timeframe, 252),
    )
    return run_pattern_backtest(df, bt_req)
