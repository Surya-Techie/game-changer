"""Flask app entrypoint for the signal-overlay demo.

Run:
    cd signal-overlay
    pip install -r requirements.txt
    python app.py
    # then open http://127.0.0.1:5001/?symbol=RELIANCE

The app exposes:
    GET /                       — chart page (defaults to ?symbol=RELIANCE)
    GET /api/chart/<symbol>     — ohlcv + signals bundle
    GET /api/signals/<symbol>   — signals only

It registers the chart blueprint and serves a small in-memory OHLCV
cache so the same symbol's data isn't refetched on every page reload.

Port: defaults to 5001 to dodge macOS's AirPlay Receiver, which grabs
port 5000. Override with FLASK_PORT env var if you need a different one.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Optional

import pandas as pd
from flask import Flask, render_template, request

import numpy as np

from routes.chart import chart_bp
import routes.chart as chart_module


def _synthetic_ohlcv(symbol: str, n: int = 180) -> pd.DataFrame:
    """Deterministic synthetic OHLCV — seeded by symbol name so each ticker
    renders a different but reproducible chart. Used only as a fallback when
    the real loader returns nothing."""
    seed = (sum(ord(c) for c in symbol) % 9999) + 1
    rng = np.random.default_rng(seed=seed)
    # Mix of small drift + occasional larger moves to give the pattern engine
    # real shapes to chew on (otherwise random walks rarely fire patterns).
    base = 100.0 + rng.integers(0, 1500) / 10
    drift = rng.normal(loc=0.04, scale=1.2, size=n)
    # Inject 3-4 "regime shifts" so morning/evening stars and engulfings can form.
    for k in range(rng.integers(3, 6)):
        s = int(rng.integers(20, n - 5))
        sign = 1.0 if rng.random() > 0.5 else -1.0
        drift[s:s + 3] += sign * rng.uniform(1.5, 3.0, size=3)
    close = base + np.cumsum(drift)
    open_ = np.concatenate([[close[0]], close[:-1]])
    high = np.maximum(open_, close) + rng.uniform(0.3, 1.5, size=n)
    low = np.minimum(open_, close) - rng.uniform(0.3, 1.5, size=n)
    vol = rng.integers(50_000, 800_000, size=n).astype(float)
    times = pd.date_range(end=pd.Timestamp.now().normalize(), periods=n, freq="B")
    return pd.DataFrame({
        "time": times,
        "open": open_, "high": high, "low": low, "close": close, "volume": vol,
    })


# ─── App factory ──────────────────────────────────────────────────────────

def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    # Reject NaN / inf in JSON output — RFC 7159 doesn't allow them and
    # browsers crash on JSON.parse. With this set, any NaN that slips
    # past the data layer will raise instead of corrupting the response.
    try:
        app.json.allow_nan = False  # type: ignore[attr-defined]  (Flask 3.x)
    except Exception:
        pass

    # Wrap the default load_ohlcv with a tiny in-memory cache so a page
    # refresh doesn't re-hit yfinance for the same symbol within 5 minutes.
    _ohlcv_cache: dict[str, tuple[pd.DataFrame, float]] = {}
    CACHE_TTL_SEC = 300.0
    original_loader = chart_module.load_ohlcv

    def cached_loader(symbol: str) -> Optional[pd.DataFrame]:
        sym = symbol.upper()
        now = time.time()
        hit = _ohlcv_cache.get(sym)
        if hit and (now - hit[1] < CACHE_TTL_SEC):
            return hit[0]
        df = original_loader(sym)
        if df is None or df.empty:
            # Synthetic-data fallback so the demo still renders when
            # yfinance is unreachable (CI / offline / rate-limited). Disable
            # in production by removing this branch.
            df = _synthetic_ohlcv(sym, n=180)
            logging.getLogger(__name__).warning(
                "load_ohlcv: yfinance unavailable for %s — falling back to synthetic data", sym
            )
        if df is not None and not df.empty:
            _ohlcv_cache[sym] = (df, now)
        return df

    chart_module.load_ohlcv = cached_loader

    app.register_blueprint(chart_bp)

    @app.get("/")
    def home():
        symbol = (request.args.get("symbol") or "RELIANCE").upper()
        return render_template("index.html", symbol=symbol)

    @app.get("/health")
    def health():
        return {"ok": True, "ts": time.time()}

    return app


if __name__ == "__main__":
    app = create_app()
    # Port 5001 by default — macOS Control Center's AirPlay Receiver grabs
    # :5000 on Sonoma/Sequoia and silently shadows your dev server. To use
    # a different port: FLASK_PORT=5050 python app.py
    port = int(os.environ.get("FLASK_PORT", "5001"))
    # debug=False so the auto-reloader doesn't spawn a second process while
    # we're poking the endpoints from another shell.
    app.run(host="127.0.0.1", port=port, debug=False)
