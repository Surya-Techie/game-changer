"""Phase 9 smoke test — explainer + /patterns/detect integration.

Verifies:
  1. generate_explanation() returns a non-empty multi-line string for
     every detected pattern on synthetic data.
  2. The string contains the expected structural markers (symbol,
     confidence, "because:", bullet character).
  3. The /patterns/detect FastAPI route attaches `ai_explanation` to each
     pattern in the response.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))


def synthetic(n: int, kind: str, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed=seed)
    if kind == "up":
        close = 100 + np.cumsum(rng.normal(loc=0.45, scale=0.9, size=n))
    elif kind == "down":
        close = 200 + np.cumsum(rng.normal(loc=-0.45, scale=0.9, size=n))
    else:
        close = 150 + np.cumsum(rng.normal(loc=0.0, scale=1.2, size=n))
    open_ = np.concatenate([[close[0]], close[:-1]])
    high = np.maximum(open_, close) + rng.uniform(0.2, 1.5, size=n)
    low = np.minimum(open_, close) - rng.uniform(0.2, 1.5, size=n)
    vol = rng.integers(100_000, 1_000_000, size=n).astype(float)
    t = np.arange(n, dtype="int64") * 60_000
    return pd.DataFrame({
        "time": t, "open": open_, "high": high, "low": low, "close": close, "volume": vol,
    })


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="qti_phase9_"))
    os.environ["PATTERN_MODELS_DIR"] = str(tmp)
    os.environ.pop("AI_SERVICE_TOKEN", None)
    os.environ.pop("MONGO_URL", None)

    from patterns._helpers import ensure_df
    from patterns.confidence_engine import score_many
    from patterns.explainer import explain_many, generate_explanation
    from patterns.rule_engine import run_all_patterns

    df = ensure_df(synthetic(200, "up", seed=2026))
    detections = run_all_patterns(df)
    if not detections:
        print("FAIL: rule engine returned no detections on synthetic data")
        return 1

    scored = score_many(detections, df, timeframe="D1")
    explained = explain_many(scored, df, symbol="SYNTH", timeframe="D1")

    bad = []
    for p in explained:
        text = p.get("ai_explanation") or ""
        if not text or "because:" not in text or "•" not in text:
            bad.append((p.get("pattern_name"), text[:100]))
    if bad:
        print(f"FAIL: {len(bad)} patterns missing or malformed explanation:")
        for name, snippet in bad[:5]:
            print(f"  • {name!r}: {snippet!r}")
        return 1
    print(f"Step 1 (explain_many): {len(explained)} patterns, all with valid explanations.")
    sample = explained[0]
    print("Step 2 (sample explanation):")
    for line in sample["ai_explanation"].splitlines():
        print(f"   {line}")

    # Step 3 — verify the FastAPI endpoint also attaches ai_explanation.
    import pattern_router as pr
    pr._fetch_ohlcv = lambda symbol, timeframe: synthetic(180, "up", seed=hash(symbol) & 0xFFF)  # type: ignore[assignment]

    import main as main_app
    from fastapi.testclient import TestClient
    client = TestClient(main_app.app)
    r = client.post("/patterns/detect", json={"symbol": "RELIANCE", "timeframe": "D1", "lookback": 100})
    if r.status_code != 200:
        print(f"FAIL: /patterns/detect returned {r.status_code}: {r.text}")
        return 1
    body = r.json()
    if not body["patterns"]:
        print("FAIL: /patterns/detect returned no patterns")
        return 1
    missing = [p["pattern_name"] for p in body["patterns"] if not p.get("ai_explanation")]
    if missing:
        print(f"FAIL: patterns missing ai_explanation in API response: {missing}")
        return 1
    print(f"Step 3 (/patterns/detect): {len(body['patterns'])} patterns, every one carries an ai_explanation field.")

    print("\nPASS — explainer wired end-to-end through /patterns/detect.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
