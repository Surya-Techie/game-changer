"""QTI AI service.

Exposes:
- POST /signal       — strategy decision for the latest bar
- POST /indicators   — full indicator series for chart overlays
- POST /patterns     — detected chart patterns with probability score
- POST /backtest     — replay candles through the strategy, return metrics
- POST /predict      — ML-based next-bar direction (D1; trained or lazy-trained)
- POST /sentiment    — lexicon-based news headline sentiment
- GET  /health
"""

from __future__ import annotations

import os
from typing import List, Literal, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

import indicators as ind
import patterns as pat
from backtest import BacktestRequest, run_backtest
from strategy import StrategyConfig, evaluate
from candlestick import detect_candlestick_patterns
from levels import compute_levels
from mtf_analysis import mtf_summary
from premium_indicators import (
    calculate_ichimoku_full,
    calculate_market_profile,
    calculate_order_flow,
    calculate_smc,
    calculate_vwap_full,
)
from ml_training import predict_with_trained, registry as ml_registry, train_symbol

# Composite strategy stack (5 layers + composer).
try:
    from composite_strategies import (
        SentimentInputs as CompSentimentInputs,
        StrategyComposer,
        candles_to_df,
    )

    _COMPOSER = StrategyComposer()
except Exception as _e:  # pragma: no cover
    _COMPOSER = None
    _composer_err = str(_e)

app = FastAPI(title="QTI AI Service", version="0.2.0")


# ─── Service-token gate ────────────────────────────────────────────────
# Optional shared-secret auth for the AI service. When AI_SERVICE_TOKEN
# is set in the environment, every request must include a matching
# `X-Service-Token` header. Empty / unset = open (current dev behaviour
# preserved for in-cluster Docker-network use). Health probes are always
# allowed through so liveness checks still work.

import secrets as _secrets  # noqa: E402
from fastapi import Request, HTTPException  # noqa: E402

_SERVICE_TOKEN = os.environ.get("AI_SERVICE_TOKEN", "").strip()

@app.middleware("http")
async def _service_token_gate(request: Request, call_next):
    if _SERVICE_TOKEN and request.url.path not in ("/health", "/docs", "/openapi.json", "/redoc"):
        provided = request.headers.get("x-service-token", "")
        # constant-time compare to avoid timing side channels
        if not provided or not _secrets.compare_digest(provided, _SERVICE_TOKEN):
            raise HTTPException(status_code=401, detail="invalid service token")
    return await call_next(request)

# Options chain + Greeks. Imported lazily so a missing yfinance install
# doesn't crash the rest of the service.
try:
    from options import router as options_router  # noqa: E402

    app.include_router(options_router)
except Exception as _opt_err:  # pragma: no cover
    options_router = None  # type: ignore[assignment]

# Flat indicator snapshot endpoint for the alert formula evaluator.
try:
    from indicator_snapshot import router as indicator_snapshot_router  # noqa: E402

    app.include_router(indicator_snapshot_router)
except Exception as _snap_err:  # pragma: no cover
    indicator_snapshot_router = None  # type: ignore[assignment]

# Pattern detection engine (Phase 3) — rule engine + sklearn ML + confidence scoring.
try:
    from pattern_router import router as pattern_engine_router  # noqa: E402

    app.include_router(pattern_engine_router)
except Exception as _pat_err:  # pragma: no cover
    pattern_engine_router = None  # type: ignore[assignment]

# Gainz Alpha (Brandt classical pattern model + ensemble).
try:
    from gainz_alpha.api_route import router as gainz_alpha_router  # noqa: E402

    app.include_router(gainz_alpha_router)
except Exception as _ga_err:  # pragma: no cover
    print(f"[gainz_alpha] router not mounted: {_ga_err}")
    gainz_alpha_router = None  # type: ignore[assignment]

# Chan Advisor (Ernest Chan strategy-selection engine).
try:
    from chan_advisor.api_route import router as chan_advisor_router  # noqa: E402

    app.include_router(chan_advisor_router)
except Exception as _ca_err:  # pragma: no cover
    print(f"[chan_advisor] router not mounted: {_ca_err}")
    chan_advisor_router = None  # type: ignore[assignment]

# Pattern backtesting (Phase 7) — sibling of the legacy /backtest endpoint.
try:
    from patterns_backtest_router import router as patterns_backtest_router  # noqa: E402

    app.include_router(patterns_backtest_router)
