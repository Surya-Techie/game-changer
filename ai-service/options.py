"""Options chain + Greeks for NSE symbols.

Data source: yfinance Ticker.option_chain() — same library we use for spot
prices in /price/{symbol}. Greeks computed with Black-Scholes using numpy
(no scipy dependency); erf() is an inline rational approximation
(Abramowitz & Stegun 7.1.26), accurate to ~1.5e-7 over the full range.

Endpoints exposed (mounted in main.py):
  GET  /options/chain/{symbol}                            — full chain
  GET  /options/greeks/{symbol}/{expiry}/{strike}/{kind}  — single-strike Greeks

Caveats:
  - yfinance Greeks are not always populated; we recompute them ourselves
    from underlying price + risk-free rate (default 7% INR) + days-to-expiry.
  - Implied vol comes from yfinance when available; if missing we derive
    it from option mid-price using a 60-iter bisection on Newton-Raphson.
"""
from __future__ import annotations

import math
import time as _time
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

try:
    import yfinance as _yf  # type: ignore
    _YF_OK = True
except Exception as _err:  # pragma: no cover
    _YF_OK = False

RISK_FREE_RATE_INR = 0.07  # 91-day T-bill proxy; configurable per request

# --------------------------------------------------------------------------
# Black-Scholes — pure numpy implementation
# --------------------------------------------------------------------------

def _erf(x: float) -> float:
    """Abramowitz & Stegun 7.1.26 — max error 1.5e-7."""
    sign = 1.0 if x >= 0 else -1.0
    x = abs(x)
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x)
    return sign * y


def _cdf(x: float) -> float:
    return 0.5 * (1.0 + _erf(x / math.sqrt(2.0)))


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bs_price(S: float, K: float, T: float, r: float, sigma: float, kind: Literal["CE", "PE"]) -> float:
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        # Intrinsic value at/after expiry.
        intrinsic = max(0.0, S - K) if kind == "CE" else max(0.0, K - S)
        return intrinsic
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    if kind == "CE":
        return S * _cdf(d1) - K * math.exp(-r * T) * _cdf(d2)
    return K * math.exp(-r * T) * _cdf(-d2) - S * _cdf(-d1)


def bs_greeks(S: float, K: float, T: float, r: float, sigma: float, kind: Literal["CE", "PE"]) -> Dict[str, float]:
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "rho": 0.0}
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    pdf_d1 = _pdf(d1)
    if kind == "CE":
        delta = _cdf(d1)
        theta = (
            -(S * pdf_d1 * sigma) / (2.0 * math.sqrt(T))
            - r * K * math.exp(-r * T) * _cdf(d2)
        )
        rho = K * T * math.exp(-r * T) * _cdf(d2)
    else:
        delta = -_cdf(-d1)
        theta = (
            -(S * pdf_d1 * sigma) / (2.0 * math.sqrt(T))
            + r * K * math.exp(-r * T) * _cdf(-d2)
        )
        rho = -K * T * math.exp(-r * T) * _cdf(-d2)
    gamma = pdf_d1 / (S * sigma * math.sqrt(T))
    vega = S * pdf_d1 * math.sqrt(T)
    # Convert theta to per-day, vega per 1% IV change, rho per 1% rate change.
    return {
        "delta": float(delta),
        "gamma": float(gamma),
        "theta": float(theta / 365.0),
        "vega": float(vega / 100.0),
        "rho": float(rho / 100.0),
    }


def implied_vol(S: float, K: float, T: float, r: float, price: float, kind: Literal["CE", "PE"]) -> Optional[float]:
    """Bisection-bracketed Newton-Raphson on BS price. Returns None on failure."""
    if T <= 0 or S <= 0 or K <= 0 or price <= 0:
        return None
    # Bracket: very low / very high vol.
    low, high = 1e-4, 5.0
    p_low = bs_price(S, K, T, r, low, kind)
    p_high = bs_price(S, K, T, r, high, kind)
    if not (min(p_low, p_high) <= price <= max(p_low, p_high)):
        # Price outside achievable BS range — most likely stale quote.
        return None
    sigma = 0.3
    for _ in range(50):
        bs = bs_price(S, K, T, r, sigma, kind)
        vega = S * _pdf(_d1(S, K, T, r, sigma)) * math.sqrt(T)
        if vega < 1e-8:
            break
        diff = bs - price
        if abs(diff) < 1e-5:
            return sigma
        new_sigma = sigma - diff / vega
        if new_sigma <= 0 or new_sigma > 5:
            # Fall back to bisection step.
            new_sigma = (low + high) / 2.0
        if bs > price:
            high = sigma
        else:
            low = sigma
        sigma = new_sigma
    return sigma


def _d1(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if sigma <= 0 or T <= 0:
        return 0.0
    return (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))


# --------------------------------------------------------------------------
# yfinance pull + chain assembly
# --------------------------------------------------------------------------

class StrikeRow(BaseModel):
    strike: float
    ce: Optional[Dict[str, Any]] = None
    pe: Optional[Dict[str, Any]] = None


