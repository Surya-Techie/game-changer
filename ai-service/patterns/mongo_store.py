"""MongoDB persistence for patterns + accuracy stats.

Phase 4 will introduce Mongoose schemas on the Node side that own the
authoritative collections. The AI service uses *the same database* via
PyMongo so it can:

  • record every detection it produces (history)
  • aggregate per-pattern win/loss/RR stats (accuracy)
  • accept feedback from the position/backtest layers

Connection model
----------------
Lazy: import-time is cheap; the client is constructed on first call and
cached. If `MONGO_URL` is missing (dev install with no Mongo running),
every method short-circuits to a benign no-op (`save_pattern→None`,
`pattern_history→[]`, etc.) so the rest of the service still runs.

Collections (must match Phase 4 schemas):
  - `patterns`          — every detected pattern
  - `pattern_accuracy`  — rollup per (pattern_name, timeframe)
"""

from __future__ import annotations

import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


# ─── Lazy client ───────────────────────────────────────────────────────────

_CLIENT: Any = None
_CLIENT_LOCK = threading.Lock()
_CLIENT_INIT_ATTEMPTED = False
_DB_NAME = os.environ.get("MONGO_DB_NAME", "qti")


def _client() -> Any:
    global _CLIENT, _CLIENT_INIT_ATTEMPTED
    if _CLIENT is not None or _CLIENT_INIT_ATTEMPTED:
        return _CLIENT
    with _CLIENT_LOCK:
        if _CLIENT_INIT_ATTEMPTED:
            return _CLIENT
        _CLIENT_INIT_ATTEMPTED = True
        url = os.environ.get("MONGO_URL") or os.environ.get("MONGODB_URI")
        if not url:
            return None
        try:
            from pymongo import MongoClient  # type: ignore
            c = MongoClient(url, serverSelectionTimeoutMS=2000)
            c.admin.command("ping")
            _CLIENT = c
        except Exception:  # noqa: BLE001 — degrade silently.
            _CLIENT = None
        return _CLIENT


def is_available() -> bool:
    return _client() is not None


def status() -> dict:
    c = _client()
    if c is None:
        return {"connected": False, "reason": "MONGO_URL not set or unreachable"}
    try:
        return {"connected": True, "db": _DB_NAME, "server_info": c.server_info().get("version")}
    except Exception as e:  # noqa: BLE001
        return {"connected": False, "reason": str(e)}


def _db() -> Any:
    c = _client()
    if c is None:
        return None
    return c[_DB_NAME]


# ─── Pattern writes ────────────────────────────────────────────────────────

def save_pattern(pattern: dict) -> Optional[str]:
    """Persist one detected pattern (the dict returned by the confidence
    engine — already enriched with `confidence_score` / `grade`)."""
    db = _db()
    if db is None:
        return None
    doc = dict(pattern)
    doc.setdefault("detected_at", datetime.now(timezone.utc))
    doc.setdefault("outcome", "pending")
    result = db["patterns"].insert_one(doc)
    return str(result.inserted_id)


# ─── Pattern reads ────────────────────────────────────────────────────────

def pattern_history(symbol: str, limit: int = 200) -> List[dict]:
    db = _db()
    if db is None:
        return []
    cursor = (
        db["patterns"]
        .find({"symbol": symbol.upper()})
        .sort("detected_at", -1)
        .limit(int(limit))
    )
    out: List[dict] = []
    for doc in cursor:
        doc["_id"] = str(doc.get("_id"))
        if isinstance(doc.get("detected_at"), datetime):
            doc["detected_at"] = doc["detected_at"].isoformat()
        if isinstance(doc.get("resolved_at"), datetime):
            doc["resolved_at"] = doc["resolved_at"].isoformat()
        out.append(doc)
    return out


# ─── Accuracy rollups ─────────────────────────────────────────────────────

def accuracy_summary() -> List[dict]:
    """Return per-pattern accuracy rollups from the pattern_accuracy
    collection. Used by /patterns/accuracy and the Analytics page."""
    db = _db()
    if db is None:
        return []
    cursor = db["pattern_accuracy"].find({}).sort("win_rate", -1)
    out: List[dict] = []
    for doc in cursor:
        doc["_id"] = str(doc.get("_id"))
        if isinstance(doc.get("last_updated"), datetime):
            doc["last_updated"] = doc["last_updated"].isoformat()
        out.append(doc)
    return out


