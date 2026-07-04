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
    # Use the shared hardened fetcher: disk cache, rate-limit fallback, and
    # automatic BSE↔NSE twin retry (Yahoo's .BO coverage is spotty — this is
    # what made arbitrary all-stocks symbols 404 here).
    from nse_live import fetch_history

    period = "2y" if req.lookback_days > 366 else "1y" if req.lookback_days > 183 else "6mo"
    candles = fetch_history(req.symbol, interval="1d", period=period)
    if not candles or len(candles) < 60:
        raise HTTPException(
            status_code=404,
            detail=f"No usable daily history for {req.symbol} on Yahoo Finance (tried both NSE/BSE listings)",
        )
    df = pd.DataFrame([
        {"Date": pd.to_datetime(c["t"], unit="ms"), "open": c["o"], "high": c["h"],
         "low": c["l"], "close": c["c"], "volume": c["v"]}
        for c in candles
    ])
    df = df[["Date", "open", "high", "low", "close", "volume"]].dropna().reset_index(drop=True)

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
