"""VCP (Minervini's Volatility Contraction Pattern).

STUB — wraps the existing `detect_volatility_contraction_pattern` in
patterns/_institutional.py and reshapes the response to the spec
contract. A full rewrite per the Phase-2 spec would add explicit
contraction-by-contraction tracking + breakout volume confirmation.
For now this provides a working detect_vcp() the rest of the system
can import without errors.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from risk_config import apply_risk_caps


def detect_vcp(df: pd.DataFrame) -> Optional[dict]:
    try:
        if df is None or len(df) < 60:
            return None
        # Reuse the existing institutional VCP detector.
        from patterns._institutional import detect_volatility_contraction_pattern
        cols = {c.lower(): c for c in df.columns}
        if "close" not in cols:
            return None
        # Detector expects lowercase columns.
        df_lc = df.rename(columns=str.lower)
        res = detect_volatility_contraction_pattern(df_lc)
        if not res or not res.get("detected"):
            return None
        entry = float(res.get("entry_price") or df_lc["close"].iloc[-1])
        raw_stop = float(res.get("stop_price") or entry * 0.98)
        raw_target = float(res.get("target_price") or entry * 1.10)
        capped = apply_risk_caps(entry, raw_stop, raw_target, direction="bullish")
        if capped is None:
            return None
        entry, stop, target, rr = capped
        return {
            "detected": True,
            "pattern_name": "VCP",
            "pattern_type": "VCP",
            "direction": "bullish",
            "entry_price": round(entry, 2),
            "stop_price": round(stop, 2),
            "target_price": round(target, 2),
            "reward_risk": round(rr, 3),
            "confidence": float(res.get("strength", 0.5)),
            "historical_win_rate": float(res.get("historical_win_rate", 0.62)),
            "stage": res.get("description", "forming"),
        }
    except Exception:
        return None