def update_accuracy(pattern_name: str, timeframe: str, outcome: str, rr_achieved: Optional[float] = None, hold_bars: Optional[int] = None) -> dict:
    """Incremental win/loss/breakeven update on the pattern_accuracy rollup.

    Returns the post-update rollup document for the (pattern_name, timeframe).
    Idempotent on each call — callers commit one outcome at a time.
    """
    db = _db()
    if db is None:
        return {"updated": False, "reason": "mongo unavailable"}
    if outcome not in ("win", "loss", "breakeven"):
        raise ValueError(f"invalid outcome '{outcome}'")
    col = db["pattern_accuracy"]
    key = {"pattern_name": pattern_name, "timeframe": timeframe}
    inc = {"total_detected": 1}
    if outcome == "win":
        inc["wins"] = 1
    elif outcome == "loss":
        inc["losses"] = 1
    else:
        inc["breakevens"] = 1
    update = {
        "$inc": inc,
        "$set": {"last_updated": datetime.now(timezone.utc)},
    }
    if rr_achieved is not None:
        # Maintain running-average RR via a simple Welford-style accumulator stored on the doc.
        existing = col.find_one(key) or {}
        prev_avg = float(existing.get("avg_rr") or 0)
        prev_n = int(existing.get("total_detected") or 0)
        new_n = prev_n + 1
        new_avg = (prev_avg * prev_n + float(rr_achieved)) / max(new_n, 1)
        update["$set"]["avg_rr"] = round(new_avg, 3)
    if hold_bars is not None:
        existing = col.find_one(key) or {}
        prev_avg = float(existing.get("avg_hold_bars") or 0)
        prev_n = int(existing.get("total_detected") or 0)
        new_n = prev_n + 1
        new_avg = (prev_avg * prev_n + float(hold_bars)) / max(new_n, 1)
        update["$set"]["avg_hold_bars"] = round(new_avg, 2)
    col.update_one(key, update, upsert=True)
    rolled = col.find_one(key) or {}
    total = int(rolled.get("total_detected") or 0)
    wins = int(rolled.get("wins") or 0)
    if total > 0:
        col.update_one(key, {"$set": {"win_rate": round(wins / total, 4)}})
        rolled["win_rate"] = round(wins / total, 4)
    rolled["_id"] = str(rolled.get("_id"))
    if isinstance(rolled.get("last_updated"), datetime):
        rolled["last_updated"] = rolled["last_updated"].isoformat()
    return rolled


def resolve_pattern_outcome(pattern_id: str, outcome: str, exit_price: float) -> dict:
    """Commit an outcome onto the pattern document AND update the rollup."""
    db = _db()
    if db is None:
        return {"updated": False, "reason": "mongo unavailable"}
    from bson import ObjectId  # type: ignore  (PyMongo dependency)
    try:
        oid = ObjectId(pattern_id)
    except Exception:
        return {"updated": False, "reason": "invalid pattern_id"}
    doc = db["patterns"].find_one({"_id": oid})
    if not doc:
        return {"updated": False, "reason": "pattern not found"}

    entry = float(doc.get("entry_price") or 0)
    target = float(doc.get("target_price") or 0)
    stop = float(doc.get("stop_price") or 0)
    rr_achieved: Optional[float] = None
    if entry > 0 and stop > 0 and target > 0 and entry != stop:
        risk = abs(entry - stop)
        if outcome == "win":
            rr_achieved = abs(exit_price - entry) / max(risk, 1e-9)
        elif outcome == "loss":
            rr_achieved = -abs(exit_price - entry) / max(risk, 1e-9)
        else:
            rr_achieved = 0.0

    db["patterns"].update_one(
        {"_id": oid},
        {"$set": {
            "outcome": outcome,
            "exit_price": float(exit_price),
            "resolved_at": datetime.now(timezone.utc),
        }},
    )
    rollup = update_accuracy(
        pattern_name=str(doc.get("pattern_name") or "Unknown"),
        timeframe=str(doc.get("timeframe") or "D1"),
        outcome=outcome,
        rr_achieved=rr_achieved,
    )
    return {"updated": True, "pattern_id": pattern_id, "rollup": rollup}


def winrate_overrides() -> Dict[str, float]:
    """Snapshot of (pattern_name → win_rate) for the confidence engine to
    override its static baselines when enough samples have accumulated."""
    db = _db()
    if db is None:
        return {}
    out: Dict[str, float] = {}
    for doc in db["pattern_accuracy"].find({"total_detected": {"$gte": 10}}):
        name = doc.get("pattern_name")
        wr = doc.get("win_rate")
        if name and isinstance(wr, (int, float)):
            out[name] = float(wr)
    return out
