"""FastAPI router exposing the Gainz Alpha composite signal.

Mounted from ai-service/main.py:

    from gainz_alpha.api_route import router as gainz_alpha_router
    app.include_router(gainz_alpha_router)

Routes:
    POST /gainz-alpha/score                — composite signal for a symbol
    GET  /gainz-alpha/patterns/reliability — Brandt reliability hierarchy
    GET  /gainz-alpha/health               — engine status (models loaded?)
"""

from __future__ import annotations

import os
from typing import Optional

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .ensemble_engine import GainzAlphaEngine
from .brandt_features import extract_brandt_features
from .pattern_detector import detect_best_brandt_pattern, detect_all_brandt_patterns

router = APIRouter(prefix="/gainz-alpha", tags=["Gainz Alpha"])

# Resolve paths relative to the ai-service root so this works from CLI,
# tests, and uvicorn alike.
_AI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODEL_PATHS = {
    "brandt":  os.path.join(_AI_ROOT, "models", "brandt_pattern_model.pkl"),
    "model_1": os.path.join(_AI_ROOT, "models", "model_1_rsi_macd.pkl"),
    "model_2": os.path.join(_AI_ROOT, "models", "model_2_sentiment_volume.pkl"),
    "model_3": os.path.join(_AI_ROOT, "models", "model_3_momentum.pkl"),
}

_engine: Optional[GainzAlphaEngine] = None


def _get_engine() -> GainzAlphaEngine:
    """Lazily construct the engine on first request so import-time
    failures don't kill the whole ai-service."""
    global _engine
    if _engine is None:
        _engine = GainzAlphaEngine(_MODEL_PATHS)
    return _engine


class AlphaRequest(BaseModel):
    symbol: str
    lookback_days: int = 252        # 1 year of daily bars
    capital: Optional[float] = None # INR; enables full position-sizing block


@router.get("/health")
async def health():
    paths = {k: (v, os.path.exists(v)) for k, v in _MODEL_PATHS.items()}
    return {
        "models": {k: {"path": p, "exists": exists} for k, (p, exists) in paths.items()},
        "engine_ready": os.path.exists(_MODEL_PATHS["brandt"]),
    }


@router.post("/score")
async def score(req: AlphaRequest):
    try:
        engine = _get_engine()
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # Pull daily OHLCV. Use yfinance to keep this self-contained; in prod
    # this would hit the shared candle store.
    try:
        import yfinance as yf
    except ImportError:
        raise HTTPException(status_code=500, detail="yfinance unavailable")

    ticker = req.symbol if req.symbol.endswith((".NS", ".BO")) else f"{req.symbol}.NS"
    try:
        raw = yf.download(ticker, period=f"{req.lookback_days}d",
                          progress=False, auto_adjust=False)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"yfinance error: {e}")
    if raw is None or raw.empty:
        raise HTTPException(status_code=404, detail=f"No data for {req.symbol}")

    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = [c[0] for c in raw.columns]
    df = raw.rename(columns={c: c.lower() for c in raw.columns})
    df = df[["open", "high", "low", "close", "volume"]].dropna().reset_index()

    pattern = detect_best_brandt_pattern(df)
    if pattern is None:
        return {
            "symbol": req.symbol.upper(),
            "pattern_detected": None,
            "alpha_score": 0.0,
            "signal": "NO_PATTERN",
            "note": "No Brandt-grade pattern in the lookback window.",
        }

    feats = extract_brandt_features(df, pattern)
    result = engine.compute_alpha_score(feats, capital=req.capital)

    return {
        "symbol": req.symbol.upper(),
        "pattern_detected": pattern["name"],
        "pattern_tier": pattern["tier"],
        "pattern_duration_weeks": feats["pattern_duration_weeks"],
        "pattern_obviousness": feats["pattern_obviousness_score"],
        "gainz_alpha_score": result["alpha_score"],
        "signal": result["signal"],
        "component_scores": result.get("component_scores", {}),
        "weights": result.get("weights", {}),
        "constraint_multiplier": result.get("constraint_multiplier"),
        "brandt_rule_score": result.get("brandt_rule_score"),
        "brandt_bonuses_applied": result.get("brandt_bonuses", []),
        "reject_reasons": result.get("reject_reasons"),
        "risk_management": {
            "stop_loss_pct": result.get("stop_loss_pct"),
            "target_pct": result.get("target_pct"),
            "reward_risk": result.get("reward_risk"),
            "position_sizing": result.get("position_sizing"),
        },
    }


class ChartPatternsRequest(BaseModel):
    candles: list[dict]
    min_confidence: float = 0.4


@router.post("/chart-patterns")
async def chart_patterns(req: ChartPatternsRequest):
    """Run all 23 classical chart-pattern detectors over supplied OHLCV.

    Returns every detection with full geometry (trendline points,
    candle indices, entry / SL / TP) so the frontend can draw the
    pattern shapes directly on the chart — necklines, support /
    resistance lines, wedge boundaries, breakout arrows.

    Caller passes the same yfinance candles already loaded in the
    Power Analysis chart so detection runs on the exact bars the user
    is looking at.
    """
    if not req.candles:
        return {"patterns": []}
    df = pd.DataFrame(req.candles)
    if "t" not in df.columns or "c" not in df.columns:
        return {"patterns": []}
    df = df.rename(columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})
    df = df[["t", "open", "high", "low", "close", "volume"]].dropna()
    if len(df) < 60:
        return {"patterns": [], "reason": "need >= 60 candles"}
    patterns = detect_all_brandt_patterns(df, min_confidence=req.min_confidence)
    return {"count": len(patterns), "patterns": patterns}


@router.get("/patterns/reliability")
async def reliability():
    """Brandt's reliability hierarchy — pulled from pattern_detector tiers."""
    from .pattern_detector import BRANDT_PATTERNS
    tiers = {0: [], 1: [], 2: []}
    for p in BRANDT_PATTERNS:
        tiers[p["tier"]].append({"id": p["id"], "name": p["name"], "boundary": p["boundary"]})
    return {
        "high_reliability":   tiers[0],
        "medium_reliability": tiers[1],
        "lower_reliability":  tiers[2],
        "key_rule": "Horizontal boundary patterns (boundary=0) are always more reliable than diagonal (boundary=1).",
    }
