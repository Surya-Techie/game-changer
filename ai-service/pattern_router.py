"""FastAPI router for the pattern engine — Phase 3.

Endpoints (all mounted under /patterns):
  - POST /patterns/detect           — single symbol, full engine pass
  - GET  /patterns/scan             — multi-symbol parallel scan, filtered
  - GET  /patterns/history/{symbol} — Mongo: last N detections + outcomes
  - GET  /patterns/accuracy         — Mongo: rollup per pattern_name × tf
  - POST /patterns/feedback         — commit an outcome onto a pattern
  - POST /patterns/train            — kick off async training job
  - GET  /patterns/train/{job_id}   — poll a training job (also lists if no id)
  - GET  /patterns/status           — registry + cache + mongo health

Design notes
------------
* Auth: when AI_SERVICE_TOKEN is set, main.py's middleware already gates
  every non-/health request. For admin-only routes (`/patterns/train`,
  `/patterns/feedback`), we additionally require `X-User-Role: admin` —
  the Node backend sets that header when proxying from an authenticated
  admin user.
* yfinance is blocking; multi-symbol scan uses a thread executor so all
  symbol fetches run concurrently without blocking the event loop.
* Pydantic v2 throughout (the project already targets pydantic ≥ 2.9).
"""

from __future__ import annotations

import asyncio
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import List, Literal, Optional

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from patterns.cache import PatternCache
from patterns.confidence_engine import score_many
from patterns.explainer import explain_many
from patterns.ml_classifier import predict_proba, registry_status
from patterns.mongo_store import (
    accuracy_summary,
    is_available as mongo_available,
    pattern_history,
    resolve_pattern_outcome,
    save_pattern,
    status as mongo_status,
    winrate_overrides,
)
from patterns.rule_engine import RuleEngineConfig, run_all_patterns
from patterns.training_jobs import (
    estimate_seconds,
    get as get_job,
    list_jobs,
    submit as submit_job,
)


router = APIRouter(prefix="/patterns", tags=["patterns"])

# Shared yfinance executor — 6 threads is enough for the scanner universe
# without overwhelming yfinance's informal rate limit.
_EXECUTOR = ThreadPoolExecutor(max_workers=6, thread_name_prefix="qti-pattern-fetch")

_VALID_TIMEFRAMES = ("M1", "M5", "M15", "M30", "H1", "D1")
TimeframeLit = Literal["M1", "M5", "M15", "M30", "H1", "D1"]


# ─── yfinance helper (cached briefly to avoid back-to-back hits) ────────

_TF_TO_YF = {
    "D1": {"period": "1y", "interval": "1d"},
    "H1": {"period": "60d", "interval": "1h"},
    "M30": {"period": "60d", "interval": "30m"},
    "M15": {"period": "30d", "interval": "15m"},
    "M5": {"period": "15d", "interval": "5m"},
    "M1": {"period": "7d", "interval": "1m"},
    # Chart-only extra — exposed by the OHLCV endpoint for the chart picker.
    "Y1": {"period": "5y", "interval": "1wk"},
}

# When the caller asks for tfX, this is the higher-tf we fetch for MTF.
_HIGHER_TF = {"M1": "M5", "M5": "M15", "M15": "M30", "M30": "H1", "H1": "D1", "D1": None}


def _fetch_ohlcv(symbol: str, timeframe: str) -> Optional[pd.DataFrame]:
    try:
        import yfinance as yf  # type: ignore
    except Exception:  # noqa: BLE001
        return None
    sym = symbol.upper()
    if not (sym.endswith(".NS") or sym.endswith(".BO")):
        sym = sym + ".NS"
    params = _TF_TO_YF.get(timeframe)
    if params is None:
        return None
    try:
        hist = yf.Ticker(sym).history(period=params["period"], interval=params["interval"], auto_adjust=False)
    except Exception:  # noqa: BLE001
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
    return df.reset_index(drop=True)


