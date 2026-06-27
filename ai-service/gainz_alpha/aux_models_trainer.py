"""Trainer for the three auxiliary ensemble models.

Each model uses the SAME training universe but a DIFFERENT feature set,
so the ensemble combines three independent "views" of the same signal:

  Model 1 (RandomForest): classical TA — RSI / MACD / ADX / Bollinger.
  Model 2 (LogisticRegression): volume anomaly + price-momentum sentiment proxy.
  Model 3 (GradientBoosting): pure price-action momentum.

All three predict "did close rise over the next 5 bars?" — a binary
short-horizon directional label. Each is calibrated with isotonic
regression so the ensemble's weighted sum of probabilities is meaningful.

Usage:

    python -m gainz_alpha.aux_models_trainer \\
        --symbols RELIANCE TCS INFY HDFCBANK ICICIBANK SBIN ITC LT BHARTIARTL MARUTI \\
        --start 2020-01-01 --end 2024-12-31 \\
        --out_dir models/
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Dict, List, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gainz_alpha.aux_features import (
    ALL_AUX_FEATURES,
    MODEL_1_FEATURES,
    MODEL_2_FEATURES,
    MODEL_3_FEATURES,
    build_feature_frame,
)


def _fetch_ohlcv_yf(symbol: str, start: str, end: str) -> pd.DataFrame | None:
    import yfinance as yf
    ticker = symbol if symbol.endswith((".NS", ".BO")) else f"{symbol}.NS"
    try:
        df = yf.download(ticker, start=start, end=end, progress=False, auto_adjust=False)
    except Exception as e:
        print(f"  yfinance error {symbol}: {e}")
        return None
    if df is None or df.empty:
        return None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df = df.rename(columns={c: c.lower() for c in df.columns})
    return df[["open", "high", "low", "close", "volume"]].dropna()


def build_dataset(symbols: List[str], start: str, end: str) -> pd.DataFrame:
    frames: List[pd.DataFrame] = []
    for s in symbols:
        print(f"→ {s}")
        df = _fetch_ohlcv_yf(s, start, end)
        if df is None or len(df) < 250:
            print(f"  skipped (insufficient data)")
            continue
        feats = build_feature_frame(df)
        feats["symbol"] = s
        feats = feats.dropna(subset=ALL_AUX_FEATURES + ["target"])
        frames.append(feats)
        print(f"  {len(feats)} rows")
    if not frames:
        raise RuntimeError("No usable training data — check yfinance access.")
    return pd.concat(frames, ignore_index=True)


def _train_one(
    name: str,
    feature_cols: List[str],
    df: pd.DataFrame,
    out_path: str,
    base_estimator,
    scale: bool = False,
) -> dict:
    """Fit a calibrated classifier and persist it."""
    X = df[feature_cols].astype(float).values
    y = df["target"].astype(int).values
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )

    if scale:
        # LogReg + GBM both benefit from scaled inputs for stability.
        base = Pipeline([("scaler", StandardScaler()), ("clf", base_estimator)])
    else:
        base = base_estimator

    model = CalibratedClassifierCV(estimator=base, cv=3, method="isotonic")
    model.fit(X_tr, y_tr)

    probs = model.predict_proba(X_te)[:, 1]
    preds = (probs >= 0.5).astype(int)
    metrics = {
        "name":      name,
        "n_train":   int(len(X_tr)),
        "n_test":    int(len(X_te)),
        "accuracy":  float(accuracy_score(y_te, preds)),
        "log_loss":  float(log_loss(y_te, probs, labels=[0, 1])),
        "auc":       float(roc_auc_score(y_te, probs)) if len(set(y_te)) > 1 else None,
        "pos_rate":  float(y_te.mean()),
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    joblib.dump(model, out_path)
    print(f"✔ {name:30s} → {out_path}")
    print(f"  acc={metrics['accuracy']:.3f}  auc={metrics['auc']:.3f}  "
          f"logloss={metrics['log_loss']:.3f}  pos={metrics['pos_rate']:.3f}")
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--out_dir", default="models")
    args = ap.parse_args()

    print("Building training dataset…")
    df = build_dataset(args.symbols, args.start, args.end)
    print(f"\nTotal rows: {len(df)}   pos rate: {df['target'].mean():.3f}\n")

    results = []

    # ── Model 1: classical TA, RandomForest ───────────────────────────
    results.append(_train_one(
        "model_1_rsi_macd",
        MODEL_1_FEATURES,
        df,
        os.path.join(args.out_dir, "model_1_rsi_macd.pkl"),
        RandomForestClassifier(
            n_estimators=300,
            max_depth=8,
            min_samples_leaf=10,
            class_weight="balanced",
            random_state=42,
            n_jobs=-1,
        ),
    ))

    # ── Model 2: volume/sentiment, LogReg ─────────────────────────────
    results.append(_train_one(
        "model_2_sentiment_volume",
        MODEL_2_FEATURES,
        df,
        os.path.join(args.out_dir, "model_2_sentiment_volume.pkl"),
        LogisticRegression(
            max_iter=500,
            class_weight="balanced",
            random_state=42,
        ),
        scale=True,
    ))

    # ── Model 3: momentum, GradientBoosting ───────────────────────────
    results.append(_train_one(
        "model_3_momentum",
        MODEL_3_FEATURES,
        df,
        os.path.join(args.out_dir, "model_3_momentum.pkl"),
        GradientBoostingClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            random_state=42,
        ),
    ))

    print("\n══════════════════════════════════════════════════════")
    print("All 3 auxiliary models trained.")
    for r in results:
        print(f"  {r['name']:30s}  acc={r['accuracy']:.3f}  auc={r['auc']:.3f}")


if __name__ == "__main__":
    main()