class ChainExpiry(BaseModel):
    expiry: str               # YYYY-MM-DD
    days_to_expiry: int
    rows: List[StrikeRow]
    pcr: float                # put/call OI ratio
    max_pain: Optional[float] # strike with min total writer pain
    iv_avg: Optional[float]
    unusual_oi_strikes: List[float]   # strikes flagged as >2x avg OI


class OptionsChainResponse(BaseModel):
    symbol: str
    underlying: float
    fetched_at: int           # epoch ms
    expiries: List[ChainExpiry]


class GreeksResponse(BaseModel):
    symbol: str
    expiry: str
    strike: float
    kind: Literal["CE", "PE"]
    iv: Optional[float]
    iv_percentile: Optional[float]
    underlying: float
    price: float
    greeks: Dict[str, float]


_CHAIN_CACHE: Dict[str, Tuple[OptionsChainResponse, float]] = {}
_CHAIN_TTL = 300.0  # 5 minutes server-side cache


def _days_between(expiry_str: str, now: datetime) -> int:
    try:
        d = datetime.fromisoformat(expiry_str).replace(tzinfo=timezone.utc)
    except ValueError:
        return 0
    return max(0, (d.date() - now.date()).days)


def _max_pain(strikes: List[float], ce_oi: Dict[float, float], pe_oi: Dict[float, float]) -> Optional[float]:
    """Returns the strike at which total option-writer pain is minimised.
    Pain(K) = sum over strikes of max(K_expiry - K_strike, 0) * OI weights."""
    if not strikes:
        return None
    pain = []
    for K in strikes:
        # Writers of CE at strike s lose if expiry > s: (expiry - s) * oi
        # Writers of PE at strike s lose if expiry < s: (s - expiry) * oi
        total = 0.0
        for s in strikes:
            if K > s:
                total += (K - s) * ce_oi.get(s, 0.0)
            elif K < s:
                total += (s - K) * pe_oi.get(s, 0.0)
        pain.append((K, total))
    pain.sort(key=lambda x: x[1])
    return float(pain[0][0])


def _unusual_oi(strikes: List[float], oi_map: Dict[float, float], threshold: float = 2.0) -> List[float]:
    vals = [oi_map.get(s, 0.0) for s in strikes if oi_map.get(s, 0.0) > 0]
    if not vals:
        return []
    avg = float(np.mean(vals))
    if avg <= 0:
        return []
    return [s for s in strikes if oi_map.get(s, 0.0) >= avg * threshold]


def _ticker_underlying_price(t: Any) -> Optional[float]:
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
    try:
        hist = t.history(period="1d", interval="1m")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception:
        pass
    return None


def build_chain(symbol: str, expiries_wanted: int = 3) -> OptionsChainResponse:
    if not _YF_OK:
        raise HTTPException(status_code=503, detail="yfinance not installed")
    sym = symbol.upper()
    if not (sym.endswith(".NS") or sym.endswith(".BO")):
        sym = sym + ".NS"
    ticker = _yf.Ticker(sym)
    spot = _ticker_underlying_price(ticker)
    if spot is None or spot <= 0:
        raise HTTPException(status_code=404, detail=f"No spot price for {symbol}")
    try:
        all_exp = list(ticker.options or [])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"yfinance error: {e}")
    if not all_exp:
        raise HTTPException(status_code=404, detail=f"No options listed for {symbol}")
    chosen = all_exp[:expiries_wanted]
    now = datetime.now(timezone.utc)

    expiries_out: List[ChainExpiry] = []
    for exp in chosen:
        dte = _days_between(exp, now)
        T = max(dte, 1) / 365.0
        try:
            chain = ticker.option_chain(exp)
        except Exception:
            continue
        calls = chain.calls
        puts = chain.puts

        strikes = sorted(set(map(float, list(calls["strike"]) + list(puts["strike"]))))
        ce_by_k = {float(r["strike"]): r for _, r in calls.iterrows()}
        pe_by_k = {float(r["strike"]): r for _, r in puts.iterrows()}

        rows: List[StrikeRow] = []
        iv_samples: List[float] = []
        ce_oi_map: Dict[float, float] = {}
        pe_oi_map: Dict[float, float] = {}
        ce_oi_total = 0.0
        pe_oi_total = 0.0

        for K in strikes:
            ce_dict: Optional[Dict[str, Any]] = None
            pe_dict: Optional[Dict[str, Any]] = None
            if K in ce_by_k:
                row = ce_by_k[K]
                last = float(row.get("lastPrice", 0.0) or 0.0)
                bid = float(row.get("bid", 0.0) or 0.0)
                ask = float(row.get("ask", 0.0) or 0.0)
                mid = (bid + ask) / 2.0 if (bid > 0 and ask > 0) else last
                oi = float(row.get("openInterest", 0) or 0)
                vol = float(row.get("volume", 0) or 0)
                iv = float(row.get("impliedVolatility", 0) or 0)
                if iv <= 0 and mid > 0:
                    iv_calc = implied_vol(spot, K, T, RISK_FREE_RATE_INR, mid, "CE")
                    iv = iv_calc or 0.0
                if iv > 0:
                    iv_samples.append(iv)
                g = bs_greeks(spot, K, T, RISK_FREE_RATE_INR, max(iv, 1e-4), "CE")
                ce_dict = {
                    "ltp": last, "bid": bid, "ask": ask, "oi": oi, "volume": vol,
                    "iv": iv, **g,
                }
                ce_oi_map[K] = oi
                ce_oi_total += oi
            if K in pe_by_k:
                row = pe_by_k[K]
                last = float(row.get("lastPrice", 0.0) or 0.0)
                bid = float(row.get("bid", 0.0) or 0.0)
                ask = float(row.get("ask", 0.0) or 0.0)
                mid = (bid + ask) / 2.0 if (bid > 0 and ask > 0) else last
                oi = float(row.get("openInterest", 0) or 0)
                vol = float(row.get("volume", 0) or 0)
                iv = float(row.get("impliedVolatility", 0) or 0)
                if iv <= 0 and mid > 0:
                    iv_calc = implied_vol(spot, K, T, RISK_FREE_RATE_INR, mid, "PE")
                    iv = iv_calc or 0.0
                if iv > 0:
                    iv_samples.append(iv)
                g = bs_greeks(spot, K, T, RISK_FREE_RATE_INR, max(iv, 1e-4), "PE")
                pe_dict = {
                    "ltp": last, "bid": bid, "ask": ask, "oi": oi, "volume": vol,
                    "iv": iv, **g,
                }
                pe_oi_map[K] = oi
                pe_oi_total += oi
            rows.append(StrikeRow(strike=K, ce=ce_dict, pe=pe_dict))

        pcr = (pe_oi_total / ce_oi_total) if ce_oi_total > 0 else 0.0
        mp = _max_pain(strikes, ce_oi_map, pe_oi_map)
        unusual = sorted(set(_unusual_oi(strikes, ce_oi_map) + _unusual_oi(strikes, pe_oi_map)))
        iv_avg = float(np.mean(iv_samples)) if iv_samples else None

        expiries_out.append(ChainExpiry(
            expiry=exp,
            days_to_expiry=dte,
            rows=rows,
            pcr=round(pcr, 3),
            max_pain=mp,
            iv_avg=round(iv_avg, 4) if iv_avg is not None else None,
            unusual_oi_strikes=unusual,
        ))

    return OptionsChainResponse(
        symbol=symbol.upper(),
        underlying=spot,
        fetched_at=int(_time.time() * 1000),
        expiries=expiries_out,
    )