except Exception as _pbt_err:  # pragma: no cover
    patterns_backtest_router = None  # type: ignore[assignment]


# ─── Paper-trading price feed ───────────────────────────────────────────
# Thin wrapper around yfinance, used by the Node backend to fuel the
# paper-trading order terminal and the SL/TP background loop. We cache
# each symbol for 15s to be a polite NSE client and to absorb burst
# lookups. yfinance is imported lazily so the rest of the service still
# runs if it isn't installed yet (e.g. fresh checkout, no `pip install`).

import time as _time
from typing import Tuple as _Tuple

try:
    import yfinance as _yf  # type: ignore
    _YF_OK = True
except Exception as _yf_err:  # pragma: no cover
    _YF_OK = False
    _YF_IMPORT_ERR = str(_yf_err)

_PRICE_CACHE: dict[str, _Tuple[float, float]] = {}  # symbol -> (price, fetched_at)
_PRICE_TTL_SEC = 15.0


def _yfinance_price(symbol: str) -> Optional[float]:
    """Best-effort spot price. Tries fast_info → info → history fallback."""
    if not _YF_OK:
        return None
    try:
        sym = symbol.upper()
        if not (sym.endswith(".NS") or sym.endswith(".BO")):
            sym = sym + ".NS"
        t = _yf.Ticker(sym)
        # Cheapest path.
        try:
            p = float(getattr(t.fast_info, "last_price", 0) or 0)
            if p > 0:
                return p
        except Exception:
            pass
        try:
            info = t.info or {}
            for k in ("currentPrice", "regularMarketPrice", "previousClose"):
                v = info.get(k)
                if v:
                    return float(v)
        except Exception:
            pass
        hist = t.history(period="1d", interval="1m")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception:
        return None
    return None


try:
    from nse_live import fetch_nse_ltp, fetch_nse_batch, fetch_history
    _NSE_OK = True
except Exception:
    _NSE_OK = False


@app.get("/nse-live/{symbol}")
def nse_live(symbol: str):
    """Real-time NSE LTP for a single symbol. 2 s server-side cache.

    Returns shape from ``nse_live.fetch_nse_ltp`` plus ``available: bool``.
    During market hours this is the actual exchange last-trade price, not
    a 15-min delayed yfinance value.
    """
    if not _NSE_OK:
        return {"symbol": symbol.upper(), "available": False, "reason": "nse_live module unavailable"}
    r = fetch_nse_ltp(symbol)
    if not r:
        return {"symbol": symbol.upper(), "available": False, "reason": "no_data"}
    return {**r, "available": True}


@app.get("/nse-live")
def nse_live_batch(symbols: str = ""):
    """Comma-separated batch fetch: ``/nse-live?symbols=RELIANCE,TCS,INFY``."""
    if not _NSE_OK:
        return {"available": False, "quotes": {}}
    syms = [s.strip() for s in symbols.split(",") if s.strip()]
    if not syms:
        return {"available": True, "quotes": {}}
    return {"available": True, "quotes": fetch_nse_batch(syms)}


@app.get("/history/{symbol}")
def history(symbol: str, interval: str = "1m", period: str = "5d"):
    """Real historical OHLCV candles (yfinance). Ascending epoch-ms bars.

    The backend calls this at startup to seed its in-memory candle store
    with REAL bars so signals are never computed on fabricated history.
    """
    if not _NSE_OK:
        return {"symbol": symbol.upper(), "available": False, "candles": []}
    candles = fetch_history(symbol, interval=interval, period=period)
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "period": period,
        "available": len(candles) > 0,
        "candles": candles,
    }


@app.get("/price/{symbol}")
def price(symbol: str):
    """Spot price for NSE symbol (e.g. 'RELIANCE'). 15s server-side cache.
    Returns: { symbol, price, ts, delayed: True, source: 'yfinance'|'cache' }.
    """
    sym = symbol.upper()
    now = _time.time()
    cached = _PRICE_CACHE.get(sym)
    if cached and now - cached[1] < _PRICE_TTL_SEC:
        return {
            "symbol": sym,
            "price": cached[0],
            "ts": int(cached[1] * 1000),
            "delayed": True,
            "source": "cache",
        }
    p = _yfinance_price(sym)
    if p is None or p <= 0:
        if cached:
            # Serve last-known on failure.
            return {
                "symbol": sym,
                "price": cached[0],
                "ts": int(cached[1] * 1000),
                "delayed": True,
                "source": "stale",
            }
        return {"symbol": sym, "price": 0, "ts": int(now * 1000), "delayed": True, "source": "unavailable"}
    _PRICE_CACHE[sym] = (p, now)
    return {
        "symbol": sym,
        "price": p,
        "ts": int(now * 1000),
        "delayed": True,
        "source": "yfinance",
    }