# ─── Pydantic models ───────────────────────────────────────────────────────

class DetectRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=20, examples=["RELIANCE"])
    timeframe: TimeframeLit = "D1"
    lookback: int = Field(100, ge=20, le=300)


class TrendlinePointModel(BaseModel):
    time: int
    price: float


class PatternOut(BaseModel):
    pattern_name: str
    detected: bool
    direction: str
    candle_indices: List[int]
    strength: float
    description: str
    historical_win_rate: float
    confidence_score: int
    grade: str
    category: str
    score_breakdown: dict
    score_reasoning: List[str]
    filters: dict
    ml_probs: dict
    entry_price: Optional[float] = None
    target_price: Optional[float] = None
    stop_price: Optional[float] = None
    risk_reward: Optional[float] = None
    trendline_points: List[TrendlinePointModel] = Field(default_factory=list)
    # Phase 9 — natural-language explanation built by patterns/explainer.py.
    ai_explanation: Optional[str] = None


class DetectResponse(BaseModel):
    symbol: str
    timeframe: str
    cached: bool
    served_at_ms: int
    candles_used: int
    patterns: List[PatternOut]
    higher_tf: Optional[str] = None


class ScanResponse(BaseModel):
    timeframe: str
    min_confidence: int
    symbols_requested: int
    symbols_scanned: int
    # Scan rows are PatternOut shape PLUS `symbol` / `timeframe` added for the
    # Scanner table — keep as dict so the extra fields don't get stripped.
    patterns: List[dict]


class HistoryResponse(BaseModel):
    symbol: str
    count: int
    patterns: List[dict]


class AccuracyResponse(BaseModel):
    available: bool
    rollups: List[dict]


class FeedbackRequest(BaseModel):
    pattern_id: str = Field(..., min_length=12)
    outcome: Literal["win", "loss", "breakeven"]
    exit_price: float = Field(..., gt=0)


class TrainRequest(BaseModel):
    timeframe: TimeframeLit = "D1"
    symbols: Optional[List[str]] = None
    fast: bool = False


class TrainSubmitResponse(BaseModel):
    job_id: str
    status: str
    timeframe: str
    estimated_seconds: int


# ─── Admin gate (header check) ─────────────────────────────────────────────

def _require_admin(request: Request) -> None:
    # When the service token is unset, the service is open (dev mode). We
    # still require an admin header so the route is never accidentally
    # exposed to anonymous traffic if mounted in front of a public proxy.
    role = request.headers.get("x-user-role", "").lower()
    if role != "admin":
        raise HTTPException(status_code=403, detail="admin role required")


# ─── Core engine pass ─────────────────────────────────────────────────────

def _run_engine_for_symbol(symbol: str, timeframe: str, lookback: int) -> Optional[dict]:
    """Synchronous: fetch + run rule engine + ML + confidence. Returns the
    JSON-serializable payload (without symbol/timeframe — caller wraps)."""
    df = _fetch_ohlcv(symbol, timeframe)
    if df is None or len(df) < 30:
        return None
    higher_df: Optional[pd.DataFrame] = None
    higher_tf = _HIGHER_TF.get(timeframe)
    if higher_tf:
        higher_df = _fetch_ohlcv(symbol, higher_tf)

    rule_hits = run_all_patterns(
        df,
        config=RuleEngineConfig(lookback=lookback),
        higher_tf_df=higher_df,
    )
    if not rule_hits:
        return {
            "candles_used": min(len(df), lookback),
            "higher_tf": higher_tf,
            "patterns": [],
        }

    ml = predict_proba(df, timeframe=timeframe)
    scored = score_many(rule_hits, df, timeframe=timeframe, higher_tf_df=higher_df, ml_probs=ml)

    # Phase 9 — attach a natural-language explanation per pattern. Errors here
    # are swallowed by explain_many (never block the detect response).
    wr_overrides = winrate_overrides() if mongo_available() else {}
    explained = explain_many(scored, df, symbol=symbol, timeframe=timeframe, win_rate_overrides=wr_overrides)

    return {
        "candles_used": min(len(df), lookback),
        "higher_tf": higher_tf,
        "patterns": explained,
    }


