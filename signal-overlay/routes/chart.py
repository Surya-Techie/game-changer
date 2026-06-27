"""Flask blueprint — chart + signals endpoints.

Routes:
    GET /api/chart/<symbol>     → ohlcv + signals bundle for the chart
    GET /api/signals/<symbol>   → signals only (standalone, for backtester reuse)

Both endpoints share a single source-of-truth pipeline:
    load_ohlcv(symbol)  →  pattern_engine.detect_patterns(df)  →
    signal_aggregator.aggregate_signals(df, patterns)

Failure modes:
    • pattern_engine raises  → log + return empty signals (chart still renders).
    • load_ohlcv returns None → 404 with a JSON error body.
    • aggregate_signals raises → log + return empty signals.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Optional

import pandas as pd
from flask import Blueprint, abort, jsonify, request

# Project imports. The Flask app is expected to expose these modules at
# import-resolvable paths. Adjust the import lines to match your layout if
# you keep the engine in a `src/` package or similar.
try:
    from pattern_engine import detect_patterns  # type: ignore
except ImportError:  # pragma: no cover — give a clearer message at request time
    detect_patterns = None  # type: ignore[assignment]

from signal_aggregator import aggregate_signals


logger = logging.getLogger(__name__)
chart_bp = Blueprint("chart", __name__)


# ─── Data loader ──────────────────────────────────────────────────────────
# The Flask app may already have a data layer. This helper is the only
# place a different data source needs to be wired in. By default it tries
# yfinance as a sensible offline-friendly default; replace with your own
# DB / CSV / broker feed as needed.

def load_ohlcv(symbol: str) -> Optional[pd.DataFrame]:
    """Return an OHLCV DataFrame for `symbol` with a 'time' column.

    Expected columns: time (datetime-like), open, high, low, close, volume.
    Returns None when the symbol can't be fetched.
    """
    try:
        import yfinance as yf  # type: ignore
    except ImportError:
        logger.error("yfinance not installed and no alternate load_ohlcv configured")
        return None
    sym = symbol.upper().replace(".NS", "") + ".NS"
    try:
        hist = yf.Ticker(sym).history(period="6mo", interval="1d", auto_adjust=False)
    except Exception:
        logger.exception("load_ohlcv: yfinance fetch failed for %s", symbol)
        return None
    if hist is None or hist.empty:
        return None
    df = hist.rename(columns={
        "Open": "open", "High": "high", "Low": "low",
        "Close": "close", "Volume": "volume",
    })[["open", "high", "low", "close", "volume"]].copy()
    df["time"] = df.index
    return df.reset_index(drop=True)


# ─── Shared pipeline ──────────────────────────────────────────────────────

def _safe_float(v: Any) -> Optional[float]:
    """Coerce to float, returning None for NaN / inf / unparseable values.
    JSON forbids NaN; emitting it crashes the browser-side JSON.parse."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _ohlcv_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    """DataFrame → list of dicts the chart frontend expects.

    Skips any row whose OHLC fields can't be parsed to finite floats —
    yfinance occasionally returns NaN bars (holidays, freshly-listed
    tickers, last partial bar). Emitting them as `NaN` produces invalid
    JSON; emitting them as `null` confuses lightweight-charts. Dropping
    is the only safe option.
    """
    out: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        o = _safe_float(row.get("open"))
        h = _safe_float(row.get("high"))
        l = _safe_float(row.get("low"))
        c = _safe_float(row.get("close"))
        if None in (o, h, l, c):
            continue  # skip unusable bar — never feed NaN to the chart
        t = row.get("time")
        if isinstance(t, pd.Timestamp):
            t_iso = t.isoformat()
        elif hasattr(t, "isoformat"):
            t_iso = t.isoformat()
        else:
            t_iso = str(t)
        out.append({
            "time": t_iso,
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": _safe_float(row.get("volume")) or 0.0,
        })
    return out


def _build_signals(df: pd.DataFrame) -> list[dict]:
    """Run the pattern engine + aggregator. Errors → empty list (logged)."""
    if detect_patterns is None:
        logger.warning("pattern_engine.detect_patterns is not importable; returning empty signals")
        return []
    try:
        patterns = detect_patterns(df)
    except Exception:
        logger.exception("detect_patterns failed")
        return []
    try:
        return aggregate_signals(df, patterns or [])
    except Exception:
        logger.exception("aggregate_signals failed")
        return []


# ─── Routes ───────────────────────────────────────────────────────────────

@chart_bp.get("/api/chart/<symbol>")
def chart(symbol: str):
    df = load_ohlcv(symbol)
    if df is None or df.empty:
        return jsonify({"error": f"no OHLCV available for {symbol}"}), 404
    payload = {
        "ohlcv": _ohlcv_records(df),
        "signals": _build_signals(df),
    }
    return jsonify(payload)


@chart_bp.get("/api/signals/<symbol>")
def signals(symbol: str):
    """Standalone signal endpoint for the backtester / other consumers.

    Same `signals` array shape as the chart bundle, no OHLCV attached.
    """
    df = load_ohlcv(symbol)
    if df is None or df.empty:
        return jsonify({"error": f"no OHLCV available for {symbol}"}), 404
    return jsonify({"signals": _build_signals(df)})


def register(app):
    """Convenience helper: app.register_blueprint(chart_bp) and any future siblings."""
    app.register_blueprint(chart_bp)
