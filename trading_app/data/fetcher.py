"""
Data fetcher — yfinance (equity) + ccxt (crypto fallback).

Public API:
    fetch(symbol, interval="5m", days=30) -> pd.DataFrame
        Columns: open, high, low, close, volume   (lowercase, tz-aware UTC)
        Index:   DatetimeIndex (UTC)

Caches to disk to avoid hammering yfinance during dev / tests.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd

try:
    import yfinance as yf
except ImportError:                                         # pragma: no cover
    yf = None

from .. import config

log = logging.getLogger(__name__)


# ── helpers ────────────────────────────────────────────────────
def _cache_path(symbol: str, interval: str, days: int) -> Path:
    safe = symbol.replace("/", "_").replace("^", "")
    return config.DATA_DIR / f"{safe}_{interval}_{days}d.parquet"


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    """yfinance sometimes returns MultiIndex columns — flatten + lowercase."""
    if df.empty:
        return df
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower)
    keep = [c for c in ("open", "high", "low", "close", "volume") if c in df.columns]
    df = df[keep].copy()
    df = df.dropna()
    # ensure tz-aware UTC
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")
    df.index.name = "datetime"
    return df


# ── public API ─────────────────────────────────────────────────
def fetch(
    symbol: str,
    interval: str = "5m",
    days: int = 30,
    use_cache: bool = True,
) -> pd.DataFrame:
    """
    Fetch OHLCV. Returns empty DataFrame on failure (never raises).
    """
    cache = _cache_path(symbol, interval, days)
    if use_cache and cache.exists():
        try:
            df = pd.read_parquet(cache)
            if not df.empty:
                return df
        except Exception as e:                              # pragma: no cover
            log.warning("Cache read failed for %s: %s", symbol, e)

    if yf is None:                                          # pragma: no cover
        log.error("yfinance not installed")
        return pd.DataFrame()

    end   = datetime.utcnow()
    start = end - timedelta(days=days)

    try:
        df = yf.download(
            symbol,
            start=start,
            end=end,
            interval=interval,
            progress=False,
            auto_adjust=False,
            threads=False,
        )
    except Exception as e:                                  # pragma: no cover
        log.error("yfinance download failed for %s: %s", symbol, e)
        return pd.DataFrame()

    df = _normalize(df)
    if not df.empty and use_cache:
        try:
            df.to_parquet(cache)
        except Exception:                                   # pragma: no cover
            pass
    return df


def fetch_many(
    symbols: list[str],
    interval: str = "5m",
    days: int = 30,
) -> dict[str, pd.DataFrame]:
    return {s: fetch(s, interval=interval, days=days) for s in symbols}


def to_ist(df: pd.DataFrame) -> pd.DataFrame:
    """Convert UTC index to Asia/Kolkata (IST) for intraday rules."""
    if df.empty:
        return df
    out = df.copy()
    out.index = out.index.tz_convert("Asia/Kolkata")
    return out


# ── CLI smoke test ─────────────────────────────────────────────
if __name__ == "__main__":                                  # pragma: no cover
    logging.basicConfig(level=logging.INFO)
    sym = "RELIANCE.NS"
    print(f"Fetching {sym} 5m ...")
    d = fetch(sym, interval="5m", days=7, use_cache=False)
    print(f"  rows: {len(d)}   range: {d.index.min()} → {d.index.max()}")
    print(d.tail(3))