class Candle(BaseModel):
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float


class StrategyToggles(BaseModel):
    # Every field is optional: only explicitly-sent values override the
    # StrategyConfig defaults. A partial toggle payload (e.g. just the
    # regime filter) must NOT silently reset exit geometry to old values.
    regimeFilter: Optional[bool] = None
    regimeMinAdx: Optional[float] = None
    mtfConfirmation: Optional[bool] = None
    stopMode: Optional[Literal["ATR", "FIXED_PCT"]] = None
    stopPct: Optional[float] = None
    targetRR: Optional[float] = None


class SignalRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=30)
    strategy: Optional[StrategyToggles] = None


class SignalResponse(BaseModel):
    action: Literal["BUY", "SELL", "HOLD"]
    confidence: float
    reason: str
    indicators: dict
    filters: dict = {}
    suggestedEntry: Optional[float] = None
    suggestedStop: Optional[float] = None
    suggestedTarget: Optional[float] = None


def _cfg_from(t: Optional[StrategyToggles]) -> StrategyConfig:
    cfg = StrategyConfig()
    if not t:
        return cfg
    if t.regimeFilter is not None:
        cfg.regime_filter = t.regimeFilter
    if t.regimeMinAdx is not None:
        cfg.regime_min_adx = t.regimeMinAdx
    if t.mtfConfirmation is not None:
        cfg.mtf_confirmation = t.mtfConfirmation
    if t.stopMode is not None:
        cfg.stop_mode = t.stopMode
    if t.stopPct is not None:
        cfg.stop_pct = t.stopPct
    if t.targetRR is not None:
        cfg.target_rr = t.targetRR
    return cfg


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": "0.2.0"}


def _candles_to_dicts(candles: List[Candle]) -> List[dict]:
    return [c.model_dump() for c in candles]


@app.post("/signal", response_model=SignalResponse)
def signal(req: SignalRequest) -> SignalResponse:
    d = evaluate(_candles_to_dicts(req.candles), _cfg_from(req.strategy))
    return SignalResponse(
        action=d.action,  # type: ignore[arg-type]
        confidence=d.confidence,
        reason=d.reason,
        indicators=d.indicators,
        filters=d.filters,
        suggestedEntry=d.suggested_entry,
        suggestedStop=d.suggested_stop,
        suggestedTarget=d.suggested_target,
    )


class IndicatorRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=20)
    families: List[str] = Field(
        default_factory=lambda: ["sma", "ema", "rsi", "macd", "bollinger", "stochastic", "supertrend", "vwap", "ichimoku", "atr"]
    )


@app.post("/indicators")
def indicator_series(req: IndicatorRequest) -> dict:
    closes = [c.c for c in req.candles]
    highs = [c.h for c in req.candles]
    lows = [c.l for c in req.candles]
    vols = [c.v for c in req.candles]
    times = [c.t for c in req.candles]
    out: dict = {"t": times}
    fam = set(req.families)
    if "sma" in fam:
        out["sma9"] = ind.sma(closes, 9)
        out["sma21"] = ind.sma(closes, 21)
        out["sma50"] = ind.sma(closes, 50)
    if "ema" in fam:
        out["ema9"] = ind.ema(closes, 9)
        out["ema21"] = ind.ema(closes, 21)
        out["ema50"] = ind.ema(closes, 50)
    if "rsi" in fam:
        out["rsi14"] = ind.rsi(closes, 14)
    if "macd" in fam:
        line, sig, hist = ind.macd(closes)
        out["macdLine"] = line
        out["macdSignal"] = sig
        out["macdHist"] = hist
    if "bollinger" in fam:
        u, m, l = ind.bollinger(closes, 20, 2.0)
        out["bbUpper"] = u
        out["bbMid"] = m
        out["bbLower"] = l
    if "stochastic" in fam:
        k, d = ind.stochastic_rsi(closes)
        out["stochK"] = k
        out["stochD"] = d
    if "supertrend" in fam:
        line, direction = ind.supertrend(highs, lows, closes)
        out["supertrend"] = line
        out["supertrendDir"] = direction
    if "vwap" in fam:
        out["vwap"] = ind.vwap(highs, lows, closes, vols)
    if "ichimoku" in fam:
        out["ichimoku"] = ind.ichimoku(highs, lows, closes)
    if "atr" in fam:
        out["atr14"] = ind.atr(highs, lows, closes, 14)
    return out


class PatternRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=30)


@app.post("/patterns")
def patterns_endpoint(req: PatternRequest) -> dict:
    detections = pat.detect_all(_candles_to_dicts(req.candles))
    return {
        "symbol": req.symbol,
        "detections": [
            {
                "pattern": d.pattern,
                "direction": d.direction,
                "start": d.start,
                "end": d.end,
                "score": d.score,
                "notes": d.notes,
                "points": d.points,
            }
            for d in detections
        ],
    }


class CandlestickRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=5)
    lookback: int = 30


@app.post("/candlestick")
def candlestick_endpoint(req: CandlestickRequest) -> dict:
    return {
        "symbol": req.symbol,
        "patterns": detect_candlestick_patterns(_candles_to_dicts(req.candles), req.lookback),
    }


class LevelsRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=30)


@app.post("/levels")
def levels_endpoint(req: LevelsRequest) -> dict:
    return {"symbol": req.symbol, **compute_levels(_candles_to_dicts(req.candles))}


class MtfRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=30)


@app.post("/mtf")
def mtf_endpoint(req: MtfRequest) -> dict:
    return {"symbol": req.symbol, **mtf_summary(_candles_to_dicts(req.candles))}


# ---------- Premium indicator endpoints ---------------------------------------

class PremiumRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=30)


class VwapRequest(PremiumRequest):
    anchor_bars: Optional[List[int]] = None


@app.post("/premium/vwap")
def premium_vwap(req: VwapRequest) -> dict:
    return {"symbol": req.symbol, **calculate_vwap_full(_candles_to_dicts(req.candles), req.anchor_bars)}


@app.post("/premium/ichimoku")
def premium_ichimoku(req: PremiumRequest) -> dict:
    return {"symbol": req.symbol, **calculate_ichimoku_full(_candles_to_dicts(req.candles))}


@app.post("/premium/smc")
def premium_smc(req: PremiumRequest) -> dict:
    return {"symbol": req.symbol, **calculate_smc(_candles_to_dicts(req.candles))}


@app.post("/premium/orderflow")
def premium_orderflow(req: PremiumRequest) -> dict:
    return {"symbol": req.symbol, **calculate_order_flow(_candles_to_dicts(req.candles))}


@app.post("/premium/profile")
def premium_profile(req: PremiumRequest) -> dict:
    return {"symbol": req.symbol, **calculate_market_profile(_candles_to_dicts(req.candles))}


# ---------- ML training endpoints --------------------------------------------

class MlTrainRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=80)
    horizon: int = 5


@app.post("/ml/train")
def ml_train(req: MlTrainRequest) -> dict:
    return train_symbol(req.symbol, _candles_to_dicts(req.candles), req.horizon)


class MlPredictRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=50)


@app.post("/ml/predict")
def ml_predict(req: MlPredictRequest) -> dict:
    return predict_with_trained(req.symbol, _candles_to_dicts(req.candles))


@app.get("/ml/registry")
def ml_registry_endpoint() -> dict:
    return ml_registry()


class BacktestApiRequest(BaseModel):
    symbol: str
    candles: List[Candle] = Field(..., min_length=70)
    capital: float = 100_000.0
    riskPerTradePct: float = 1.0
    minConfidence: float = 0.55
    warmup: int = 60
    slippageBps: float = 2.0
    strategy: Optional[StrategyToggles] = None
    trailingStopPct: Optional[float] = None
    partialTpEnabled: bool = False
    brokerageFlat: float = 0.0
    brokeragePct: float = 0.0


@app.post("/backtest")
def backtest_endpoint(req: BacktestApiRequest) -> dict:
    backtest_req = BacktestRequest(
        candles=_candles_to_dicts(req.candles),
        capital=req.capital,
        risk_per_trade_pct=req.riskPerTradePct,
        min_confidence=req.minConfidence,
        warmup=req.warmup,
        slippage_bps=req.slippageBps,
        strategy_cfg=_cfg_from(req.strategy),
        trailing_stop_pct=req.trailingStopPct,
        partial_tp=req.partialTpEnabled,
        brokerage_flat=req.brokerageFlat,
        brokerage_pct=req.brokeragePct,
    )
    return run_backtest(backtest_req, symbol=req.symbol)


