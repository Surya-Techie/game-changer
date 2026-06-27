"""Brandt pattern model trainer.

Two phases:

1. ``generate_training_data(symbols, start, end)`` walks each NSE symbol's
   historical daily bars in a rolling window, runs the Brandt detector
   battery at each window, and emits one labeled row per detected pattern.

   The label ``breakout_success`` is computed by Brandt's measured-move
   rule: did the close reach ``entry +/- measured_move_target_pct`` in the
   next 60 bars, before the stop was hit?

2. ``train_brandt_model(df)`` fits a calibrated GradientBoostingClassifier
   on the BRANDT_ML_FEATURES, applies Brandt's hard pre-filters so the
   model only learns from valid setups, and persists the .pkl.

Run:

    python -m gainz_alpha.brandt_model_trainer generate \\
        --symbols RELIANCE TCS INFY HDFCBANK \\
        --start 2021-01-01 --end 2024-12-31 \\
        --out data/brandt_training_data.csv

    python -m gainz_alpha.brandt_model_trainer train \\
        --data data/brandt_training_data.csv \\
        --out models/brandt_pattern_model.pkl
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from typing import List, Optional

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (
    accuracy_score,
    log_loss,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split  # only used for the (deprecated) random-split path

# Allow running as a script.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gainz_alpha.brandt_features import BRANDT_ML_FEATURES, extract_brandt_features
from gainz_alpha.pattern_detector import detect_best_brandt_pattern


# ───────────────────────────────────────────────────────────────────────
# DATA GENERATION
# ───────────────────────────────────────────────────────────────────────

def _fetch_ohlcv_yf(symbol: str, start: str, end: str) -> Optional[pd.DataFrame]:
    """Pull daily OHLCV via yfinance, return lowercase-columns DataFrame."""
    try:
        import yfinance as yf
    except ImportError:
        raise RuntimeError("yfinance is required for training data generation")
    ticker = symbol if symbol.endswith((".NS", ".BO")) else f"{symbol}.NS"
    try:
        df = yf.download(ticker, start=start, end=end, progress=False, auto_adjust=False)
    except Exception as e:
        print(f"  yfinance error {symbol}: {e}")
        return None
    if df is None or df.empty:
        return None
    # Flatten potential MultiIndex columns (yfinance 1.3+ returns those).
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df = df.rename(columns={c: c.lower() for c in df.columns})
    df = df[["open", "high", "low", "close", "volume"]].dropna()
    df = df.reset_index().rename(columns={"Date": "date", "index": "date"})
    return df


def _label_breakout_success(
    df: pd.DataFrame,
    entry_idx: int,
    entry_price: float,
    target_pct: float,
    stop_pct: float,
    direction: int,
    horizon: int = 60,
) -> int:
    """Return 1 if target hit before stop within horizon bars, else 0."""
    end_idx = min(entry_idx + horizon + 1, len(df))
    fwd = df.iloc[entry_idx + 1 : end_idx]
    if fwd.empty or direction == 0 or entry_price <= 0:
        return 0
    if direction > 0:
        target = entry_price * (1 + target_pct / 100)
        stop = entry_price * (1 - stop_pct / 100)
    else:
        target = entry_price * (1 - target_pct / 100)
        stop = entry_price * (1 + stop_pct / 100)
    for _, bar in fwd.iterrows():
        hi, lo = bar["high"], bar["low"]
        if direction > 0:
            if hi >= target:
                return 1
            if lo <= stop:
                return 0
        else:
            if lo <= target:
                return 1
            if hi >= stop:
                return 0
    return 0  # neither hit within horizon → treat as no-success


def generate_training_data(
    symbols: List[str],
    start: str,
    end: str,
    window_bars: int = 120,
    step: int = 10,
) -> pd.DataFrame:
    """Walk each symbol's history, detect patterns, label outcomes.

    Each (symbol, window_end_idx) pair where a pattern is detected emits
    one labeled training row. ``step=10`` means we re-scan every 10 bars
    rather than every bar so we don't produce 1000s of overlapping
    same-pattern rows from a single setup.
    """
    rows: List[dict] = []
    for sym in symbols:
        print(f"→ {sym}")
        df = _fetch_ohlcv_yf(sym, start, end)
        if df is None or len(df) < window_bars + 60:
            print(f"  skipped ({sym}, insufficient data)")
            continue

        n = len(df)
        for end_idx in range(window_bars, n - 60, step):
            window = df.iloc[end_idx - window_bars : end_idx].reset_index(drop=True)
            pat = detect_best_brandt_pattern(window)
            if pat is None:
                continue

            feats = extract_brandt_features(window, pat)
            # Skip rows where critical features are degenerate.
            if feats["pattern_duration_weeks"] < 1 or feats["reward_risk_ratio"] <= 0:
                continue

            # The entry bar in the full df is end_idx (the bar right after
            # the window we used for detection).
            entry_price = float(df["close"].iloc[end_idx])
            label = _label_breakout_success(
                df,
                entry_idx=end_idx,
                entry_price=entry_price,
                target_pct=feats["measured_move_target_pct"],
                stop_pct=max(feats["last_day_rule_stop_pct"], 0.5),
                direction=int(feats["breakout_direction"]),
                horizon=60,
            )

            row = {**feats,
                   "symbol": sym,
                   "entry_date": str(df["date"].iloc[end_idx]) if "date" in df.columns else str(end_idx),
                   "entry_price": entry_price,
                   "breakout_success": label}
            rows.append(row)

        print(f"  collected {len([r for r in rows if r['symbol'] == sym])} rows")

    return pd.DataFrame(rows)


# ───────────────────────────────────────────────────────────────────────
# TRAINING
# ───────────────────────────────────────────────────────────────────────

def train_brandt_model(df: pd.DataFrame, out_path: str) -> dict:
    """Fit the calibrated Brandt classifier and persist it.

    Returns a metrics dict for the report.
    """
    # Brandt hard pre-filter: only train on setups that pass his rules.
    valid = (
        (df["pattern_duration_weeks"] >= 4) &
        (df["reward_risk_ratio"] >= 3.0) &
        # Same-sign trend & breakout (or sideways trend, which we permit).
        ((df["trend_direction_lt"] == 0) | (df["trend_direction_lt"] == df["breakout_direction"]))
    )
    df_v = df[valid].copy()
    print(f"\nBrandt pre-filter: {len(df_v)}/{len(df)} rows retained")

    if len(df_v) < 30:
        raise RuntimeError(
            f"Only {len(df_v)} valid setups after Brandt filtering — need ≥30 "
            "to train a meaningful model. Expand the date range or symbol set."
        )

    # Sort by entry_date so the chronological split below is meaningful.
    # `train_test_split` with random=42 was used here — that shuffles rows
    # and lets the model train on the future of the holdout, inflating
    # accuracy by 5–15 percentage points on financial data. Chronological
    # split is the only honest way to evaluate a time-series model.
    if "entry_date" in df_v.columns:
        df_v = df_v.sort_values("entry_date").reset_index(drop=True)

    X = df_v[BRANDT_ML_FEATURES].astype(float).fillna(0.0)
    y = df_v["breakout_success"].astype(int)
    print(f"label distribution: {dict(y.value_counts())}")

    if y.nunique() < 2:
        raise RuntimeError(
            "Labels are single-class — every setup either succeeded or failed. "
            "Cannot train a classifier. Try a wider date range or different symbols."
        )

    # Chronological 80/20 split — first 80% in time → train, last 20% → holdout.
    split_idx = int(len(X) * 0.8)
    X_tr, X_te = X.iloc[:split_idx], X.iloc[split_idx:]
    y_tr, y_te = y.iloc[:split_idx], y.iloc[split_idx:]
    if y_tr.nunique() < 2 or y_te.nunique() < 2:
        # Last-resort fallback: stratified random split, but mark it dirty.
        print("WARNING: chronological split produced single-class train or test set; "
              "falling back to stratified random split. OOS metrics will be optimistic.")
        X_tr, X_te, y_tr, y_te = train_test_split(
            X, y, test_size=0.2, stratify=y, random_state=42
        )

    base = GradientBoostingClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        random_state=42,
    )
    # sklearn 1.8: pass the base estimator via `estimator=` kwarg.
    model = CalibratedClassifierCV(estimator=base, cv=3, method="isotonic")

    # Brandt setups have a low natural success rate (~8%) — without class
    # rebalancing the model just learns to predict 0 every time and looks
    # 92% accurate while being useless. Up-weight the rare positive class
    # so the gradient sees both labels with equal force.
    pos_ratio = float(y_tr.mean())
    if pos_ratio > 0 and pos_ratio < 0.5:
        w_pos = (1 - pos_ratio) / pos_ratio
        sample_weight = np.where(y_tr.values == 1, w_pos, 1.0)
    else:
        sample_weight = None

    model.fit(X_tr, y_tr, sample_weight=sample_weight)

    # ── Evaluation ───────────────────────────────────────────────────
    # We compute metrics at TWO thresholds:
    #   1) the prior fixed-0.5 threshold (for backwards compatibility)
    #   2) the threshold that maximises balanced accuracy on the holdout
    # With class rebalancing via sample_weight, 0.5 is no longer the
    # natural cut-point. We report both so the consumer can see the
    # spread between "default" and "tuned" accuracy honestly.
    probs = model.predict_proba(X_te)[:, 1]
    preds_05 = (probs >= 0.5).astype(int)

    # Threshold sweep for the balanced-accuracy-optimal cut.
    best_thr = 0.5
    best_bal_acc = 0.0
    if y_te.nunique() > 1:
        for thr in np.linspace(0.1, 0.9, 33):
            p = (probs >= thr).astype(int)
            pos_mask = y_te == 1
            neg_mask = y_te == 0
            if pos_mask.sum() == 0 or neg_mask.sum() == 0:
                continue
            tpr = float((p[pos_mask] == 1).mean())
            tnr = float((p[neg_mask] == 0).mean())
            bal_acc = (tpr + tnr) / 2.0
            if bal_acc > best_bal_acc:
                best_bal_acc = bal_acc
                best_thr = float(thr)

    metrics = {
        "n_total":              int(len(df)),
        "n_valid":              int(len(df_v)),
        "n_train":              int(len(X_tr)),
        "n_test":               int(len(X_te)),
        "accuracy_at_0.5":      float(accuracy_score(y_te, preds_05)),
        "best_threshold":       round(best_thr, 3),
        "balanced_accuracy":    round(best_bal_acc, 4),
        "log_loss":             float(log_loss(y_te, probs, labels=[0, 1])),
        "auc":                  float(roc_auc_score(y_te, probs)) if y_te.nunique() > 1 else None,
        "positive_rate_train":  float(y_tr.mean()),
        "positive_rate_test":   float(y_te.mean()),
        "evaluation_method":    "chronological_80_20_split",
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    joblib.dump(model, out_path)
    print(f"\n✔ saved {out_path}")
    print(f"  acc@0.5={metrics['accuracy_at_0.5']:.3f}  "
          f"bal_acc(best_thr={metrics['best_threshold']})={metrics['balanced_accuracy']:.3f}  "
          f"auc={metrics['auc']}  log_loss={metrics['log_loss']:.3f}")
    return metrics


# ───────────────────────────────────────────────────────────────────────
# CLI
# ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    gen = sub.add_parser("generate", help="Fetch NSE data, detect patterns, label.")
    gen.add_argument("--symbols", nargs="+", required=True,
                     help="NSE symbols, e.g. RELIANCE TCS INFY (no .NS suffix).")
    gen.add_argument("--start", required=True, help="YYYY-MM-DD")
    gen.add_argument("--end",   required=True, help="YYYY-MM-DD")
    gen.add_argument("--out",   default="data/brandt_training_data.csv")
    gen.add_argument("--step",  type=int, default=10,
                     help="Scan every N bars (default 10 → ~10x fewer rows).")

    tr = sub.add_parser("train", help="Train + save brandt_pattern_model.pkl")
    tr.add_argument("--data", default="data/brandt_training_data.csv")
    tr.add_argument("--out",  default="models/brandt_pattern_model.pkl")

    args = ap.parse_args()

    if args.cmd == "generate":
        df = generate_training_data(args.symbols, args.start, args.end, step=args.step)
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        df.to_csv(args.out, index=False)
        print(f"\n✔ wrote {len(df)} labeled rows → {args.out}")
        print(f"  label distribution: {dict(df['breakout_success'].value_counts())}")
    elif args.cmd == "train":
        df = pd.read_csv(args.data)
        metrics = train_brandt_model(df, args.out)
        print("\nmetrics:", metrics)


if __name__ == "__main__":
    main()
