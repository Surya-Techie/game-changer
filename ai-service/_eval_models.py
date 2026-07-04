"""Out-of-sample evaluation harness for the ML training pipeline.

Trains the real pipeline on several symbols' daily history and reports the
holdout metrics that matter — direction accuracy, Brier score, log loss,
OOS R² — averaged across symbols so a single noisy holdout can't flatter
(or condemn) a change. Run before AND after any model change to prove the
change actually helps out of sample, not just in sample.

    python _eval_models.py
"""

from __future__ import annotations

import os
import statistics
import sys

import yfinance as yf

from ml_training import train_symbol

SYMBOLS = [
    "RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS", "ICICIBANK.NS",
    "ITC.NS", "SBIN.NS", "LT.NS", "AXISBANK.NS", "KOTAKBANK.NS",
    "BHARTIARTL.NS", "MARUTI.NS",
]

# Configurable so the SAME pipeline can be evaluated on daily vs intraday
# bars / different horizons — the honest way to test the "better data"
# hypothesis. Defaults reproduce the 5y-daily baseline.
INTERVAL = os.getenv("EVAL_INTERVAL", "1d")
PERIOD = os.getenv("EVAL_PERIOD", "5y")
HORIZON = int(os.getenv("EVAL_HORIZON", "5"))


def fetch(symbol: str, period: str = PERIOD, interval: str = INTERVAL) -> list[dict]:
    df = yf.Ticker(symbol).history(period=period, interval=interval)
    if df.empty:
        return []
    return [
        {"t": int(ts.timestamp() * 1000), "o": float(r["Open"]), "h": float(r["High"]),
         "l": float(r["Low"]), "c": float(r["Close"]), "v": float(r.get("Volume", 0) or 0)}
        for ts, r in df.iterrows()
    ]


def main() -> None:
    rows = []
    print("=" * 86)
    print(f" ML pipeline — OOS evaluation ({PERIOD} {INTERVAL} bars, horizon={HORIZON}, walk-forward)")
    print("=" * 86)
    for sym in SYMBOLS:
        candles = fetch(sym)
        if len(candles) < 200:
            print(f"{sym:<14} skip ({len(candles)} candles)")
            continue
        m = train_symbol(sym.replace(".NS", ""), candles, horizon=HORIZON)
        if "error" in m:
            print(f"{sym:<14} {m['error']}")
            continue
        rows.append(m)
        print(f"{sym:<14} dirAcc={m['directionAccuracyPct']:>5.1f}%  "
              f"brier={m['brierScore']:.3f}  logloss={m['logLoss']:.3f}  "
              f"oosR2={m['outOfSampleR2']:+.3f}  cvR2={m['cvR2Mean']:+.3f}")

    if not rows:
        print("no models trained")
        return

    def avg(key: str) -> float:
        return statistics.mean(r[key] for r in rows)

    # Direction accuracy is the headline. Brier < 0.25 and logloss < 0.693
    # (= coin flip) are the calibration sanity checks. >50% of symbols with
    # real edge (dirAcc > 52 AND brier < 0.24) is the robustness check.
    edge = [r for r in rows if r["directionAccuracyPct"] > 52 and r["brierScore"] < 0.24]
    print("-" * 86)
    print(f"AGGREGATE over {len(rows)} symbols:")
    print(f"  mean direction accuracy : {avg('directionAccuracyPct'):.2f}%   (>50 = edge)")
    print(f"  mean Brier score        : {avg('brierScore'):.4f}   (<0.25 = better than coin flip)")
    print(f"  mean log loss           : {avg('logLoss'):.4f}   (<0.693 = better than coin flip)")
    print(f"  mean OOS R2             : {avg('outOfSampleR2'):+.4f}")
    print(f"  mean CV R2              : {avg('cvR2Mean'):+.4f}")
    print(f"  symbols with real edge  : {len(edge)}/{len(rows)}  "
          f"({100*len(edge)/len(rows):.0f}%)")


if __name__ == "__main__":
    sys.exit(main())
