"""Phase 3 smoke test — exercises every new FastAPI route via TestClient.

Stubs yfinance so the test runs offline; verifies cache hits, scan filter,
admin-gating, mongo-unavailable degradation, and job lifecycle.

Run with:
    cd ai-service && python patterns/_phase3_smoke_test.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))


def _synthetic(n: int, kind: str, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed=seed)
    if kind == "up":
        close = 100 + np.cumsum(rng.normal(loc=0.4, scale=1.0, size=n))
    elif kind == "down":
        close = 200 + np.cumsum(rng.normal(loc=-0.4, scale=1.0, size=n))
    else:
        close = 150 + np.cumsum(rng.normal(loc=0.0, scale=1.6, size=n))
    open_ = np.concatenate([[close[0]], close[:-1]])
    high = np.maximum(open_, close) + rng.uniform(0.2, 1.6, size=n)
    low = np.minimum(open_, close) - rng.uniform(0.2, 1.6, size=n)
    vol = rng.integers(100_000, 1_000_000, size=n).astype(float)
    t = np.arange(n, dtype="int64") * 60_000
    return pd.DataFrame({
        "time": t, "open": open_, "high": high, "low": low, "close": close, "volume": vol,
    })


def main() -> int:
    # Tmp models dir so we don't fight any real artifacts.
    tmp = Path(tempfile.mkdtemp(prefix="qti_phase3_"))
    os.environ["PATTERN_MODELS_DIR"] = str(tmp)
    os.environ["PATTERN_JOB_STATE"] = str(tmp / "jobs.json")
    print("Using temp dir:", tmp)

    # Make sure no Mongo is wired during the test.
    os.environ.pop("MONGO_URL", None)
    os.environ.pop("MONGODB_URI", None)
    os.environ.pop("AI_SERVICE_TOKEN", None)

    # Stub yfinance fetch on the router.
    import pattern_router as pr
    def fake_fetch(symbol: str, timeframe: str):
        seed = (hash(symbol) ^ hash(timeframe)) & 0xFFFF
        kind = "up" if (seed % 3 == 0) else ("down" if (seed % 3 == 1) else "flat")
        return _synthetic(180, kind, seed=seed)
    pr._fetch_ohlcv = fake_fetch  # type: ignore[assignment]

    # Bring in main app — it mounts the pattern router.
    import main as main_app
    from fastapi.testclient import TestClient

    client = TestClient(main_app.app)

    # 1. /patterns/status — no auth required.
    r = client.get("/patterns/status")
    if r.status_code != 200:
        print(f"FAIL status: {r.status_code} {r.text}")
        return 1
    status = r.json()
    print(f"Step 1 /patterns/status: cache backend={status['cache']['backend']}, mongo_connected={status['mongo']['connected']}")

    # 2. /patterns/detect — first call (cache miss).
    t0 = time.perf_counter()
    r = client.post("/patterns/detect", json={"symbol": "RELIANCE", "timeframe": "D1", "lookback": 100})
    if r.status_code != 200:
        print(f"FAIL detect 1: {r.status_code} {r.text}")
        return 1
    body = r.json()
    print(f"Step 2 detect#1 (miss): {len(body['patterns'])} patterns in {1000*(time.perf_counter()-t0):.0f}ms, cached={body['cached']}, higher_tf={body['higher_tf']}")
    if body["cached"]:
        print("FAIL: expected cache=False on first call")
        return 1

    # 2b. /patterns/detect — cache hit.
    r2 = client.post("/patterns/detect", json={"symbol": "RELIANCE", "timeframe": "D1", "lookback": 100})
    body2 = r2.json()
    if not body2["cached"]:
        print("FAIL: expected cache=True on second call")
        return 1
    print(f"Step 2b detect#2 (cache hit): cached={body2['cached']}, ok")

    # Validate the detect schema on the first pattern (if any).
    if body["patterns"]:
        p = body["patterns"][0]
        for k in ("pattern_name", "detected", "direction", "confidence_score", "grade", "score_breakdown", "score_reasoning"):
            if k not in p:
                print(f"FAIL pattern schema: missing '{k}'")
                return 1
        if not (0 <= int(p["confidence_score"]) <= 100):
            print(f"FAIL: score out of bounds: {p['confidence_score']}")
            return 1
        print(f"   First pattern: '{p['pattern_name']}' {p['grade']} {p['confidence_score']}/100, direction={p['direction']}")

    # 3. /patterns/scan — multi-symbol with min_confidence filter.
    r = client.get("/patterns/scan", params={"symbols": "RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK", "timeframe": "M15", "min_confidence": 50})
    if r.status_code != 200:
        print(f"FAIL scan: {r.status_code} {r.text}")
        return 1
    scan = r.json()
    print(f"Step 3 /patterns/scan: scanned {scan['symbols_scanned']}/{scan['symbols_requested']} → {len(scan['patterns'])} above conf={scan['min_confidence']}")
    for p in scan["patterns"][:3]:
        print(f"   • {p.get('symbol','?')} {p.get('pattern_name','?')} {p.get('grade','?')} {p.get('confidence_score','?')}/100")

    # 4. /patterns/history — mongo not available → graceful empty.
    r = client.get("/patterns/history/RELIANCE")
    if r.status_code != 200:
        print(f"FAIL history: {r.status_code} {r.text}")
        return 1
    h = r.json()
    if h["count"] != 0:
        print(f"FAIL: expected empty history without mongo, got {h['count']}")
        return 1
    print(f"Step 4 /patterns/history: gracefully empty without mongo (count={h['count']})")

    # 5. /patterns/accuracy — mongo not available → available=False.
    r = client.get("/patterns/accuracy")
    if r.status_code != 200:
        print(f"FAIL accuracy: {r.status_code} {r.text}")
        return 1
    a = r.json()
    if a["available"]:
        print(f"FAIL: mongo should be unavailable here, got available=True")
        return 1
    print(f"Step 5 /patterns/accuracy: available=False without mongo (OK)")

    # 6. /patterns/feedback — should 403 without admin header even though mongo is down.
    r = client.post("/patterns/feedback", json={"pattern_id": "0123456789ab", "outcome": "win", "exit_price": 100.0})
    if r.status_code != 403:
        print(f"FAIL feedback non-admin: expected 403, got {r.status_code}")
        return 1
    print(f"Step 6 /patterns/feedback: blocked anonymous caller with 403 (OK)")
    # With admin header, mongo is down → 503.
    r = client.post(
        "/patterns/feedback",
        headers={"X-User-Role": "admin"},
        json={"pattern_id": "0123456789ab", "outcome": "win", "exit_price": 100.0},
    )
    if r.status_code != 503:
        print(f"FAIL feedback admin/no-mongo: expected 503, got {r.status_code}")
        return 1
    print(f"Step 6b /patterns/feedback: admin gets 503 (mongo unavailable) (OK)")

    # 7. /patterns/train — admin-gated. Use a tiny universe + fast=True; also stub the
    #    training fetch path so it uses our synthetic frames instead of yfinance.
    import patterns.train_models as tm_mod
    tm_mod._yf_fetch = lambda symbol, tf: _synthetic(220, "up", seed=hash(symbol) & 0xFF)  # type: ignore[assignment]

    r = client.post("/patterns/train", json={"timeframe": "D1", "symbols": ["AAA"], "fast": True})  # no admin header
    if r.status_code != 403:
        print(f"FAIL train non-admin: expected 403, got {r.status_code}")
        return 1
    r = client.post(
        "/patterns/train",
        headers={"X-User-Role": "admin"},
        json={"timeframe": "D1", "symbols": ["AAA", "BBB", "CCC", "DDD"], "fast": True},
    )
    if r.status_code != 200:
        print(f"FAIL train submit: {r.status_code} {r.text}")
        return 1
    submit = r.json()
    print(f"Step 7 /patterns/train: queued job {submit['job_id']} ETA {submit['estimated_seconds']}s")

    # Poll job until done / failed (cap wait at 60s for the fast model).
    job_id = submit["job_id"]
    deadline = time.time() + 60
    final = None
    while time.time() < deadline:
        r = client.get(f"/patterns/train/{job_id}")
        if r.status_code != 200:
            print(f"FAIL train status: {r.status_code} {r.text}")
            return 1
        final = r.json()
        if final["status"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(1)
    if final is None or final["status"] != "completed":
        print(f"FAIL: training did not complete: {final}")
        return 1
    print(f"Step 7b training {job_id}: status={final['status']} percent={final['percent']} samples={final['result']['n_samples']}")

    shutil.rmtree(tmp, ignore_errors=True)
    print("\nPASS — Phase 3 router endpoints all respond correctly across cache, scan, history, accuracy, feedback, train.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