# --- Composite strategy stack (5 layers) --------------------------------------

if _COMPOSER is not None:

    class CompositeSentiment(BaseModel):
        fii_dii_net_cr: Optional[float] = None
        india_vix: Optional[float] = None
        ad_ratio: Optional[float] = None
        pcr: Optional[float] = None
        news_sentiment: Optional[float] = None

    class CompositeRequest(BaseModel):
        symbol: str
        candles: List[Candle] = Field(..., min_length=30)
        peer_candles: Optional[List[Candle]] = None
        sentiment: Optional[CompositeSentiment] = None
        weights: Optional[dict] = None

    def _sentiment_from_model(m: Optional[CompositeSentiment]) -> Optional[CompSentimentInputs]:
        if m is None:
            return None
        return CompSentimentInputs(
            fii_dii_net_cr=m.fii_dii_net_cr,
            india_vix=m.india_vix,
            ad_ratio=m.ad_ratio,
            pcr=m.pcr,
            news_sentiment=m.news_sentiment,
        )

    @app.post("/composite")
    def composite_endpoint(req: CompositeRequest) -> dict:
        df = candles_to_df(_candles_to_dicts(req.candles))
        peer_df = candles_to_df(_candles_to_dicts(req.peer_candles)) if req.peer_candles else None
        composer = StrategyComposer(weights=req.weights) if req.weights else _COMPOSER
        result = composer.evaluate(
            df,
            symbol=req.symbol,
            peer_df=peer_df,
            sentiment_inputs=_sentiment_from_model(req.sentiment),
        )
        return result.to_dict()

    class CompositeBacktestRequest(CompositeRequest):
        warmup: int = 60
        entry_score: float = 65.0
        exit_score: float = 50.0
        sl_pct: float = 0.02
        tp_pct: Optional[float] = 0.05
        allow_short: bool = True

    @app.post("/composite/backtest")
    def composite_backtest_endpoint(req: CompositeBacktestRequest) -> dict:
        df = candles_to_df(_candles_to_dicts(req.candles))
        peer_df = candles_to_df(_candles_to_dicts(req.peer_candles)) if req.peer_candles else None
        composer = StrategyComposer(weights=req.weights) if req.weights else _COMPOSER
        return composer.backtest(
            df,
            symbol=req.symbol,
            peer_df=peer_df,
            sentiment_inputs=_sentiment_from_model(req.sentiment),
            warmup=req.warmup,
            entry_score=req.entry_score,
            exit_score=req.exit_score,
            sl_pct=req.sl_pct,
            tp_pct=req.tp_pct,
            allow_short=req.allow_short,
        )


# --- Power Analysis super-composer ------------------------------------------
try:
    from power_analysis import run_power_analysis  # type: ignore[import-not-found]

    class PowerAnalysisRequest(BaseModel):
        symbol: str
        candles: List[Candle] = Field(..., min_length=80)
        # Single POWER decision rule. "strict"/"loose" are accepted for
        # backward compatibility but map to the same rule now.
        mode: Literal["power", "strict", "loose"] = "power"
        use_ml: bool = False
        # Target multiple of risk. 2.0 maximises win rate, 4.0 targets
        # ~4 % returns per winning trade. Anything outside [1.0, 6.0]
        # is clipped — extreme R values produce broken signals.
        target_r: float = Field(2.0, ge=1.0, le=6.0)
        # Optional fixed-% stop/target. When set, override the ATR-based
        # envelope so every trade has the same risk shape (e.g. 2% stop,
        # 5% target = 2.5:1 R:R regardless of volatility).
        stop_pct: Optional[float] = Field(None, ge=0.1, le=20.0)
        target_pct: Optional[float] = Field(None, ge=0.1, le=30.0)

    @app.post("/power-analysis")
    def power_analysis_endpoint(req: PowerAnalysisRequest) -> dict:
        return run_power_analysis(
            _candles_to_dicts(req.candles),
            symbol=req.symbol,
            mode=req.mode,
            use_ml=req.use_ml,
            target_r=req.target_r,
            stop_pct=req.stop_pct,
            target_pct=req.target_pct,
        )
except Exception:  # noqa: BLE001
    pass


