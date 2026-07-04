"""NSE live LTP fetcher with yfinance fallback.

Two-tier strategy:

1.  Try NSE's public quote endpoint
    (``/api/quote-equity?symbol=...``). It used to be free + near-real
    -time. As of 2025, NSE's Akamai layer aggressively returns 403 to
    any non-browser. We still try, because some deployment environments
    (residential IPs, certain ASNs) DO get through.

2.  Fall back to **yfinance** (Yahoo Finance) — no credentials, no 403
    issues, ~15-minute delayed for retail. For paper-trading + signal
    analysis on daily / swing horizons this is effectively live; for
    sub-minute scalping it is not. yfinance's ``fast_info.last_price``
    is a single HTTP call (~200 ms) so polling 20 symbols every few
    seconds is comfortable.

Both tiers populate the same response shape, with ``source`` set to
``nse`` | ``yfinance`` | ``cache`` so the caller can show data freshness
to the user. Returns ``None`` only when both tiers fail.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Optional

import httpx

_session = httpx.Client(
    headers={
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE",
        "Connection": "keep-alive",
    },
    follow_redirects=True,
    timeout=5.0,
)

_warmup_at = 0.0
_warmup_lock = threading.Lock()
_WARMUP_TTL = 300  # re-warm cookies every 5 minutes


def _warm() -> None:
    """Hit nseindia.com twice so the session picks up the access cookies."""
    global _warmup_at
    now = time.time()
    if now - _warmup_at < _WARMUP_TTL:
        return
    with _warmup_lock:
        if now - _warmup_at < _WARMUP_TTL:
            return
        try:
            _session.get("https://www.nseindia.com/")
            _session.get(
                "https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE"
            )
            _warmup_at = now
        except Exception:
            # Warmup failure is non-fatal — the actual fetch will retry.
            pass


_cache: dict[str, tuple[dict, float]] = {}
_cache_lock = threading.Lock()
_TTL = 2.0  # serve a cached LTP for 2 s before re-hitting NSE

# yfinance fallback is imported lazily because some deployments don't
# include yfinance (e.g. testing). When missing, fallback becomes a no-op
# and callers see ``None`` instead of an exception.
try:
    import yfinance as _yf  # type: ignore
    _YF_OK = True
except Exception:  # pragma: no cover
    _YF_OK = False


def _fin(x, fallback: float = 0.0) -> float:
    """Coerce to a finite float — yfinance loves returning NaN for illiquid
    (mostly BSE) names, and a single NaN makes FastAPI's JSON encoder 500
    the entire batch response."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return fallback
    import math
    return v if math.isfinite(v) else fallback


def _yf_ltp(symbol: str) -> Optional[dict]:
    """yfinance fast_info → same response shape as the NSE path.

    Adds the ``.NS`` suffix Yahoo expects. Pure-Python, no key required.
    """
    if not _YF_OK:
        return None
    symbol = _apply_rename(symbol)
    # Index tickers (^NSEI, ^BSESN, ^INDIAVIX, ^CNXIT, …) are used as-is;
    # equities get the .NS suffix Yahoo expects.
    if symbol.startswith("^"):
        ticker = symbol
    else:
        ticker = symbol if symbol.endswith((".NS", ".BO")) else f"{symbol}.NS"
    try:
        t = _yf.Ticker(ticker)
        fi = t.fast_info
        ltp = _fin(getattr(fi, "last_price", 0))
        if ltp <= 0:
            return None
        prev = _fin(getattr(fi, "regular_market_previous_close", 0))
        if prev <= 0:
            # BSE names often have NaN here but a valid previous_close.
            prev = _fin(getattr(fi, "previous_close", 0))
        day_high = _fin(getattr(fi, "day_high", ltp), ltp)
        day_low = _fin(getattr(fi, "day_low", ltp), ltp)
        open_p = _fin(getattr(fi, "open", ltp), ltp)
        change = ltp - prev if prev > 0 else 0.0
        pct = (change / prev * 100.0) if prev > 0 else 0.0
        return {
            "symbol": symbol.upper(),
            "ltp": ltp,
            "open": open_p,
            "high": day_high,
            "low": day_low,
            "prev_close": prev,
            "change": change,
            "pct_change": pct,
            "ts": int(time.time() * 1000),
            "source": "yfinance",
        }
    except Exception:
        return None


