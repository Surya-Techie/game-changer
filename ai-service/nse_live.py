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


def _yf_ltp(symbol: str) -> Optional[dict]:
    """yfinance fast_info → same response shape as the NSE path.

    Adds the ``.NS`` suffix Yahoo expects. Pure-Python, no key required.
    """
    if not _YF_OK:
        return None
    ticker = symbol if symbol.endswith((".NS", ".BO")) else f"{symbol}.NS"
    try:
        t = _yf.Ticker(ticker)
        fi = t.fast_info
        ltp = float(getattr(fi, "last_price", 0) or 0)
        if ltp <= 0:
            return None
        prev = float(getattr(fi, "regular_market_previous_close", 0) or 0)
        day_high = float(getattr(fi, "day_high", ltp) or ltp)
        day_low = float(getattr(fi, "day_low", ltp) or ltp)
        open_p = float(getattr(fi, "open", ltp) or ltp)
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