# --- High-conviction composite signal ---------------------------------------
try:
    from high_conviction import compose_high_conviction  # type: ignore[import-not-found]

    class HighConvictionRequest(BaseModel):
        symbol: str
        candles: List[Candle] = Field(..., min_length=80)
        use_ml: bool = True
        # When true, demand unanimous agreement + higher confidence floor +
        # R:R ≥ 1.0. Trades far less often, but each trade has a higher
        # measured win rate AND positive expectancy.
        strict: bool = False

    @app.post("/high-conviction")
    def high_conviction_endpoint(req: HighConvictionRequest) -> dict:
        return compose_high_conviction(
            _candles_to_dicts(req.candles),
            symbol=req.symbol,
            use_ml=req.use_ml,
            strict=req.strict,
        )
except Exception:  # noqa: BLE001
    pass


# --- PPS (Pattern Probability Strategy) signal engine -----------------------
try:
    from pps_engine import (  # type: ignore[import-not-found]
        generate_pps_signals,
        summarise as _pps_summarise,
        enrich_signals_with_accuracy as _pps_enrich,
    )

    def _pps_accuracy_lookup() -> dict:
        """Build {canonical_pattern_name: {win_rate, samples}} from the
        pattern-accuracy rollups, aggregated across timeframes. Empty when
        Mongo is unavailable — the enrichment then no-ops gracefully."""
        try:
            from patterns.mongo_store import accuracy_summary, mongo_available  # type: ignore
            if not mongo_available():
                return {}
            agg: dict = {}
            for r in accuracy_summary():
                name = r.get("pattern_name")
                if not name:
                    continue
                a = agg.setdefault(name, {"wins": 0, "total": 0})
                a["wins"] += int(r.get("wins") or 0)
                a["total"] += int(r.get("total_detected") or 0)
            return {
                name: {"win_rate": v["wins"] / v["total"], "samples": v["total"]}
                for name, v in agg.items() if v["total"] > 0
            }
        except Exception:  # noqa: BLE001
            return {}

    class PpsBar(BaseModel):
        date: str
        open: float
        high: float
        low: float
        close: float
        volume: float = 0.0

    class PpsRequest(BaseModel):
        symbol: str
        timeframe: str = "1D"
        bars: List[PpsBar] = Field(..., min_length=50)

    @app.post("/pps-signals")
    def pps_signals_endpoint(req: PpsRequest) -> dict:
        bars_in = [b.model_dump() for b in req.bars]
        signals = generate_pps_signals(bars_in)
        # Analytics → PPS: fold measured pattern win rates onto the signals.
        signals = _pps_enrich(signals, _pps_accuracy_lookup())
        return {
            "symbol": req.symbol,
            "timeframe": req.timeframe,
            "signals": signals,
            "summary": _pps_summarise(signals),
        }

    @app.post("/pps-signals/record")
    def pps_record_endpoint(req: PpsRequest) -> dict:
        """PPS → Analytics: resolve each historical PPS signal's outcome and
        commit it to the pattern-accuracy store, so PPS patterns show up on
        the Analytics page (and feed the Analytics → PPS read-back).

        APPEND-ONLY / NOT idempotent: every call re-resolves and re-records
        the supplied window. Intended for deliberate batch/backfill use
        (scheduled job or admin action), NOT for per-refresh calls — that
        would inflate the counts.
        """
        from pps_engine import resolve_pps_outcomes, normalise_timeframe  # type: ignore
        bars_in = [b.model_dump() for b in req.bars]
        signals = generate_pps_signals(bars_in)
        resolved = resolve_pps_outcomes(signals, bars_in)
        tf = normalise_timeframe(req.timeframe)
        try:
            from patterns.mongo_store import update_accuracy, mongo_available  # type: ignore
            if not mongo_available():
                return {"recorded": 0, "resolvable": len(resolved),
                        "reason": "mongo unavailable", "timeframe": tf}
        except Exception:  # noqa: BLE001
            return {"recorded": 0, "resolvable": len(resolved), "reason": "store unavailable"}

        recorded = wins = losses = 0
        by_pattern: dict = {}
        for r in resolved:
            try:
                update_accuracy(r["pattern_name"], tf, r["outcome"], r["rr_achieved"], r["hold_bars"])
            except Exception:  # noqa: BLE001
                continue
            recorded += 1
            wins += 1 if r["outcome"] == "win" else 0
            losses += 1 if r["outcome"] == "loss" else 0
            p = by_pattern.setdefault(r["pattern_name"], {"recorded": 0, "wins": 0})
            p["recorded"] += 1
            p["wins"] += 1 if r["outcome"] == "win" else 0
        return {
            "symbol": req.symbol, "timeframe": tf,
            "recorded": recorded, "wins": wins, "losses": losses,
            "by_pattern": by_pattern,
        }