def fetch_nse_ltp(symbol: str) -> Optional[dict]:
    """Return a dict with NSE live data for ``symbol`` (e.g. 'RELIANCE').

    Shape::

        {
            "symbol": "RELIANCE",
            "ltp": 2856.10,
            "open": 2840.0,
            "high": 2872.3,
            "low":  2837.8,
            "prev_close": 2851.2,
            "change": 4.9,
            "pct_change": 0.17,
            "ts": 1717612340000,
            "source": "nse" | "cache",
        }

    Returns ``None`` if NSE has never been reachable for this symbol.
    """
    sym = symbol.upper().strip()
    now = time.time()

    cached = _cache.get(sym)
    if cached and now - cached[1] < _TTL:
        return {**cached[0], "source": "cache"}

    # Index tickers (^…) don't exist on NSE's equity-quote API — go straight
    # to the yfinance tier.
    if sym.startswith("^"):
        yf_result = _yf_ltp(sym)
        if yf_result:
            with _cache_lock:
                _cache[sym] = (yf_result, now)
            return yf_result
        return cached[0] if cached else None

    # ── Tier 1: try NSE direct ──────────────────────────────────────────
    _warm()
    try:
        resp = _session.get(
            f"https://www.nseindia.com/api/quote-equity?symbol={sym}"
        )
        if resp.status_code == 200:
            data = resp.json()
            info = data.get("priceInfo") or {}
            if info:
                intraday = info.get("intraDayHighLow") or {}
                result = {
                    "symbol": sym,
                    "ltp": _flt(info.get("lastPrice")),
                    "open": _flt(info.get("open")),
                    "high": _flt(intraday.get("max")),
                    "low": _flt(intraday.get("min")),
                    "prev_close": _flt(info.get("previousClose")),
                    "change": _flt(info.get("change")),
                    "pct_change": _flt(info.get("pChange")),
                    "ts": int(now * 1000),
                    "source": "nse",
                }
                with _cache_lock:
                    _cache[sym] = (result, now)
                return result
    except Exception:
        pass  # fall through to yfinance

    # ── Tier 2: yfinance (no credentials, ~15 min delayed) ─────────────
    yf_result = _yf_ltp(sym)
    if yf_result:
        with _cache_lock:
            _cache[sym] = (yf_result, now)
        return yf_result

    # Final fallback: stale cache if we have one, else None.
    return cached[0] if cached else None


_OPTION_INDEX_SYMBOLS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"}


def fetch_option_chain_raw(symbol: str, expiries_wanted: int = 3) -> Optional[dict]:
    """Raw NSE option-chain JSON for an equity or index symbol.

    Yahoo has NO options data for NSE listings, so this is the only real
    source for Indian option chains. NSE's legacy option-chain-equities
    endpoint now returns an empty body — the working flow (what the NSE
    site itself calls) is:
      1. /api/option-chain-contract-info?symbol=X   → expiry list
      2. /api/option-chain-v3?type=Equity&symbol=X&expiry=E  → one chain
         per expiry (type=Indices for NIFTY & friends).
    The result is normalised into the classic {records: {expiryDates,
    data[{strikePrice, expiryDate, CE, PE}], underlyingValue}} shape the
    chain builder consumes. Returns None on any failure.
    """
    sym = _apply_rename(symbol.upper().strip())
    kind = "Indices" if sym in _OPTION_INDEX_SYMBOLS else "Equity"
    hdr = {"Referer": "https://www.nseindia.com/option-chain", "Accept": "application/json"}
    _warm()
    try:
        info = _session.get(
            f"https://www.nseindia.com/api/option-chain-contract-info?symbol={sym}",
            headers=hdr, timeout=10,
        )
        if info.status_code != 200:
            return None
        expiries = (info.json() or {}).get("expiryDates") or []
        if not expiries:
            return None
        data_rows: list[dict] = []
        underlying = 0.0
        for exp in expiries[: max(1, expiries_wanted)]:
            r = _session.get(
                f"https://www.nseindia.com/api/option-chain-v3?type={kind}&symbol={sym}&expiry={exp}",
                headers=hdr, timeout=10,
            )
            if r.status_code != 200:
                continue
            rec = (r.json() or {}).get("records") or {}
            underlying = float(rec.get("underlyingValue") or underlying or 0.0)
            for row in rec.get("data") or []:
                row = dict(row)
                row["expiryDate"] = exp   # v3 rows don't carry it per-row
                data_rows.append(row)
        if not data_rows:
            return None
        return {"records": {"expiryDates": expiries, "data": data_rows, "underlyingValue": underlying}}
    except Exception:
        return None


