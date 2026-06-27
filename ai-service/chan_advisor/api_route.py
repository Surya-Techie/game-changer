"""FastAPI route for the Chan Advisor."""

from __future__ import annotations

from dataclasses import asdict
from typing import Optional

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .advisor import recommend
from .strategies import STRATEGIES

router = APIRouter(prefix="/chan-advisor", tags=["Chan Advisor"])


class AdvisorRequest(BaseModel):
    symbol: str
    lookback_days: int = 252
    vix: Optional[float] = None


@router.post("/recommend")
async def recommend_route(req: AdvisorRequest):
    try:
        import yfinance as yf
    except ImportError:
        raise HTTPException(status_code=500, detail="yfinance unavailable")

    ticker = req.symbol if req.symbol.endswith((".NS", ".BO")) else f"{req.symbol}.NS"
    raw = yf.download(ticker, period=f"{req.lookback_days}d",
                      progress=False, auto_adjust=False)
    if raw is None or raw.empty:
        raise HTTPException(status_code=404, detail=f"No data for {req.symbol}")
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = [c[0] for c in raw.columns]
    df = raw.rename(columns={c: c.lower() for c in raw.columns})
    df = df[["open", "high", "low", "close", "volume"]].dropna().reset_index()

    rec = recommend(df, req.symbol, vix=req.vix)
    return {
        "symbol": rec.symbol,
        "regime": rec.regime,
        "primary": asdict(rec.primary),
        "alternates": [asdict(a) for a in rec.alternates],
        "sharpe_60d": rec.sharpe_60d,
        "kelly_half": rec.kelly_half,
        "years_for_significance": rec.years_for_sig,
        "emotional_check": rec.emotional_check,
        "response_5section": rec.response_5section,
    }


@router.get("/strategies")
async def list_strategies():
    """All 22 strategies with metadata, for frontend strategy explorers."""
    return {
        "count": len(STRATEGIES),
        "strategies": [
            {
                "code": s.code,
                "category": s.category,
                "title": s.title,
                "signal_template": s.signal_template,
                "when_to_use": s.when_to_use,
                "risk_block": s.risk_block,
                "stationarity_required": s.stationarity_required,
                "bands": list(s.bands),
            }
            for s in STRATEGIES
        ],
    }
