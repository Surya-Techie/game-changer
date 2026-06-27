"""
Training entrypoint.

Usage:
    python -m trading_app.ml.trainer
    python -m trading_app.ml.trainer --days 30 --crypto-days 90
"""
from __future__ import annotations

import argparse
import logging
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import classification_report

from .. import config
from ..data.fetcher import fetch, to_ist
from .features import build_features, FEATURE_COLS
from .labeler  import label_dataset, label_summary
from .model    import PPSModel

log = logging.getLogger(__name__)
MODEL_PATH = config.ROOT / "_models" / "pps_ml.pkl"


def _pull_one(sym: str, interval: str, days: int, ist: bool, manifest: list,
              frames_X: list, frames_y: list, fwd_bars: int):
    df = fetch(sym, interval=interval, days=days)
    if df.empty or len(df) < 100:
        manifest.append((sym, interval, 0, 0))
        return
    if ist:
        df = to_ist(df)
    X = build_features(df)
    y = label_dataset(df, fwd_bars=fwd_bars)
    idx = X.index.intersection(y.index)
    X, y = X.loc[idx], y.loc[idx]
    if len(X) > 0:
        frames_X.append(X); frames_y.append(y)
    manifest.append((sym, interval, len(df), len(X)))


def gather_training_set(days_eq_5m: int = 60, days_eq_1h: int = 720,
                        days_cx_1h: int = 360):
    """
    Multi-timeframe: NSE 5m + NSE 1h + Crypto 1h.
    Hugely expands the row count for the model.
    """
    frames_X, frames_y = [], []
    manifest = []

    # ── NSE 5m (intraday, IST) ──
    for sym in config.NSE_STOCKS:
        _pull_one(sym, "5m", days_eq_5m, ist=True,
                  manifest=manifest, frames_X=frames_X, frames_y=frames_y,
                  fwd_bars=12)

    # ── NSE 1h (much longer history, IST) ──
    for sym in config.NSE_STOCKS:
        _pull_one(sym, "1h", days_eq_1h, ist=True,
                  manifest=manifest, frames_X=frames_X, frames_y=frames_y,
                  fwd_bars=8)

    # ── Crypto 1h (24/7) ──
    for sym in config.CRYPTO:
        _pull_one(sym, "1h", days_cx_1h, ist=False,
                  manifest=manifest, frames_X=frames_X, frames_y=frames_y,
                  fwd_bars=12)

    if not frames_X:
        raise RuntimeError("No data fetched — cannot train.")
    X = pd.concat(frames_X, axis=0)
    y = pd.concat(frames_y, axis=0)
    return X, y, manifest


def confidence_curve(model: PPSModel, X_test, y_test) -> pd.DataFrame:
    """
    For each candidate confidence threshold τ, compute:
        - coverage (% of bars where max_proba >= τ)
        - accuracy on that filtered subset
    Returns a DataFrame for the user to see at a glance.
    """
    proba = model.predict_proba(X_test)
    pred  = model.predict(X_test)
    max_p = proba.max(axis=1)

    rows = []
    for tau in [0.40, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]:
        mask = max_p >= tau
        n    = int(mask.sum())
        if n == 0:
            rows.append({"threshold": tau, "coverage_pct": 0,
                         "n_predictions": 0, "accuracy_pct": None})
            continue
        acc = float((pred[mask] == y_test[mask]).mean())
        rows.append({
            "threshold":     tau,
            "coverage_pct":  round(n / len(y_test) * 100, 2),
            "n_predictions": n,
            "accuracy_pct":  round(acc * 100, 2),
        })
    return pd.DataFrame(rows)