def fetch_nse_batch(symbols: list[str]) -> dict[str, dict]:
    """Parallel batch fetch.

    For up to ~30 symbols Yahoo Finance handles concurrent requests
    cleanly (one ThreadPoolExecutor worker per symbol), turning what
    was 8+ seconds of sequential 400 ms fast_info calls into ~600 ms
    total. Cached symbols return instantly so cache-warm runs are
    sub-100 ms regardless of universe size.

    If the NSE-direct tier ever comes back online, fetch_nse_ltp() will
    transparently use it; the parallelism here only affects yfinance.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    out: dict[str, dict] = {}
    if not symbols:
        return out
    # Cap concurrency so we don't spawn an absurd number of threads on
    # very large universes — yfinance comfortably handles ~12 in parallel.
    max_workers = min(12, len(symbols))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(fetch_nse_ltp, s): s for s in symbols}
        for fut in as_completed(futures):
            s = futures[fut]
            try:
                r = fut.result(timeout=4.0)
                if r:
                    out[s.upper().strip()] = r
            except Exception:
                continue
    return out


def _flt(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


# --------------------------------------------------------------- history

_hist_cache: dict[str, tuple[list, float]] = {}
_hist_lock = threading.Lock()
_HIST_TTL = 120.0  # intraday history barely changes inside 2 minutes

# On-disk fallback: when yfinance rate-limits during a backend restart, a
# stale-but-real history file is far better than the synthetic fallback.
_HIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "history_cache")


def _hist_disk_path(key: str) -> str:
    return os.path.join(_HIST_DIR, key.replace("|", "_").replace("/", "_") + ".json")


def _hist_disk_read(key: str) -> list[dict]:
    try:
        with open(_hist_disk_path(key)) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        return []


def _hist_disk_write(key: str, candles: list[dict]) -> None:
    try:
        os.makedirs(_HIST_DIR, exist_ok=True)
        with open(_hist_disk_path(key), "w") as f:
            json.dump(candles, f)
    except Exception:  # noqa: BLE001 — cache write is best-effort
        pass


# Well-known NSE ticker renames — Yahoo drops the old symbol entirely, so
# requests for the old name would otherwise 404. Extend as renames happen.
_TICKER_RENAMES: dict[str, str] = {
    "ZOMATO": "ETERNAL",        # Zomato Ltd → Eternal Ltd (2025)
    "ADANITRANS": "ADANIENSOL",  # Adani Transmission → Adani Energy Solutions
    "MINDTREE": "LTIM",          # Mindtree merged into LTIMindtree
}


def _apply_rename(symbol: str) -> str:
    s = symbol.upper().strip()
    for suffix in (".NS", ".BO"):
        if s.endswith(suffix) and s[: -len(suffix)] in _TICKER_RENAMES:
            return _TICKER_RENAMES[s[: -len(suffix)]] + suffix
    return _TICKER_RENAMES.get(s, s)


def _exchange_twin(symbol: str) -> Optional[str]:
    """The same listing on the other exchange: X.BO ↔ X.NS (bare = .NS).
    Yahoo's BSE coverage is spotty — the NSE line usually has the data."""
    s = symbol.upper().strip()
    if s.startswith("^"):
        return None
    if s.endswith(".BO"):
        return s[:-3] + ".NS"
    if s.endswith(".NS"):
        return s[:-3] + ".BO"
    return s + ".BO"  # bare symbol defaults to .NS — twin is the BSE line


def fetch_history(symbol: str, interval: str = "1m", period: str = "5d", _try_twin: bool = True) -> list[dict]:
    """Real historical OHLCV candles for an NSE symbol via yfinance.

    Returns ``[{t, o, h, l, c, v}, ...]`` (epoch-ms, ascending) or ``[]``
    when unavailable. Used by the backend to warm the live candle store
    with REAL bars instead of synthetic ones, so indicators (SMA50, VWAP,
    ATR…) are meaningful from the very first signal after a restart.

    When the requested listing has no Yahoo data (common for BSE ``.BO``
    lines), the same symbol on the other exchange is tried automatically.
    """
    if not _YF_OK:
        return []
    sym = _apply_rename(symbol)
    key = f"{sym}|{interval}|{period}"
    now = time.time()
    with _hist_lock:
        cached = _hist_cache.get(key)
        if cached and now - cached[1] < _HIST_TTL:
            return cached[0]
    if sym.startswith("^"):
        ticker = sym
    else:
        ticker = sym if sym.endswith((".NS", ".BO")) else f"{sym}.NS"
    try:
        df = _yf.Ticker(ticker).history(period=period, interval=interval)
        candles: list[dict] = []
        for ts, row in df.iterrows():
            o, h, l, c = _flt(row.get("Open")), _flt(row.get("High")), _flt(row.get("Low")), _flt(row.get("Close"))
            if c <= 0:
                continue
            candles.append({
                "t": int(ts.timestamp() * 1000),
                "o": o, "h": h, "l": l, "c": c,
                "v": _flt(row.get("Volume")),
            })
    except Exception:
        # Rate-limited / network error → serve the last good on-disk copy.
        disk = _hist_disk_read(key)
        if disk:
            return disk
        twin = _exchange_twin(sym) if _try_twin else None
        return fetch_history(twin, interval, period, _try_twin=False) if twin else []
    # Don't memory-cache failures — an empty frame usually means yfinance is
    # rate-limiting; let the next caller retry immediately (but do serve the
    # on-disk copy so callers still get real bars).
    if candles:
        with _hist_lock:
            _hist_cache[key] = (candles, now)
        _hist_disk_write(key, candles)
        return candles
    disk = _hist_disk_read(key)
    if disk:
        return disk
    # No data on this listing at all — try the other exchange's line once.
    twin = _exchange_twin(sym) if _try_twin else None
    return fetch_history(twin, interval, period, _try_twin=False) if twin else []
