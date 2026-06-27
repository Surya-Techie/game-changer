"""Support / resistance + pivot points.

Computes Classic + Camarilla pivot points from the previous day's H/L/C, plus
prior-day / week / month / 52-week high-lows from a 1-minute candle stream.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple


def _to_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d")


def _aggregate_by_date(candles: List[dict]) -> List[dict]:
    """Aggregate 1-min candles into daily OHLCV (UTC date bucketing)."""
    out: List[dict] = []
    current: Optional[dict] = None
    for c in candles:
        d = _to_date(int(c["t"]))
        if current is None or current["date"] != d:
            if current is not None:
                out.append(current)
            current = {"date": d, "o": c["o"], "h": c["h"], "l": c["l"], "c": c["c"], "v": c["v"]}
        else:
            current["h"] = max(current["h"], c["h"])
            current["l"] = min(current["l"], c["l"])
            current["c"] = c["c"]
            current["v"] += c["v"]
    if current is not None:
        out.append(current)
    return out


def _classic_pivots(h: float, l: float, c: float) -> Dict[str, float]:
    p = (h + l + c) / 3.0
    r1 = 2 * p - l
    r2 = p + (h - l)
    r3 = h + 2 * (p - l)
    s1 = 2 * p - h
    s2 = p - (h - l)
    s3 = l - 2 * (h - p)
    return {"P": round(p, 2), "R1": round(r1, 2), "R2": round(r2, 2), "R3": round(r3, 2),
            "S1": round(s1, 2), "S2": round(s2, 2), "S3": round(s3, 2)}


def _camarilla_pivots(h: float, l: float, c: float) -> Dict[str, float]:
    rng = h - l
    return {
        "R4": round(c + rng * 1.1 / 2, 2),
        "R3": round(c + rng * 1.1 / 4, 2),
        "R2": round(c + rng * 1.1 / 6, 2),
        "R1": round(c + rng * 1.1 / 12, 2),
        "S1": round(c - rng * 1.1 / 12, 2),
        "S2": round(c - rng * 1.1 / 6, 2),
        "S3": round(c - rng * 1.1 / 4, 2),
        "S4": round(c - rng * 1.1 / 2, 2),
    }


def compute_levels(candles: List[dict]) -> dict:
    """Returns key S/R levels with distance from CMP."""
    if not candles:
        return {"error": "no candles"}
    last_close = float(candles[-1]["c"])
    daily = _aggregate_by_date(candles)

    out: dict = {"cmp": round(last_close, 2)}

    # Previous day — fall back to first half of available bars when we don't
    # yet have a full prior trading day (mock feed in a fresh session).
    if len(daily) >= 2:
        prev = daily[-2]
        out["prevDay"] = {"high": round(prev["h"], 2), "low": round(prev["l"], 2), "close": round(prev["c"], 2)}
        out["classic"] = _classic_pivots(prev["h"], prev["l"], prev["c"])
        out["camarilla"] = _camarilla_pivots(prev["h"], prev["l"], prev["c"])
    elif len(candles) >= 100:
        cutoff = max(60, len(candles) // 2)
        prior = candles[:cutoff]
        ph = max(c["h"] for c in prior)
        pl = min(c["l"] for c in prior)
        pc = prior[-1]["c"]
        out["prevDay"] = {"high": round(ph, 2), "low": round(pl, 2), "close": round(pc, 2)}
        out["classic"] = _classic_pivots(ph, pl, pc)
        out["camarilla"] = _camarilla_pivots(ph, pl, pc)
        out["pivotSource"] = "session-fallback"

    # Weekly H/L (last 5 trading days excluding today).
    if len(daily) >= 6:
        week = daily[-6:-1]
        out["weekly"] = {
            "high": round(max(d["h"] for d in week), 2),
            "low": round(min(d["l"] for d in week), 2),
        }

    # Monthly H/L (last ~20 trading days).
    if len(daily) >= 21:
        month = daily[-21:-1]
        out["monthly"] = {
            "high": round(max(d["h"] for d in month), 2),
            "low": round(min(d["l"] for d in month), 2),
        }
    elif len(daily) >= 2:
        # fall back to whatever we have
        recent = daily[:-1]
        out["monthly"] = {
            "high": round(max(d["h"] for d in recent), 2),
            "low": round(min(d["l"] for d in recent), 2),
        }

    # 52-week ≈ last 252 trading days; fall back to whatever's available.
    if len(daily) >= 2:
        window = daily[:-1]
        out["yearly"] = {
            "high": round(max(d["h"] for d in window), 2),
            "low": round(min(d["l"] for d in window), 2),
            "bars": len(window),
        }
    elif candles:
        out["yearly"] = {
            "high": round(max(c["h"] for c in candles), 2),
            "low": round(min(c["l"] for c in candles), 2),
            "bars": len(candles),
        }

    # Build a flat list with distance % from CMP, sorted by absolute distance.
    flat: List[dict] = []
    def add(name: str, kind: str, price: float) -> None:
        if price is None:
            return
        dist_pct = (last_close - price) / price * 100
        flat.append({
            "name": name,
            "kind": kind,
            "price": round(price, 2),
            "distance": round(last_close - price, 2),
            "distancePct": round(dist_pct, 3),
            "side": "support" if price < last_close else "resistance",
        })

    if "classic" in out:
        for k, v in out["classic"].items():
            add(f"Classic {k}", "classic", v)
    if "camarilla" in out:
        for k, v in out["camarilla"].items():
            add(f"Cam {k}", "camarilla", v)
    if "prevDay" in out:
        add("Prev Day H", "prev_day", out["prevDay"]["high"])
        add("Prev Day L", "prev_day", out["prevDay"]["low"])
        add("Prev Day C", "prev_day", out["prevDay"]["close"])
    if "weekly" in out:
        add("Weekly H", "weekly", out["weekly"]["high"])
        add("Weekly L", "weekly", out["weekly"]["low"])
    if "monthly" in out:
        add("Monthly H", "monthly", out["monthly"]["high"])
        add("Monthly L", "monthly", out["monthly"]["low"])
    if "yearly" in out:
        add("52w H", "yearly", out["yearly"]["high"])
        add("52w L", "yearly", out["yearly"]["low"])

    out["levels"] = sorted(flat, key=lambda x: abs(x["distancePct"]))[:24]
    return out