def train_and_save(days_eq_5m: int = 60, days_eq_1h: int = 720,
                   days_cx_1h:  int = 360,
                   model_path:  Path = MODEL_PATH) -> PPSModel:
    print("═" * 72)
    print("  PPS ML MODEL — training (v2 ensemble, multi-timeframe)")
    print("═" * 72)

    X, y, manifest = gather_training_set(days_eq_5m, days_eq_1h, days_cx_1h)
    print(f"\n▶ Source data per symbol:")
    for sym, tf, bars, feats in manifest:
        marker = "✅" if feats > 0 else "❌"
        print(f"  {marker}  {sym:<18} {tf:<4} bars={bars:>5}  labeled rows={feats}")

    print(f"\n▶ Combined dataset: {len(X)} rows × {len(FEATURE_COLS)} features")
    summary = label_summary(y)
    print(f"  label balance → {summary['balance']}")

    # Walk-forward chronological split (no shuffle).
    cut = int(len(X) * 0.75)
    X_train, X_test = X.iloc[:cut], X.iloc[cut:]
    y_train, y_test = y.iloc[:cut], y.iloc[cut:]
    print(f"\n▶ Walk-forward split: train={len(X_train)}  test={len(X_test)}")

    model = PPSModel.train(X_train, y_train)

    y_pred = model.predict(X_test)
    out_acc = float((y_pred == y_test).mean())
    print(f"\n▶ Out-of-sample metrics")
    print(f"  in-sample acc : {model.metrics['in_sample_accuracy']*100:.2f} %")
    print(f"  out-of-sample : {out_acc*100:.2f} %")
    print(f"  class weights : {model.metrics['class_weights']}")
    # ensure the labels list matches what's actually in y_test
    present  = sorted(set(y_test.unique()) | set(y_pred.unique()))
    lbl_map  = {-1: "SELL(-1)", 0: "HOLD(0)", 1: "BUY(+1)"}
    names    = [lbl_map[c] for c in present]
    print("\n" + classification_report(
        y_test, y_pred, labels=present, target_names=names, zero_division=0,
    ))

    # ── feature importance (pulled from the GB sub-estimator of the ensemble) ──
    clf = model.pipeline.named_steps["clf"]
    if hasattr(clf, "feature_importances_"):
        fi_arr = clf.feature_importances_
    else:
        # VotingClassifier — average the GB and RF importances
        names = {n: e for n, e in clf.named_estimators_.items()}
        parts = []
        if "gb" in names and hasattr(names["gb"], "feature_importances_"):
            parts.append(np.asarray(names["gb"].feature_importances_))
        if "rf" in names and hasattr(names["rf"], "feature_importances_"):
            parts.append(np.asarray(names["rf"].feature_importances_))
        if parts:
            fi_arr = np.mean(parts, axis=0)
        else:
            fi_arr = np.zeros(len(FEATURE_COLS))
    fi  = pd.Series(fi_arr, index=FEATURE_COLS).sort_values(ascending=False)
    print("▶ Feature importance (top-10)")
    for k, v in fi.head(10).items():
        print(f"  {k:<22} {v*100:5.2f} %")

    # ── Confidence-filtered curve ──
    print("\n▶ Confidence-filtered accuracy (the *real* 90 % story)")
    print("  threshold | coverage |   N    | accuracy")
    print("  ----------+----------+--------+----------")
    curve = confidence_curve(model, X_test, y_test)
    for _, r in curve.iterrows():
        acc = f"{r['accuracy_pct']:6.2f}%" if r['accuracy_pct'] is not None else "  —  "
        cov = f"{r['coverage_pct']:6.2f}%"
        print(f"    {r['threshold']:.2f}  |  {cov} | {r['n_predictions']:>5}  |  {acc}")

    hit_90 = curve[curve['accuracy_pct'].fillna(-1) >= 90]
    if not hit_90.empty:
        first = hit_90.iloc[0]
        print(f"\n  ★ ≥90 % accuracy crossed at threshold {first['threshold']:.2f} "
              f"(N={int(first['n_predictions'])}, coverage {first['coverage_pct']:.2f}%)")
    else:
        best = curve.dropna(subset=['accuracy_pct']).sort_values('accuracy_pct').tail(1)
        if not best.empty:
            b = best.iloc[0]
            print(f"\n  ⚠ Did not cross 90 % at any τ in the test set. "
                  f"Best so far: {b['accuracy_pct']:.2f}% at τ={b['threshold']:.2f}.")

    model.metrics.update({
        "out_of_sample_accuracy": round(out_acc, 4),
        "n_test":                 int(len(X_test)),
        "feature_importance":     {k: round(float(v), 4) for k, v in fi.items()},
        "confidence_curve":       curve.to_dict(orient="records"),
    })

    model.save(model_path)
    print(f"\n✅ Saved → {model_path}")
    return model


if __name__ == "__main__":          # pragma: no cover
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser()
    p.add_argument("--nse-5m",  type=int, default=60,  help="NSE  5m days  (yf cap 60)")
    p.add_argument("--nse-1h",  type=int, default=720, help="NSE  1h days  (yf cap 730)")
    p.add_argument("--crypto",  type=int, default=360, help="Crypto 1h days")
    a = p.parse_args()
    train_and_save(days_eq_5m=a.nse_5m,
                   days_eq_1h=a.nse_1h,
                   days_cx_1h=a.crypto)
