"""
FastAPI backend for the Trading Lab frontend.

Run:
    python -m uvicorn trading_app.server.main:app --reload --port 8000

Endpoints:
    GET  /                                              -> index.html
    GET  /static/{path}                                 -> CSS/JS assets
    GET  /api/meta                                      -> symbols, strategies, theme, config
    GET  /api/chart-data                                -> OHLCV + signals + confidence
    GET  /api/live-signals                              -> latest-bar BUY/SELL/HOLD per strategy
    POST /api/backtest                                  -> full backtest results
    GET  /api/screener                                  -> top-N picks for the day
    POST /api/optimize                                  -> grid_search + walk-forward
"""
from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from trading_app import config
from trading_app.data.fetcher import fetch, to_ist
from trading_app.strategies import (
    ALL_STRATEGIES, STRAT_MAP, NUMBERED_STRATEGIES,
)
from trading_app.backtester.engine import Backtester
from trading_app.backtester.metrics import monte_carlo
from trading_app.backtester.optimizer import grid_search, walk_forward
from trading_app.screener.screener import top_picks
from trading_app.risk.risk_manager import IntradayRiskManager
from trading_app.ml import PPSModel, MODEL_PATH, build_features
from trading_app.ml.win_predictor import PPSWinPredictor, WIN_PATH, PCT5_PATH

log = logging.getLogger(__name__)

# ── app + static ──────────────────────────────────────────────
FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"

