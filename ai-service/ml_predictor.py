"""ML predictor: next-bar direction + magnitude using engineered features.

This is the architectural scaffolding for a "real" model. The current
estimator is a small RandomForestRegressor trained lazily on the first
request per symbol from whatever candles the caller provides. In a
production setup you would:

  • train offline on multi-month tick history
  • version models (current path uses an in-memory cache keyed by symbol)
  • monitor live feature drift
  • A/B-test against the rule-based strategy

The on-the-wire contract returned by predict_next() is what callers
depend on; replacing the estimator is one function swap.
"""

from __future__ import annotations

import os
import time
from typing import Dict, List, Tuple

import numpy as np
from sklearn.ensemble import RandomForestRegressor

import indicators as ind


# In-memory model cache. Production would persist to disk / S3 / model
# registry; in this MVP we accept retraining on cold start.
_MODELS: Dict[str, dict] = {}

FEATURES = [
    "ret1", "ret3", "ret5", "ret10",
    "rsi14", "macdHist", "atr14_pct",
    "ema_spread", "vol_change", "bb_pos",
]


def _engineer(candles: List[dict]) -> Tuple[np.ndarray, np.ndarray]:
    """Build (X, y) from candle dicts. y is log-return 5 bars ahead."""
    closes = np.array([c["c"] for c in candles], dtype=float)
    highs = np.array([c["h"] for c in candles], dtype=float)
    lows = np.array([c["l"] for c in candles], dtype=float)
    vols = np.array([c["v"] for c in candles], dtype=float)
    n = len(closes)
    if n < 60:
        return np.empty((0, len(FEATURES))), np.empty((0,))

    rsi14 = np.array([v if v is not None else 50.0 for v in ind.rsi(closes.tolist(), 14)])
    _, _, macd_hist = ind.macd(closes.tolist())
    macd_hist = np.array([v if v is not None else 0.0 for v in macd_hist])
    atr14 = np.array([v if v is not None else 0.0 for v in ind.atr(highs.tolist(), lows.tolist(), closes.tolist(), 14)])
    ema9 = np.array([v if v is not None else closes[i] for i, v in enumerate(ind.ema(closes.tolist(), 9))])
    ema21 = np.array([v if v is not None else closes[i] for i, v in enumerate(ind.ema(closes.tolist(), 21))])
    bb_u, bb_m, bb_l = ind.bollinger(closes.tolist(), 20, 2.0)
    bb_u = np.array([v if v is not None else closes[i] for i, v in enumerate(bb_u)])
    bb_l = np.array([v if v is not None else closes[i] for i, v in enumerate(bb_l)])

    X_rows: List[List[float]] = []
    y_rows: List[float] = []
    horizon = 5
    for i in range(20, n - horizon):
        ret1 = float(np.log(closes[i] / closes[i - 1] + 1e-9))
        ret3 = float(np.log(closes[i] / closes[i - 3] + 1e-9))
        ret5 = float(np.log(closes[i] / closes[i - 5] + 1e-9))
        ret10 = float(np.log(closes[i] / closes[i - 10] + 1e-9))
        ema_spread = float((ema9[i] - ema21[i]) / closes[i])
        atr_pct = float(atr14[i] / closes[i])
        vol_change = float(np.log((vols[i] + 1) / (vols[i - 1] + 1)))
        denom = max(bb_u[i] - bb_l[i], 1e-9)
        bb_pos = float((closes[i] - bb_l[i]) / denom)
        X_rows.append([ret1, ret3, ret5, ret10, float(rsi14[i]), float(macd_hist[i]), atr_pct, ema_spread, vol_change, bb_pos])
        y_rows.append(float(np.log(closes[i + horizon] / closes[i] + 1e-9)))

    return np.array(X_rows, dtype=float), np.array(y_rows, dtype=float)


def _features_for_last(candles: List[dict]) -> np.ndarray:
    """Build a single feature row for the latest bar (for inference)."""
    closes = np.array([c["c"] for c in candles], dtype=float)
    highs = np.array([c["h"] for c in candles], dtype=float)
    lows = np.array([c["l"] for c in candles], dtype=float)
    vols = np.array([c["v"] for c in candles], dtype=float)
    i = len(closes) - 1
    rsi14 = ind.rsi(closes.tolist(), 14)[-1] or 50.0
    macd_hist = ind.macd(closes.tolist())[2][-1] or 0.0
    atr14 = ind.atr(highs.tolist(), lows.tolist(), closes.tolist(), 14)[-1] or 0.0
    ema9 = ind.ema(closes.tolist(), 9)[-1] or float(closes[-1])
    ema21 = ind.ema(closes.tolist(), 21)[-1] or float(closes[-1])
    bb_u, _, bb_l = ind.bollinger(closes.tolist(), 20, 2.0)
    bbu = bb_u[-1] or float(closes[-1])
    bbl = bb_l[-1] or float(closes[-1])
    ret1 = float(np.log(closes[i] / closes[i - 1] + 1e-9))
    ret3 = float(np.log(closes[i] / closes[i - 3] + 1e-9))
    ret5 = float(np.log(closes[i] / closes[i - 5] + 1e-9))
    ret10 = float(np.log(closes[i] / closes[i - 10] + 1e-9))
    ema_spread = float((ema9 - ema21) / closes[i])
    atr_pct = float(atr14 / closes[i])
    vol_change = float(np.log((vols[i] + 1) / (vols[i - 1] + 1)))
    denom = max(bbu - bbl, 1e-9)
    bb_pos = float((closes[i] - bbl) / denom)
    return np.array([[ret1, ret3, ret5, ret10, float(rsi14), float(macd_hist), atr_pct, ema_spread, vol_change, bb_pos]], dtype=float)


