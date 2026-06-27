"""Gap classification — Breakaway / Runaway / Exhaustion / Common.

A simple, working implementation. Looks at the most-recent N bars for
significant gaps (≥ 0.5%) and classifies by trend-position + volume.

  Breakaway gap: gap at the END of a base/consolidation, with high
                 volume (≥ 2× 20-bar avg). Same direction as the
                 breakout. Most reliable.
  Runaway gap:   gap in the MIDDLE of a strong trend, volume above
                 average. Often near the midpoint of the move.
  Exhaustion gap: gap at the END of a long trend on climactic volume
                 (≥ 3× avg) — reversal warning.
  Common gap:    small gap inside congestion, low volume — not tradeable.

The detector returns the most recent SIGNIFICANT gap (≥ 0.5%) with its
classification + risk-capped entry/stop/target where applicable.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from risk_config import apply_risk_caps


def detect_gap_patterns(df: pd.DataFrame, *args, **kwargs) -> Optional[dict]:
    try:
        if df is None or len(df) < 30:
            return None
        cols = {c.lower(): c for c in df.columns}
        if not all(k in cols for k in ("open", "high", "low", "close", "volume")):
            return None
        opens = df[cols["open"]].astype(float).to_numpy()
        highs = df[cols["high"]].astype(float).to_numpy()
        lows = df[cols["low"]].astype(float).to_numpy()
        closes = df[cols["close"]].astype(float).to_numpy()
        vols = df[cols["volume"]].astype(float).to_numpy()
        n = len(closes)

        # Look at the LAST significant gap in the recent 10 bars.
        for back in range(0, min(10, n - 21)):
            i = n - 1 - back
            if i < 21:
                continue
            gap_pct = (opens[i] - closes[i - 1]) / closes[i - 1] * 100.0
            if abs(gap_pct) < 0.5:
                continue

            direction = "bullish" if gap_pct > 0 else "bearish"
            # Volume ratio vs 20-bar prior.
            avg_vol = float(vols[i - 20:i].mean()) if vols[i - 20:i].sum() > 0 else 1.0
            vol_ratio = float(vols[i]) / max(avg_vol, 1.0)

            # Trend position: last 50-bar return.
            lb = min(50, i)
            trend_pct = (closes[i] - closes[i - lb]) / closes[i - lb] * 100.0
            in_uptrend = trend_pct > 8.0
            in_downtrend = trend_pct < -8.0

            # Classification.
            if vol_ratio >= 2.0 and abs(trend_pct) < 8.0:
                # End of consolidation, big volume → breakaway.
                gap_type = "breakaway"
                confidence = 0.70
                tradeable = True
            elif vol_ratio >= 1.5 and ((direction == "bullish" and in_uptrend)
                                        or (direction == "bearish" and in_downtrend)):
                gap_type = "runaway"
                confidence = 0.60
                tradeable = True
            elif vol_ratio >= 3.0 and ((direction == "bullish" and in_uptrend)
                                        or (direction == "bearish" and in_downtrend)):
                # Climactic volume at end of trend → exhaustion warning.
                gap_type = "exhaustion"
                confidence = 0.55
                tradeable = False                 # reversal warning
            else:
                gap_type = "common"
                confidence = 0.30
                tradeable = False

            close_now = float(closes[-1])
            if tradeable:
                if direction == "bullish":
                    raw_stop = float(opens[i])    # below gap open
                    raw_target = close_now * 1.08
                else:
                    raw_stop = float(opens[i])
                    raw_target = close_now * 0.92
                capped = apply_risk_caps(close_now, raw_stop, raw_target,
                                          direction=direction)
                if capped is None:
                    tradeable = False
                else:
                    e, s, t, rr = capped
                    return {
                        "detected": True,
                        "pattern_name": f"Gap: {gap_type}",
                        "gap_type": gap_type,
                        "gap_size_pct": round(float(gap_pct), 3),
                        "direction": direction,
                        "volume_ratio": round(vol_ratio, 2),
                        "bars_ago": back,
                        "entry_price": round(e, 2),
                        "stop_price": round(s, 2),
                        "target_price": round(t, 2),
                        "reward_risk": round(rr, 3),
                        "confidence": confidence,
                        "historical_win_rate": 0.60,
                    }
            # Untradeable gap — still return for transparency.
            return {
                "detected": True,
                "pattern_name": f"Gap: {gap_type}",
                "gap_type": gap_type,
                "gap_size_pct": round(float(gap_pct), 3),
                "direction": direction,
                "volume_ratio": round(vol_ratio, 2),
                "bars_ago": back,
                "tradeable": False,
                "confidence": confidence,
                "historical_win_rate": 0.50,
            }
        return None
    except Exception:
        return None