# ─── Endpoints ────────────────────────────────────────────────────────────

@router.post("/detect", response_model=DetectResponse)
def detect(req: DetectRequest) -> DetectResponse:
    sym = req.symbol.upper()
    tf = req.timeframe
    cache = PatternCache.shared()
    cache_key = f"pattern:{sym}:{tf}:{req.lookback}"

    cached = cache.get(cache_key)
    if cached is not None:
        cached["cached"] = True
        cached["served_at_ms"] = int(time.time() * 1000)
        return DetectResponse(**cached)

    body = _run_engine_for_symbol(sym, tf, req.lookback)
    if body is None:
        raise HTTPException(status_code=404, detail=f"no OHLCV available for {sym} at {tf}")

    # Persist each detected pattern (no-op if Mongo unavailable). We attach
    # symbol/timeframe before write so the document is self-describing.
    if mongo_available():
        wr_overrides = winrate_overrides()
        for p in body["patterns"]:
            if not p.get("detected"):
                continue
            doc = dict(p)
            doc["symbol"] = sym
            doc["timeframe"] = tf
            # Apply the live override if we have enough samples.
            override = wr_overrides.get(p.get("pattern_name"))
            if override is not None:
                doc["historical_win_rate"] = override
            try:
                pattern_id = save_pattern(doc)
                if pattern_id:
                    p["_id"] = pattern_id  # propagate id back to the response.
            except Exception:  # noqa: BLE001 — persistence is best-effort.
                pass

    response = {
        "symbol": sym,
        "timeframe": tf,
        "cached": False,
        "served_at_ms": int(time.time() * 1000),
        "candles_used": body["candles_used"],
        "higher_tf": body["higher_tf"],
        "patterns": body["patterns"],
    }
    cache.set(cache_key, response, ttl_seconds=60)
    return DetectResponse(**response)


@router.get("/scan", response_model=ScanResponse)
async def scan(
    symbols: str = Query(..., description="Comma-separated NSE symbols (e.g. RELIANCE,TCS,INFY)"),
    timeframe: TimeframeLit = Query("M15"),
    min_confidence: int = Query(70, ge=0, le=100),
    lookback: int = Query(100, ge=20, le=300),
) -> ScanResponse:
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not syms:
        raise HTTPException(status_code=400, detail="symbols query parameter is empty")
    if len(syms) > 50:
        raise HTTPException(status_code=400, detail="max 50 symbols per scan call")

    loop = asyncio.get_event_loop()
    cache = PatternCache.shared()

    async def _one(sym: str) -> Optional[dict]:
        key = f"pattern:{sym}:{timeframe}:{lookback}"
        cached = cache.get(key)
        if cached is not None:
            return {"symbol": sym, **cached}
        body = await loop.run_in_executor(_EXECUTOR, _run_engine_for_symbol, sym, timeframe, lookback)
        if body is None:
            return None
        wrapped = {
            "symbol": sym,
            "timeframe": timeframe,
            "cached": False,
            "served_at_ms": int(time.time() * 1000),
            "candles_used": body["candles_used"],
            "higher_tf": body["higher_tf"],
            "patterns": body["patterns"],
        }
        cache.set(key, wrapped, ttl_seconds=60)
        return wrapped

    bundles = await asyncio.gather(*[_one(s) for s in syms])
    scanned = [b for b in bundles if b is not None]

    keep: List[dict] = []
    for bundle in scanned:
        for p in bundle["patterns"]:
            if int(p.get("confidence_score", 0)) >= min_confidence:
                # Surface the symbol on each pattern for the Scanner table.
                row = dict(p)
                row["symbol"] = bundle["symbol"]
                row["timeframe"] = bundle["timeframe"]
                keep.append(row)
    keep.sort(key=lambda r: r.get("confidence_score", 0), reverse=True)

    return ScanResponse(
        timeframe=timeframe,
        min_confidence=min_confidence,
        symbols_requested=len(syms),
        symbols_scanned=len(scanned),
        patterns=keep,
    )