def train_or_load(symbol: str, candles: List[dict]) -> dict:
    """Return cached model or train one on the provided history.

    Uses a chronological 80/20 train/holdout split so we can report an
    honest out-of-sample R² and direction-accuracy. The in-sample R²
    we used to report was meaningless — it just measures how well the
    model memorises its training data, not how it'll predict the future.
    """
    cached = _MODELS.get(symbol)
    if cached and cached.get("n_train", 0) >= len(candles) - 50:
        return cached
    X, y = _engineer(candles)
    if X.shape[0] < 50:
        return {"model": None, "n_train": 0, "trained_at": 0, "score": None}

    # Chronological split — never shuffle time series for validation.
    split = int(X.shape[0] * 0.8)
    X_tr, X_ho = X[:split], X[split:]
    y_tr, y_ho = y[:split], y[split:]

    model = RandomForestRegressor(
        n_estimators=80,
        max_depth=6,
        min_samples_leaf=4,
        n_jobs=int(os.getenv("ML_THREADS", "1")),
        random_state=42,
    )
    t0 = time.time()
    model.fit(X_tr, y_tr)
    elapsed = time.time() - t0

    # Out-of-sample metrics — what actually matters for predicting the future.
    if X_ho.shape[0] >= 10:
        y_pred_ho = model.predict(X_ho)
        # Direction accuracy: fraction of holdout bars where sign(pred) == sign(actual).
        # This is the metric you should look at for a trading model.
        # Treat near-zero predictions / actuals as "flat" (no direction call).
        eps = 1e-4
        directional_hits = 0
        directional_total = 0
        for pred, act in zip(y_pred_ho, y_ho):
            if abs(act) < eps:
                continue
            directional_total += 1
            if (pred > 0 and act > 0) or (pred < 0 and act < 0):
                directional_hits += 1
        dir_acc = (directional_hits / directional_total) if directional_total > 0 else 0.0
        # Out-of-sample R² (can be negative for a bad model — that's the truth).
        oos_r2 = float(1.0 - np.sum((y_ho - y_pred_ho) ** 2) / max(np.sum((y_ho - y_ho.mean()) ** 2), 1e-12))
        oos_residual_std = float(np.std(y_ho - y_pred_ho))
    else:
        dir_acc = 0.0
        oos_r2 = 0.0
        oos_residual_std = float(np.std(y_tr)) if y_tr.size else 0.0

    # Refit on full data for production prediction (use all available info).
    model.fit(X, y)
    out = {
        "model": model,
        "n_train": int(X.shape[0]),
        "trained_at": int(time.time()),
        "train_ms": int(elapsed * 1000),
        # Field names below match the trained-ensemble path in ml_training.py
        # and the frontend PredictionCard.tsx so the legacy /predict fallback
        # renders correctly in the UI.
        "oos_r2": round(oos_r2, 4),
        "direction_accuracy_pct": round(dir_acc * 100.0, 2),
        "oos_residual_std": float(oos_residual_std),
    }
    _MODELS[symbol] = out
    return out


def predict_next(candles: List[dict], symbol: str, horizon: int = 5) -> dict:
    info = train_or_load(symbol, candles)
    model = info.get("model")
    if model is None:
        return {
            "symbol": symbol,
            "ready": False,
            "reason": "not enough history to train",
            "trainSamples": info.get("n_train", 0),
        }
    X = _features_for_last(candles)
    predicted_log_return = float(model.predict(X)[0])
    expected_pct = (np.exp(predicted_log_return) - 1.0) * 100
    last_close = float(candles[-1]["c"])
    predicted_price = float(np.exp(predicted_log_return) * last_close)
    direction = "UP" if predicted_log_return > 0.0005 else "DOWN" if predicted_log_return < -0.0005 else "FLAT"

    # Honest confidence: anchored to MEASURED out-of-sample directional accuracy
    # of THIS model, NOT to the magnitude of the current prediction.
    # A model that has never been right on holdout data deserves low confidence
    # even if today it predicts a huge move.
    dir_acc = float(info.get("direction_accuracy_pct", 0.0)) / 100.0
    residual_std = float(info.get("oos_residual_std", 0.0)) or 0.01
    # Two factors:
    #   (a) baseline = how often this model gets direction right OOS (0.5 = random)
    #   (b) signal-to-noise = predicted magnitude relative to typical residual
    #       (caps at 1.0 — a prediction far inside the noise floor adds nothing).
    snr = min(1.0, abs(predicted_log_return) / max(residual_std, 1e-6))
    # Blend: skill matters more than magnitude.
    base = max(0.0, dir_acc - 0.5) * 2.0  # 0.5 → 0, 0.75 → 0.5, 1.0 → 1.0
    confidence = round(min(0.95, 0.7 * base + 0.3 * snr), 3)

    importances = model.feature_importances_.tolist()
    return {
        "symbol": symbol,
        "ready": True,
        "horizonBars": horizon,
        "predictedLogReturn": round(predicted_log_return, 5),
        "predictedReturnPct": round(expected_pct, 3),
        "predictedPrice": round(predicted_price, 2),
        "lastPrice": round(last_close, 2),
        "direction": direction,
        "confidence": confidence,
        "model": {
            "type": "RandomForestRegressor",
            "trainSamples": info["n_train"],
            "trainMs": info.get("train_ms"),
            # Use the same key names as the trained-ensemble path so the
            # frontend PredictionCard renders the OOS metrics in both cases.
            "inSampleR2": None,
            "outOfSampleR2": info.get("oos_r2"),
            "directionAccuracyPct": info.get("direction_accuracy_pct"),
            "oosResidualStd": round(residual_std, 6),
            "featureImportance": dict(zip(FEATURES, [round(x, 4) for x in importances])),
        },
    }