except Exception:  # noqa: BLE001 — pps_engine import is mandatory at runtime; this only protects boot under broken edits
    pass


# --- D1: ML prediction --------------------------------------------------------
try:
    from ml_predictor import predict_next, train_or_load  # type: ignore[import-not-found]

    @app.on_event("startup")
    def _warm_predictor() -> None:
        # Lazy: model trains on first /predict call if not present.
        pass

    class PredictRequest(BaseModel):
        symbol: str
        candles: List[Candle] = Field(..., min_length=80)
        horizon: int = 5

    @app.post("/predict")
    def predict_endpoint(req: PredictRequest) -> dict:
        return predict_next(_candles_to_dicts(req.candles), req.symbol, req.horizon)
except Exception:  # noqa: BLE001 — ML deps optional
    pass


# --- D2: sentiment ------------------------------------------------------------
try:
    from sentiment import classify  # type: ignore[import-not-found]

    class SentimentItem(BaseModel):
        id: str
        text: str

    class SentimentRequest(BaseModel):
        items: List[SentimentItem]

    @app.post("/sentiment")
    def sentiment_endpoint(req: SentimentRequest) -> dict:
        return {"items": [{"id": it.id, **classify(it.text)} for it in req.items]}
except Exception:  # noqa: BLE001
    pass


# --- Live news-sentiment signal (real headlines) ------------------------------
# Distinct from /sentiment (which scores arbitrary text): this pulls REAL
# recent headlines for a symbol and returns a recency-weighted aggregate.
# It is a context signal, NOT a backtested edge — see news_sentiment.py.
try:
    from news_sentiment import analyze_symbol as _news_analyze  # type: ignore[import-not-found]

    @app.get("/news-sentiment/{symbol}")
    def news_sentiment_endpoint(symbol: str, aliases: str = "") -> dict:
        alias_list = [a.strip() for a in aliases.split(",") if a.strip()]
        return _news_analyze(symbol, aliases=alias_list or None)
except Exception:  # noqa: BLE001
    pass


# ─── Master Confluence Scan (Phase 7 — runs every detector) ────────────────
# POST /api/patterns/scan-all
# Accepts {symbol, candles, weekly_candles?} and returns:
#   master_signal (from compute_master_confluence) + ranked patterns list.
try:
    from patterns.master_confluence import compute_master_confluence  # type: ignore[import-not-found]

    class _ScanAllRequest(BaseModel):
        symbol: str
        candles: List[Candle] = Field(..., min_length=80)
        weekly_candles: Optional[List[Candle]] = None

    def _candles_to_df(cs: List[Candle]) -> "pd.DataFrame":  # type: ignore[name-defined]
        import pandas as _pd
        rows = [c.model_dump() for c in cs]
        df = _pd.DataFrame(rows)
        df = df.rename(columns={"t": "time", "o": "open", "h": "high",
                                  "l": "low", "c": "close", "v": "volume"})
        return df.reset_index(drop=True)

    @app.post("/api/patterns/scan-all")
    def patterns_scan_all(req: _ScanAllRequest) -> dict:
        df = _candles_to_df(req.candles)
        # Build a weekly aggregate if not supplied. Conservative: group by
        # ISO week using the candle timestamp.
        if req.weekly_candles:
            df_w = _candles_to_df(req.weekly_candles)
        else:
            import pandas as _pd
            ts = _pd.to_datetime(df["time"], unit="ms", utc=True)
            df_w = (
                df.assign(_iso=ts.dt.strftime("%G-W%V"))
                  .groupby("_iso", sort=False)
                  .agg(open=("open", "first"), high=("high", "max"),
                       low=("low", "min"), close=("close", "last"),
                       volume=("volume", "sum"), time=("time", "last"))
                  .reset_index(drop=True)
            )
        master = compute_master_confluence(req.symbol, df, df_w)
        return master

except Exception as _mc_err:  # pragma: no cover
    print(f"[master_confluence] router not mounted: {_mc_err}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("AI_PORT", "8000")), reload=True)