@router.get("/history/{symbol}", response_model=HistoryResponse)
def history(symbol: str, limit: int = Query(200, ge=1, le=500)) -> HistoryResponse:
    sym = symbol.upper()
    docs = pattern_history(sym, limit)
    return HistoryResponse(symbol=sym, count=len(docs), patterns=docs)


# OHLCV passthrough for the live pattern chart on the frontend. Exposes
# the same yfinance fetch used by the detector so chart prices line up
# with the pattern's entry/SL/TP — using mock-feed candles produces a
# scale mismatch where the price lines hang off-screen.
_OHLCV_TIMEFRAMES = ("M1", "M5", "M15", "M30", "H1", "D1", "Y1")


@router.get("/ohlcv/{symbol}")
def ohlcv(
    symbol: str,
    timeframe: str = Query("D1"),
    limit: int = Query(300, ge=20, le=2000),
) -> dict:
    tf = timeframe.upper()
    if tf not in _OHLCV_TIMEFRAMES:
        raise HTTPException(status_code=400, detail=f"unsupported timeframe: {timeframe}")
    df = _fetch_ohlcv(symbol.upper(), tf)
    if df is None or df.empty:
        return {"symbol": symbol.upper(), "timeframe": tf, "candles": []}
    # Take the most recent `limit` bars and serialise to the same shape
    # the frontend chart already consumes (t in epoch ms).
    df = df.tail(limit).reset_index(drop=True)
    candles = [
        {
            "t": int(row.time),
            "o": float(row.open),
            "h": float(row.high),
            "l": float(row.low),
            "c": float(row.close),
            "v": float(row.volume),
        }
        for row in df.itertuples(index=False)
    ]
    return {"symbol": symbol.upper(), "timeframe": tf, "candles": candles}


@router.get("/accuracy", response_model=AccuracyResponse)
def accuracy() -> AccuracyResponse:
    if not mongo_available():
        return AccuracyResponse(available=False, rollups=[])
    return AccuracyResponse(available=True, rollups=accuracy_summary())


@router.post("/feedback")
def feedback(req: FeedbackRequest, request: Request) -> dict:
    _require_admin(request)
    if not mongo_available():
        raise HTTPException(status_code=503, detail="mongo unavailable")
    result = resolve_pattern_outcome(req.pattern_id, req.outcome, req.exit_price)
    if not result.get("updated"):
        raise HTTPException(status_code=400, detail=result.get("reason", "update failed"))
    return result


@router.post("/train", response_model=TrainSubmitResponse)
def train(req: TrainRequest, request: Request) -> TrainSubmitResponse:
    _require_admin(request)
    syms = req.symbols or []  # default universe applied inside the runner
    job = submit_job(req.timeframe, symbols=syms, fast=req.fast)
    eta = estimate_seconds(req.timeframe, n_symbols=(len(syms) or 50), fast=req.fast)
    return TrainSubmitResponse(
        job_id=job.job_id,
        status=job.status,
        timeframe=job.timeframe,
        estimated_seconds=eta,
    )


@router.get("/train/{job_id}")
def train_status(job_id: str) -> dict:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.to_dict()


@router.get("/train")
def train_list() -> dict:
    return {"jobs": [j.to_dict() for j in list_jobs(limit=25)]}


@router.get("/status")
def patterns_status() -> dict:
    """Operational snapshot for the admin panel: model registry + cache backend + mongo."""
    return {
        "models": registry_status(),
        "cache": PatternCache.shared().info(),
        "mongo": mongo_status(),
        "ai_service_token_enabled": bool(os.environ.get("AI_SERVICE_TOKEN", "").strip()),
    }