def cached_chain(symbol: str) -> OptionsChainResponse:
    key = symbol.upper()
    now = _time.time()
    cached = _CHAIN_CACHE.get(key)
    if cached and now - cached[1] < _CHAIN_TTL:
        return cached[0]
    fresh = build_chain(key)
    _CHAIN_CACHE[key] = (fresh, now)
    return fresh


router = APIRouter()


@router.get("/options/chain/{symbol}", response_model=OptionsChainResponse)
def get_chain(symbol: str):
    return cached_chain(symbol)


@router.get("/options/greeks/{symbol}/{expiry}/{strike}/{kind}", response_model=GreeksResponse)
def get_greeks(
    symbol: str,
    expiry: str,
    strike: float,
    kind: Literal["CE", "PE"],
    iv_override: Optional[float] = Query(default=None, ge=0.001, le=5.0),
    rate: float = Query(default=RISK_FREE_RATE_INR, ge=0.0, le=0.25),
):
    chain = cached_chain(symbol)
    target_exp = next((e for e in chain.expiries if e.expiry == expiry), None)
    if target_exp is None:
        raise HTTPException(status_code=404, detail=f"Expiry {expiry} not available")
    row = next((r for r in target_exp.rows if abs(r.strike - strike) < 1e-6), None)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Strike {strike} not in chain")
    side = row.ce if kind == "CE" else row.pe
    if side is None:
        raise HTTPException(status_code=404, detail=f"{kind} not listed at strike {strike}")

    iv = iv_override if iv_override is not None else float(side.get("iv", 0) or 0)
    iv = max(iv, 1e-4)
    T = max(target_exp.days_to_expiry, 1) / 365.0
    g = bs_greeks(chain.underlying, strike, T, rate, iv, kind)

    # IV percentile = where current iv sits in 52w range of this chain's expiry
    # average. We don't store historical IV, so percentile here is the position
    # of the strike's IV within the current expiry's IV distribution.
    samples: List[float] = []
    for r in target_exp.rows:
        for s in (r.ce, r.pe):
            v = float((s or {}).get("iv", 0) or 0)
            if v > 0:
                samples.append(v)
    iv_pct: Optional[float] = None
    if samples and iv > 0:
        rank = sum(1 for v in samples if v <= iv) / len(samples)
        iv_pct = round(rank * 100, 2)

    return GreeksResponse(
        symbol=symbol.upper(),
        expiry=expiry,
        strike=strike,
        kind=kind,
        iv=round(iv, 4),
        iv_percentile=iv_pct,
        underlying=chain.underlying,
        price=float(side.get("ltp", 0) or 0),
        greeks={k: round(v, 6) for k, v in g.items()},
    )