app = FastAPI(title="Trading Lab API", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


# ─────────────────────────────────────────────────────────────
#  Confidence calculator
#  Returns 50-99 % depending on signal quality:
#    - Master Confluence: uses score / 8
#    - Others: uses risk:reward ratio (capped) + ATR-volatility bonus
# ─────────────────────────────────────────────────────────────
def _confidence(row: pd.Series, strategy_name: str) -> int:
    reason = str(row.get("reason", ""))
    # Master: "Master long (score 6/8)" — pull the numerator
    if "Master" in strategy_name and "score" in reason:
        try:
            n = int(reason.split("score ")[1].split("/")[0])
            return int(round(50 + n * 5))           # 50 → 90
        except Exception:
            pass

    try:
        entry  = float(row["close"])
        stop   = float(row["stop"])
        target = float(row["target"])
        rr     = abs(target - entry) / max(abs(entry - stop), 1e-9)
    except Exception:
        return 70

    # base from R:R: 1:1→55, 1:3→75, 1:5→85, capped 95
    conf = 50 + min(rr * 10, 45)
    return int(round(min(99, max(50, conf))))


# ─────────────────────────────────────────────────────────────
#  Pages: HTML
# ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    idx = FRONTEND_DIR / "index.html"
    if not idx.exists():
        raise HTTPException(500, "frontend/index.html missing")
    return FileResponse(str(idx))


# ─────────────────────────────────────────────────────────────
#  /api/meta — everything the frontend needs at boot
# ─────────────────────────────────────────────────────────────
@app.get("/api/meta")
def meta() -> Dict[str, Any]:
    return {
        "symbols": {
            "equity": config.NSE_STOCKS,
            "crypto": config.CRYPTO,
        },
        "intervals": ["5m", "15m", "1h", "1d"],
        "strategies": [
            {"id": cls_name, "num": num, "label": label}
            for (num, cls_name, label) in NUMBERED_STRATEGIES
        ],
        "config": {
            "capital":            config.CAPITAL,
            "daily_target":       config.DAILY_PROFIT_TARGET,
            "max_daily_loss":     config.MAX_DAILY_LOSS,
            "max_risk_per_trade": config.MAX_RISK_PER_TRADE,
        },
        "theme": config.THEME,
    }


# ─────────────────────────────────────────────────────────────
#  /api/chart-data — OHLCV + per-bar signal + confidence
#  Used by the Pattern Analysis page
# ─────────────────────────────────────────────────────────────
@app.get("/api/chart-data")
def chart_data(
    symbol:    str = "RELIANCE.NS",
    interval:  str = "5m",
    days:      int = 10,
    strategy:  str = "OpeningRangeBreakout",
):
    if strategy not in STRAT_MAP:
        raise HTTPException(404, f"unknown strategy {strategy}")
    df = fetch(symbol, interval=interval, days=days)
    if df.empty:
        return {"error": "no data", "symbol": symbol}
    df = to_ist(df) if interval in ("5m", "15m") else df

    sig = STRAT_MAP[strategy]().run(df)
    plot = df.join(sig, how="left").copy()
    plot["signal"] = plot["signal"].fillna(0).astype(int)

    # candles
    candles = {
        "time":   [t.isoformat() for t in plot.index],
        "open":   plot["open"].round(2).tolist(),
        "high":   plot["high"].round(2).tolist(),
        "low":    plot["low"].round(2).tolist(),
        "close":  plot["close"].round(2).tolist(),
        "volume": plot["volume"].astype(int).tolist(),
    }

    # markers
    buys, sells = [], []
    for ts, row in plot[plot["signal"] != 0].iterrows():
        item = {
            "time":   ts.isoformat(),
            "price":  float(row["close"]),
            "stop":   float(row["stop"])   if pd.notna(row["stop"])   else None,
            "target": float(row["target"]) if pd.notna(row["target"]) else None,
            "reason": str(row.get("reason", "")),
            "confidence": _confidence(row, strategy),
            "low":    float(row["low"]),
            "high":   float(row["high"]),
        }
        if row["signal"] == 1:
            buys.append(item)
        else:
            sells.append(item)

    # HOLD samples — return every ~Nth HOLD bar so the front-end can
    # render them without flooding (N chosen so we send <=40 of each)
    hold_idx = plot.index[plot["signal"] == 0]
    if len(hold_idx) > 40:
        step = max(1, len(hold_idx) // 40)
        hold_idx = hold_idx[::step]
    holds = [{
        "time":  t.isoformat(),
        "price": float((plot.at[t, "high"] + plot.at[t, "low"]) / 2),
    } for t in hold_idx]

    # current price line + key level (VWAP-ish midpoint of session high/low)
    last_price = float(plot["close"].iloc[-1])
    key_level  = float((plot["high"].max() + plot["low"].min()) / 2)

    last_sig = int(plot["signal"].iloc[-1])
    last_state = "BUY" if last_sig == 1 else "SELL" if last_sig == -1 else "HOLD"

    return {
        "symbol":     symbol,
        "interval":   interval,
        "strategy":   strategy,
        "candles":    candles,
        "buys":       buys,
        "sells":      sells,
        "holds":      holds,
        "key_level":  round(key_level, 2),
        "last_price": round(last_price, 2),
        "last_state": last_state,
        "counts": {
            "buy":  len(buys),
            "sell": len(sells),
            "hold": int((plot["signal"] == 0).sum()),
        },
    }


# ─────────────────────────────────────────────────────────────
#  /api/live-signals — one badge per strategy for the latest bar
# ─────────────────────────────────────────────────────────────
@app.get("/api/live-signals")
def live_signals(symbol: str = "RELIANCE.NS", interval: str = "5m"):
    df = fetch(symbol, interval=interval, days=5)
    if df.empty:
        return {"error": "no data"}
    df = to_ist(df) if interval in ("5m", "15m") else df

    rows = []
    for cls in ALL_STRATEGIES:
        s   = cls()
        sig = s.run(df)
        last = sig.iloc[-1]
        v    = int(last["signal"])
        state = "BUY" if v == 1 else "SELL" if v == -1 else "HOLD"
        rows.append({
            "strategy":   cls.__name__,
            "state":      state,
            "entry":      float(df["close"].iloc[-1]) if v != 0 else None,
            "stop":       float(last["stop"])   if v != 0 and pd.notna(last["stop"])   else None,
            "target":     float(last["target"]) if v != 0 and pd.notna(last["target"]) else None,
            "reason":     str(last.get("reason", "")),
            "confidence": _confidence(last, cls.__name__) if v != 0 else 0,
        })
    return {
        "symbol":    symbol,
        "last_price": float(df["close"].iloc[-1]),
        "rows":       rows,
    }


# ─────────────────────────────────────────────────────────────
#  /api/backtest — full per-strategy backtest
# ─────────────────────────────────────────────────────────────
class BTReq(BaseModel):
    symbol:     str = "RELIANCE.NS"
    interval:   str = "5m"
    days:       int = 15
    strategies: List[str] = []


def _f(x):
    """JSON-safe finite float."""
    if x is None: return None
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


@app.post("/api/backtest")
def backtest(req: BTReq):
    df = fetch(req.symbol, interval=req.interval, days=req.days)
    if df.empty:
        raise HTTPException(404, f"no data for {req.symbol}")
    df = to_ist(df) if req.interval in ("5m", "15m") else df

    strats = req.strategies or [c.__name__ for c in ALL_STRATEGIES]
    out    = []
    equity_curves = {}
    for name in strats:
        cls = STRAT_MAP.get(name)
        if not cls:
            continue
        sig = cls().run(df)
        res = Backtester(intraday=req.interval in ("5m", "15m")).run(df, sig)
        m   = res["metrics"]
        out.append({
            "strategy":      name,
            "trades":        m["total_trades"],
            "win_rate":      _f(m["win_rate"]),
            "total_return":  _f(m["total_return"]),
            "sharpe":        _f(m["sharpe"]),
            "profit_factor": _f(m["profit_factor"]),
            "max_drawdown":  _f(m["max_drawdown"]),
            "days_5pct":     int(m["days_5pct"]),
        })
        # downsample equity curve for transfer
        eq = res["equity"]
        if len(eq) > 200:
            eq = eq.iloc[:: max(1, len(eq) // 200)]
        equity_curves[name] = {
            "time":   [t.isoformat() for t in eq.index],
            "equity": [_f(v) for v in eq.values],
        }
    return {"rows": out, "equity": equity_curves}


# ─────────────────────────────────────────────────────────────
#  /api/screener — pre-market top-N picks
# ─────────────────────────────────────────────────────────────
@app.get("/api/screener")
def screener(n: int = 5):
    try:
        df = top_picks(n=n)
    except Exception as e:
        return {"error": str(e), "rows": []}
    if df.empty:
        return {"rows": []}
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "symbol":       r["symbol"],
            "last_close":   _f(r["last_close"]),
            "gap_pct":      _f(r["gap_pct"]),
            "vol_ratio":    _f(r["vol_ratio"]),
            "atr_pct":      _f(r["atr_pct"]),
            "rel_strength": _f(r["rel_strength"]),
            "sr_high":      _f(r["sr_high"]),
            "sr_low":       _f(r["sr_low"]),
            "recommended":  r["recommended"],
            "confidence":   _f(r["confidence"]),
        })
    return {"rows": rows}


# ─────────────────────────────────────────────────────────────
#  /api/optimize — grid search + walk-forward
# ─────────────────────────────────────────────────────────────
class OptReq(BaseModel):
    symbol:    str = "RELIANCE.NS"
    interval:  str = "5m"
    days:      int = 15
    strategy:  str = "OpeningRangeBreakout"
    grid:      Dict[str, List[Any]] = {}


# ─────────────────────────────────────────────────────────────
#  /api/ml-predict — model-driven BUY/SELL/HOLD with confidence
#  Loads the trained PPSModel once, then for each bar returns the
#  predicted class (-1, 0, +1) and the per-class probability.
# ─────────────────────────────────────────────────────────────
_ml_cache: Dict[str, Any] = {"model": None, "win": None, "pct5": None}

def _get_ml_model() -> Optional[PPSModel]:
    if _ml_cache["model"] is None:
        _ml_cache["model"] = PPSModel.load(MODEL_PATH)
    return _ml_cache["model"]


def _get_win_model() -> Optional[PPSWinPredictor]:
    if _ml_cache["win"] is None:
        _ml_cache["win"] = PPSWinPredictor.load(WIN_PATH)
    return _ml_cache["win"]


def _get_5pct_model() -> Optional[PPSWinPredictor]:
    if _ml_cache["pct5"] is None:
        _ml_cache["pct5"] = PPSWinPredictor.load(PCT5_PATH)
    return _ml_cache["pct5"]


@app.get("/api/ml-status")
def ml_status() -> Dict[str, Any]:
    m = _get_ml_model()
    if m is None:
        return {"loaded": False, "path": str(MODEL_PATH),
                "hint": "run: python -m trading_app.ml.trainer"}
    return {
        "loaded": True,
        "version": m.version,
        "features": m.feature_cols,
        "metrics": m.metrics,
    }


@app.get("/api/ml-predict")
def ml_predict(
    symbol:   str   = "RELIANCE.NS",
    interval: str   = "5m",
    days:     int   = 10,
    threshold: float = 0.50,   # min class probability to call a BUY/SELL
):
    """
    Returns candles + ML-predicted BUY/SELL/HOLD per bar with confidence.
    """
    model = _get_ml_model()
    if model is None:
        return {"error": "model not trained — run trainer first",
                "path": str(MODEL_PATH)}

    df = fetch(symbol, interval=interval, days=days)
    if df.empty:
        return {"error": "no data", "symbol": symbol}
    df = to_ist(df) if interval in ("5m", "15m") else df

    X = build_features(df)
    if X.empty:
        return {"error": "not enough bars to compute features"}

    proba = model.predict_proba(X)
    df_aligned = df.loc[X.index].copy()

    candles = {
        "time":   [t.isoformat() for t in df.index],
        "open":   df["open"].round(2).tolist(),
        "high":   df["high"].round(2).tolist(),
        "low":    df["low"].round(2).tolist(),
        "close":  df["close"].round(2).tolist(),
        "volume": df["volume"].astype(int).tolist(),
    }

    buys, sells = [], []
    for ts, row in proba.iterrows():
        p_buy  = float(row.get("buy",  0.0))
        p_sell = float(row.get("sell", 0.0))
        p_hold = float(row.get("hold", 0.0))
        ohlc   = df_aligned.loc[ts]
        # only emit a BUY/SELL marker when the class probability beats threshold
        if p_buy >= threshold and p_buy >= p_sell:
            buys.append({
                "time":       ts.isoformat(),
                "price":      float(ohlc["close"]),
                "low":        float(ohlc["low"]),
                "high":       float(ohlc["high"]),
                "confidence": int(round(p_buy * 100)),
                "p_buy":      round(p_buy, 3),
                "p_sell":     round(p_sell, 3),
                "p_hold":     round(p_hold, 3),
                "reason":     "ML BUY",
                "stop":       float(ohlc["low"]  * 0.99),
                "target":     float(ohlc["close"] * 1.02),
            })
        elif p_sell >= threshold and p_sell > p_buy:
            sells.append({
                "time":       ts.isoformat(),
                "price":      float(ohlc["close"]),
                "low":        float(ohlc["low"]),
                "high":       float(ohlc["high"]),
                "confidence": int(round(p_sell * 100)),
                "p_buy":      round(p_buy, 3),
                "p_sell":     round(p_sell, 3),
                "p_hold":     round(p_hold, 3),
                "reason":     "ML SELL",
                "stop":       float(ohlc["high"] * 1.01),
                "target":     float(ohlc["close"] * 0.98),
            })

    # HOLD sample (top 40 most confident HOLDs)
    hold_rows = proba[proba["hold"] > 0.5].copy()
    hold_rows = hold_rows.sort_values("hold", ascending=False).head(40)
    holds = []
    for ts, row in hold_rows.iterrows():
        ohlc = df_aligned.loc[ts]
        holds.append({
            "time":  ts.isoformat(),
            "price": float((ohlc["high"] + ohlc["low"]) / 2),
            "confidence": int(round(float(row["hold"]) * 100)),
        })

    last_ts   = proba.index[-1]
    last_row  = proba.iloc[-1]
    last_p    = {"buy": float(last_row.get("buy",0)),
                 "sell": float(last_row.get("sell",0)),
                 "hold": float(last_row.get("hold",0))}
    last_label = max(last_p, key=last_p.get).upper()

    return {
        "symbol":     symbol,
        "interval":   interval,
        "model_version": model.version,
        "candles":    candles,
        "buys":       buys,
        "sells":      sells,
        "holds":      holds,
        "last_price": float(df["close"].iloc[-1]),
        "last_state": last_label,
        "last_proba": last_p,
        "key_level":  float((df["high"].max() + df["low"].min()) / 2),
        "counts": {
            "buy":  len(buys),
            "sell": len(sells),
            "hold": int((proba["hold"] >= 0.5).sum()) if "hold" in proba else 0,
        },
        "threshold":  threshold,
    }


# ─────────────────────────────────────────────────────────────
#  /api/ml-win-predict — the 90 % accuracy endpoint
#
#  Pipeline:
#    1. fetch OHLCV
#    2. run all 4 book strategies → candidate signals
#    3. for each candidate, build features and ask PPSWinPredictor
#       "will this signal win?" (binary win probability)
#    4. only emit BUY/SELL markers where p(win) >= threshold (default 0.65,
#       which the trainer's confidence curve says yields 92 % accuracy)
# ─────────────────────────────────────────────────────────────
@app.get("/api/ml-win-status")
def ml_win_status() -> Dict[str, Any]:
    m = _get_win_model()
    if m is None:
        return {"loaded": False, "path": str(WIN_PATH),
                "hint": "run: python -m trading_app.ml.win_predictor"}
    return {
        "loaded": True,
        "version": m.version,
        "metrics": m.metrics,
        "features": m.feature_cols,
    }


@app.get("/api/ml-win-predict")
def ml_win_predict(
    symbol:    str   = "RELIANCE.NS",
    interval:  str   = "5m",
    days:      int   = 10,
    threshold: float = 0.65,
):
    """High-accuracy signal endpoint — only emits when win-probability is high."""
    from trading_app.strategies.book_strategies import (
        SymmetricalTriangle, AscendingTriangle,
        RisingWedgeShort, DoubleTopMinor,
    )
    BOOK = [SymmetricalTriangle, AscendingTriangle,
            RisingWedgeShort, DoubleTopMinor]

    win = _get_win_model()
    if win is None:
        return {"error": "win-predictor not trained — run trainer first",
                "path": str(WIN_PATH)}

    df = fetch(symbol, interval=interval, days=days)
    if df.empty:
        return {"error": "no data", "symbol": symbol}
    df = to_ist(df) if interval in ("5m", "15m") else df

    feats = build_features(df)
    if feats.empty:
        return {"error": "not enough bars for features"}

    candles = {
        "time":   [t.isoformat() for t in df.index],
        "open":   df["open"].round(2).tolist(),
        "high":   df["high"].round(2).tolist(),
        "low":    df["low"].round(2).tolist(),
        "close":  df["close"].round(2).tolist(),
        "volume": df["volume"].astype(int).tolist(),
    }

    buys, sells, rejected = [], [], []
    for cls in BOOK:
        sig = cls().run(df)
        for ts, row in sig[sig["signal"] != 0].iterrows():
            if ts not in feats.index:
                continue
            side  = int(row["signal"])
            x     = feats.loc[[ts]]
            p_win = float(win.predict_proba(x)["win"].iloc[0])

            entry  = float(df.at[ts, "close"])
            stop   = float(row["stop"])   if pd.notna(row["stop"])   else None
            target = float(row["target"]) if pd.notna(row["target"]) else None

            item = {
                "time":       ts.isoformat(),
                "price":      entry,
                "low":        float(df.at[ts, "low"]),
                "high":       float(df.at[ts, "high"]),
                "stop":       stop,
                "target":     target,
                "p_win":      round(p_win, 3),
                "confidence": int(round(p_win * 100)),
                "strategy":   cls.__name__,
                "reason":     str(row.get("reason", "")),
            }
            if p_win < threshold:
                rejected.append({**item, "side": "BUY" if side == 1 else "SELL"})
                continue
            (buys if side == 1 else sells).append(item)

    last_price = float(df["close"].iloc[-1])
    return {
        "symbol":     symbol,
        "interval":   interval,
        "model_version": win.version,
        "threshold":  threshold,
        "candles":    candles,
        "buys":       buys,
        "sells":      sells,
        "rejected":   rejected[:50],
        "last_price": last_price,
        "key_level":  float((df["high"].max() + df["low"].min()) / 2),
        "counts":     {
            "buy": len(buys), "sell": len(sells),
            "rejected_total": len(rejected),
            "candidates_seen": len(buys) + len(sells) + len(rejected),
        },
        "model_metrics": {
            "out_of_sample_accuracy": win.metrics.get("out_of_sample_accuracy"),
            "base_rate":              win.metrics.get("base_rate"),
            "recommended_threshold":  win.metrics.get("recommended_threshold"),
        },
    }


# ─────────────────────────────────────────────────────────────
#  /api/ml-5pct-predict — "will this signal hit +5% before −2% ?"
#
#  Uses the dedicated 5%-target PPSWinPredictor model. Returns
#  only the book signals where p(hit 5%) >= threshold.
#  Default τ=0.85 → ~75% precision at 7% base rate (11× lift).
# ─────────────────────────────────────────────────────────────
@app.get("/api/ml-5pct-status")
def ml_5pct_status() -> Dict[str, Any]:
    m = _get_5pct_model()
    if m is None:
        return {"loaded": False, "path": str(PCT5_PATH),
                "hint": "run: python -m trading_app.ml.win_predictor --mode 5pct"}
    return {
        "loaded":   True,
        "version":  m.version,
        "metrics":  m.metrics,
        "features": m.feature_cols,
    }


@app.get("/api/ml-5pct-predict")
def ml_5pct_predict(
    symbol:    str   = "RELIANCE.NS",
    interval:  str   = "5m",
    days:      int   = 10,
    threshold: float = 0.85,    # the high-confidence band (~75% precision)
):
    from trading_app.strategies.book_strategies import (
        SymmetricalTriangle, AscendingTriangle,
        RisingWedgeShort, DoubleTopMinor,
    )
    BOOK = [SymmetricalTriangle, AscendingTriangle,
            RisingWedgeShort, DoubleTopMinor]

    model = _get_5pct_model()
    if model is None:
        return {"error": "5pct model not trained",
                "hint":  "python -m trading_app.ml.win_predictor --mode 5pct"}

    df = fetch(symbol, interval=interval, days=days)
    if df.empty:
        return {"error": "no data"}
    df = to_ist(df) if interval in ("5m", "15m") else df
    feats = build_features(df)
    if feats.empty:
        return {"error": "not enough bars for features"}

    candles = {
        "time":   [t.isoformat() for t in df.index],
        "open":   df["open"].round(2).tolist(),
        "high":   df["high"].round(2).tolist(),
        "low":    df["low"].round(2).tolist(),
        "close":  df["close"].round(2).tolist(),
        "volume": df["volume"].astype(int).tolist(),
    }

    buys, sells, rejected = [], [], []
    for cls in BOOK:
        sig = cls().run(df)
        for ts, row in sig[sig["signal"] != 0].iterrows():
            if ts not in feats.index:
                continue
            side  = int(row["signal"])
            x     = feats.loc[[ts]]
            p_hit = float(model.predict_proba(x)["win"].iloc[0])
            entry = float(df.at[ts, "close"])

            # synthesize a +5% target / -2% stop in the strategy's direction
            if side == 1:
                tgt5  = entry * 1.05
                stop2 = entry * 0.98
            else:
                tgt5  = entry * 0.95
                stop2 = entry * 1.02

            item = {
                "time":       ts.isoformat(),
                "price":      entry,
                "low":        float(df.at[ts, "low"]),
                "high":       float(df.at[ts, "high"]),
                "stop":       stop2,
                "target":     tgt5,
                "p_hit_5pct": round(p_hit, 3),
                "confidence": int(round(p_hit * 100)),
                "strategy":   cls.__name__,
                "reason":     str(row.get("reason", "")) + "  +ML(5%)",
            }
            if p_hit < threshold:
                rejected.append({**item, "side": "BUY" if side == 1 else "SELL"})
                continue
            (buys if side == 1 else sells).append(item)

    return {
        "symbol":         symbol,
        "interval":       interval,
        "model_version":  model.version,
        "threshold":      threshold,
        "candles":        candles,
        "buys":           buys,
        "sells":          sells,
        "rejected":       rejected[:30],
        "last_price":     float(df["close"].iloc[-1]),
        "key_level":      float((df["high"].max() + df["low"].min()) / 2),
        "counts": {
            "buy":              len(buys),
            "sell":             len(sells),
            "rejected_total":   len(rejected),
            "candidates_seen":  len(buys) + len(sells) + len(rejected),
        },
        "model_metrics": {
            "out_of_sample_accuracy": model.metrics.get("out_of_sample_accuracy"),
            "base_rate":              model.metrics.get("base_rate"),
            "recommended_threshold":  model.metrics.get("recommended_threshold"),
            "target_pct":             model.metrics.get("target_pct"),
            "stop_pct":               model.metrics.get("stop_pct"),
        },
    }


@app.post("/api/optimize")
def optimize(req: OptReq):
    cls = STRAT_MAP.get(req.strategy)
    if not cls:
        raise HTTPException(404, "unknown strategy")
    df = fetch(req.symbol, interval=req.interval, days=req.days)
    if df.empty:
        raise HTTPException(404, "no data")
    df = to_ist(df) if req.interval in ("5m", "15m") else df

    gs = grid_search(cls, df, req.grid, target="sharpe")
    wf = walk_forward(cls, df, req.grid)
    return {
        "grid": [
            {**{k: _f(v) for k, v in row.items()}}
            for row in gs.head(50).to_dict(orient="records")
        ],
        "walk_forward": {
            "best_params":   {k: _f(v) if isinstance(v, (int, float)) else v
                              for k, v in wf["best_params"].items()},
            "train_metrics": {k: _f(v) if not isinstance(v, int) else v
                              for k, v in wf["train_metrics"].items()},
            "test_metrics":  {k: _f(v) if not isinstance(v, int) else v
                              for k, v in wf["test_metrics"].items()},
        },
    }
