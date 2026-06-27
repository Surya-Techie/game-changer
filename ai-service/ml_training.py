"""Real ML training pipeline.

Honest approach to "more accurate" predictions:
  • Larger feature set (~30 features with multiple lookback horizons)
  • Ensemble of RandomForest + GradientBoosting + MLP
  • TimeSeriesSplit cross-validation (no look-ahead leakage)
  • Walk-forward train/test (out-of-sample R² + direction accuracy)
  • Models persisted per-symbol to disk
  • Training metrics returned so the UI can show what's real vs over-fit

What this does NOT do:
  • Promise profit. On random-walk mock data the achievable OOS R² is
    capped by the autocorrelation that's actually in the series.
  • Replace the need for real broker data — on real intraday ticks the
    same pipeline produces meaningfully different numbers.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import joblib
import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import (
    GradientBoostingClassifier,
    GradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler

# sklearn 1.6+ replaced `CalibratedClassifierCV(..., cv="prefit")` with the
# `FrozenEstimator` wrapper. Older versions kept the string form. We tolerate
# either path so the file works across sklearn versions.
try:
    from sklearn.frozen import FrozenEstimator  # sklearn ≥ 1.6
    _HAS_FROZEN = True
except ImportError:  # pragma: no cover
    FrozenEstimator = None  # type: ignore[assignment]
    _HAS_FROZEN = False

import indicators as ind

# --------------------------------------------------------------------- features

# Feature set — duplicate `logret_*` features removed (they were identical to
# `ret_*`). Added: ATR-normalised returns (`ret_X_atr`), realised-skew, and
# a short-vs-long volatility ratio. These are designed to be *more
# stationary* than raw returns, which is what tree models actually need to
# generalise out-of-sample.
FEATURE_NAMES = [
    "ret_1", "ret_3", "ret_5", "ret_10", "ret_20", "ret_50",
    "ret_5_atr", "ret_10_atr", "ret_20_atr",          # vol-normalised returns
    "vol_5", "vol_20", "vol_50",
    "vol_ratio_5_20",                                 # short-vs-long vol regime
    "skew_20",                                        # realised return skew
    "rsi_14", "rsi_5",
    "macd_hist", "macd_line",
    "ema_dist_9", "ema_dist_21", "ema_dist_50",
    "ema_spread_9_21", "ema_spread_21_50",
    "bb_pct", "atr_pct",
    "volume_z", "volume_change",
    "tod_sin", "tod_cos",
    "high_break", "low_break",
    "range_ratio",
]
N_FEATURES = len(FEATURE_NAMES)


def _safe_log_div(num: np.ndarray, den: np.ndarray) -> np.ndarray:
    """log(num/den) but tolerant of zeros/negatives — returns 0 for bad rows."""
    den_safe = np.where(den > 0, den, np.nan)
    num_safe = np.where(num > 0, num, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.log(num_safe / den_safe)
    return np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)


def build_features(candles: List[dict]) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Build (X, y_scaled, sample_times, vol_scalers).

    y is the future log-return divided by the bar's 20-bar realised
    volatility, which keeps the target stationary across regimes. The
    `vol_scalers` array is the per-row scaler so callers can de-scale
    a prediction back to a nominal % return.
    """
    if len(candles) < 80:
        return (
            np.empty((0, N_FEATURES)),
            np.empty((0,)),
            np.empty((0,)),
            np.empty((0,)),
        )

    closes = np.array([float(c["c"]) for c in candles], dtype=float)
    highs = np.array([float(c["h"]) for c in candles], dtype=float)
    lows = np.array([float(c["l"]) for c in candles], dtype=float)
    vols = np.array([float(c["v"]) for c in candles], dtype=float)
    times = np.array([int(c["t"]) for c in candles], dtype=np.int64)

    # Pre-compute indicator series.
    rsi14 = np.array([v if v is not None else 50.0 for v in ind.rsi(closes.tolist(), 14)])
    rsi5 = np.array([v if v is not None else 50.0 for v in ind.rsi(closes.tolist(), 5)])
    _macd_line, _macd_sig, macd_hist = ind.macd(closes.tolist())
    macd_hist = np.array([v if v is not None else 0.0 for v in macd_hist])
    macd_line = np.array([v if v is not None else 0.0 for v in _macd_line])
    ema9 = np.array([v if v is not None else closes[i] for i, v in enumerate(ind.ema(closes.tolist(), 9))])
    ema21 = np.array([v if v is not None else closes[i] for i, v in enumerate(ind.ema(closes.tolist(), 21))])
    ema50 = np.array([v if v is not None else closes[i] for i, v in enumerate(ind.ema(closes.tolist(), 50))])
    bb_u, bb_m, bb_l = ind.bollinger(closes.tolist(), 20, 2.0)
    bb_u = np.array([v if v is not None else closes[i] for i, v in enumerate(bb_u)])
    bb_l = np.array([v if v is not None else closes[i] for i, v in enumerate(bb_l)])
    bb_m = np.array([v if v is not None else closes[i] for i, v in enumerate(bb_m)])
    atr14 = np.array([v if v is not None else 0.0 for v in ind.atr(highs.tolist(), lows.tolist(), closes.tolist(), 14)])

    horizon = 5
    n = len(candles)
    rows: List[List[float]] = []
    targets: List[float] = []
    sample_ts: List[int] = []
    vol_scalers: List[float] = []

    for i in range(50, n - horizon):
        ret_1 = _safe_log_div(closes[i:i + 1], closes[i - 1:i])[0]
        ret_3 = _safe_log_div(closes[i:i + 1], closes[i - 3:i - 2])[0]
        ret_5 = _safe_log_div(closes[i:i + 1], closes[i - 5:i - 4])[0]
        ret_10 = _safe_log_div(closes[i:i + 1], closes[i - 10:i - 9])[0]
        ret_20 = _safe_log_div(closes[i:i + 1], closes[i - 20:i - 19])[0]
        ret_50 = _safe_log_div(closes[i:i + 1], closes[i - 50:i - 49])[0]
        # rolling volatility (std of log returns).
        recent_log = np.diff(np.log(closes[max(0, i - 50):i + 1] + 1e-9))
        vol_5 = float(np.std(recent_log[-5:])) if len(recent_log) >= 5 else 0.0
        vol_20 = float(np.std(recent_log[-20:])) if len(recent_log) >= 20 else 0.0
        vol_50 = float(np.std(recent_log)) if len(recent_log) > 0 else 0.0
        ema_dist_9 = (closes[i] - ema9[i]) / closes[i]
        ema_dist_21 = (closes[i] - ema21[i]) / closes[i]
        ema_dist_50 = (closes[i] - ema50[i]) / closes[i]
        ema_spread_9_21 = (ema9[i] - ema21[i]) / closes[i]
        ema_spread_21_50 = (ema21[i] - ema50[i]) / closes[i]
        bb_width = bb_u[i] - bb_l[i]
        bb_pct = (closes[i] - bb_l[i]) / (bb_width + 1e-9)
        atr_pct = atr14[i] / closes[i] if closes[i] > 0 else 0.0
        vol_mean20 = np.mean(vols[max(0, i - 20):i + 1])
        vol_std20 = np.std(vols[max(0, i - 20):i + 1])
        volume_z = (vols[i] - vol_mean20) / (vol_std20 + 1e-9)
        volume_change = _safe_log_div(vols[i:i + 1] + 1, vols[i - 1:i] + 1)[0]
        # Time-of-day cyclic encoding (minute of day → sin/cos).
        dt_min = (times[i] // 60_000) % (24 * 60)
        tod_angle = 2 * np.pi * dt_min / (24 * 60)
        tod_sin = float(np.sin(tod_angle))
        tod_cos = float(np.cos(tod_angle))
        # Breakouts vs prior 20-bar high/low.
        prior_hi = float(np.max(highs[max(0, i - 20):i]))
        prior_lo = float(np.min(lows[max(0, i - 20):i]))
        high_break = 1.0 if closes[i] > prior_hi else 0.0
        low_break = 1.0 if closes[i] < prior_lo else 0.0
        range_ratio = (highs[i] - lows[i]) / (atr14[i] + 1e-9) if atr14[i] > 0 else 0.0

        # ATR-normalised returns: how many ATR units did price move? This
        # is the same input you would feed a human technical analyst —
        # stationary across price levels and volatility regimes.
        atr_now = float(atr14[i]) if atr14[i] > 0 else 1e-9
        ret_5_atr = (closes[i] - closes[i - 5]) / (atr_now * (5 ** 0.5))
        ret_10_atr = (closes[i] - closes[i - 10]) / (atr_now * (10 ** 0.5))
        ret_20_atr = (closes[i] - closes[i - 20]) / (atr_now * (20 ** 0.5))
        # Vol regime: short-vs-long. >1 = volatility expanding, <1 = contracting.
        vol_ratio_5_20 = (vol_5 + 1e-9) / (vol_20 + 1e-9)
        # Realised skew of last 20 log returns. Strong skew → trend bias.
        if len(recent_log) >= 20:
            window = recent_log[-20:]
            m = float(np.mean(window))
            sd = float(np.std(window))
            skew_20 = float(np.mean(((window - m) / (sd + 1e-9)) ** 3)) if sd > 1e-12 else 0.0
        else:
            skew_20 = 0.0

        rows.append([
            float(ret_1), float(ret_3), float(ret_5), float(ret_10), float(ret_20), float(ret_50),
            float(ret_5_atr), float(ret_10_atr), float(ret_20_atr),
            vol_5, vol_20, vol_50,
            float(vol_ratio_5_20),
            float(skew_20),
            float(rsi14[i]), float(rsi5[i]),
            float(macd_hist[i]), float(macd_line[i]),
            float(ema_dist_9), float(ema_dist_21), float(ema_dist_50),
            float(ema_spread_9_21), float(ema_spread_21_50),
            float(bb_pct), float(atr_pct),
            float(volume_z), float(volume_change),
            tod_sin, tod_cos,
            high_break, low_break,
            float(range_ratio),
        ])
        # Volatility-scaled target: future return / current 20-bar vol.
        # Two reasons: (a) the target is now stationary across regimes,
        # (b) tree splits learn "X stds of move expected" instead of fitting
        # raw absolute-return ranges that vary by symbol and date. We still
        # convert back to a nominal % at prediction time.
        future_log_ret = float(_safe_log_div(closes[i + horizon:i + horizon + 1], closes[i:i + 1])[0])
        scaler_vol = vol_20 if vol_20 > 1e-6 else 1.0
        targets.append(future_log_ret / scaler_vol)
        sample_ts.append(int(times[i]))
        vol_scalers.append(float(scaler_vol))

    return (
        np.array(rows, dtype=float),
        np.array(targets, dtype=float),
        np.array(sample_ts, dtype=np.int64),
        np.array(vol_scalers, dtype=float),
    )


# ----------------------------------------------------------------------- models

@dataclass
class TrainedModel:
    symbol: str
    trained_at: int
    horizon_bars: int
    n_features: int
    n_train: int
    n_test: int
    feature_names: List[str]
    feature_importance: Dict[str, float]
    in_sample_r2: float
    oos_r2: float
    direction_accuracy_pct: float
    # Calibrated-probability holdout metrics — measured on the calibrated
    # classifier, NOT the regressor. These are what the UI confidence
    # should be anchored to: a model that hits ~55% direction-accuracy out
    # of sample with a Brier score below 0.25 has small but real edge.
    brier_score: float = 0.25            # 0 = perfect, 0.25 = coin flip
    log_loss_holdout: float = 0.693      # log(2) = coin flip
    cv_r2_mean: float = 0.0
    cv_r2_std: float = 0.0
    train_ms: int = 0
    rf: object = field(repr=False, default=None)
    gbm: object = field(repr=False, default=None)
    mlp: object = field(repr=False, default=None)
    scaler: object = field(repr=False, default=None)
    # Calibrated classifier for direction (up vs down). Used to produce the
    # confidence that the UI shows.
    clf_calibrated: object = field(repr=False, default=None)
    # Median target-scaler from training (used to de-scale predictions
    # back to a nominal % return when the live vol scaler isn't available).
    median_vol_scaler: float = 0.01

    def to_metrics_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "trainedAt": self.trained_at,
            "horizonBars": self.horizon_bars,
            "nFeatures": self.n_features,
            "nTrain": self.n_train,
            "nTest": self.n_test,
            "inSampleR2": round(self.in_sample_r2, 4),
            "outOfSampleR2": round(self.oos_r2, 4),
            "directionAccuracyPct": round(self.direction_accuracy_pct, 2),
            "brierScore": round(self.brier_score, 4),
            "logLoss": round(self.log_loss_holdout, 4),
            "cvR2Mean": round(self.cv_r2_mean, 4),
            "cvR2Std": round(self.cv_r2_std, 4),
            "trainMs": self.train_ms,
            "featureImportance": {k: round(v, 4) for k, v in self.feature_importance.items()},
        }


# ----------------------------------------------------------------------- training

MODEL_DIR = Path(os.getenv("QTI_MODEL_DIR", "/tmp/qti-models"))
MODEL_DIR.mkdir(parents=True, exist_ok=True)

_LIVE_MODELS: Dict[str, TrainedModel] = {}


def _persist(model: TrainedModel) -> None:
    path = MODEL_DIR / f"{model.symbol}.pkl"
    payload = {
        "symbol": model.symbol,
        "trained_at": model.trained_at,
        "rf": model.rf,
        "gbm": model.gbm,
        "mlp": model.mlp,
        "scaler": model.scaler,
        "clf_calibrated": model.clf_calibrated,
        "median_vol_scaler": model.median_vol_scaler,
        "metrics": model.to_metrics_dict(),
    }
    joblib.dump(payload, path)
    metadata_path = MODEL_DIR / "registry.json"
    registry: dict = {}
    if metadata_path.exists():
        try:
            registry = json.loads(metadata_path.read_text())
        except Exception:
            registry = {}
    registry[model.symbol] = model.to_metrics_dict()
    metadata_path.write_text(json.dumps(registry, indent=2))


def _load(symbol: str) -> Optional[TrainedModel]:
    if symbol in _LIVE_MODELS:
        return _LIVE_MODELS[symbol]
    path = MODEL_DIR / f"{symbol}.pkl"
    if not path.exists():
        return None
    try:
        payload = joblib.load(path)
        metrics = payload.get("metrics", {})
        m = TrainedModel(
            symbol=symbol,
            trained_at=payload.get("trained_at", 0),
            horizon_bars=metrics.get("horizonBars", 5),
            n_features=metrics.get("nFeatures", N_FEATURES),
            n_train=metrics.get("nTrain", 0),
            n_test=metrics.get("nTest", 0),
            feature_names=FEATURE_NAMES,
            feature_importance=metrics.get("featureImportance", {}),
            in_sample_r2=metrics.get("inSampleR2", 0.0),
            oos_r2=metrics.get("outOfSampleR2", 0.0),
            direction_accuracy_pct=metrics.get("directionAccuracyPct", 0.0),
            brier_score=metrics.get("brierScore", 0.25),
            log_loss_holdout=metrics.get("logLoss", 0.693),
            cv_r2_mean=metrics.get("cvR2Mean", 0.0),
            cv_r2_std=metrics.get("cvR2Std", 0.0),
            train_ms=metrics.get("trainMs", 0),
            rf=payload.get("rf"),
            gbm=payload.get("gbm"),
            mlp=payload.get("mlp"),
            scaler=payload.get("scaler"),
            clf_calibrated=payload.get("clf_calibrated"),
            median_vol_scaler=payload.get("median_vol_scaler", 0.01),
        )
        _LIVE_MODELS[symbol] = m
        return m
    except Exception:
        return None


def train_symbol(symbol: str, candles: List[dict], horizon: int = 5) -> dict:
    t0 = time.time()
    X, y, _ts, vol_scalers = build_features(candles)
    if X.shape[0] < 80:
        return {"error": f"not enough samples ({X.shape[0]}; need ≥ 80)"}

    # Walk-forward split: 70% train, 15% calibration, 15% holdout (chronological).
    # The middle calibration block is essential — using the same holdout to
    # both fit the probability calibrator and report accuracy would leak.
    n = X.shape[0]
    split_train = int(n * 0.70)
    split_cal = int(n * 0.85)
    X_train, y_train = X[:split_train], y[:split_train]
    X_cal, y_cal = X[split_train:split_cal], y[split_train:split_cal]
    X_test, y_test = X[split_cal:], y[split_cal:]
    vol_test = vol_scalers[split_cal:]

    scaler = StandardScaler().fit(X_train)
    X_train_s = scaler.transform(X_train)
    X_test_s = scaler.transform(X_test)

    # Three models.
    rf = RandomForestRegressor(
        n_estimators=200, max_depth=8, min_samples_leaf=4,
        n_jobs=int(os.getenv("ML_THREADS", "1")), random_state=42,
    )
    gbm = GradientBoostingRegressor(
        n_estimators=200, max_depth=4, learning_rate=0.04,
        min_samples_leaf=4, random_state=42,
    )
    mlp = MLPRegressor(
        hidden_layer_sizes=(48, 24), max_iter=300, early_stopping=True,
        learning_rate_init=0.005, random_state=42,
    )

    rf.fit(X_train, y_train)        # tree models don't need scaling
    gbm.fit(X_train, y_train)
    mlp.fit(X_train_s, y_train)

    def ensemble_predict(Xa: np.ndarray, Xs: np.ndarray) -> np.ndarray:
        return (rf.predict(Xa) + gbm.predict(Xa) + mlp.predict(Xs)) / 3.0

    in_pred = ensemble_predict(X_train, X_train_s)
    test_pred = ensemble_predict(X_test, X_test_s)

    def r2(actual: np.ndarray, pred: np.ndarray) -> float:
        ss_res = float(np.sum((actual - pred) ** 2))
        ss_tot = float(np.sum((actual - actual.mean()) ** 2))
        return 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    in_sample_r2 = r2(y_train, in_pred)
    oos_r2 = r2(y_test, test_pred)

    # ── Classification head + probability calibration ────────────────────
    # The regression head outputs a noisy point estimate. The classifier
    # outputs P(future_return > 0). Trained on the *same* features but a
    # *different* target (the sign), it almost always generalises better
    # than thresholding the regressor. We then run isotonic calibration on
    # the calibration block so the probabilities are interpretable as
    # "right X% of the time".
    y_train_cls = (y_train > 0).astype(int)
    y_cal_cls = (y_cal > 0).astype(int)
    y_test_cls = (y_test > 0).astype(int)

    # Skip calibration if the calibration block is degenerate (one class only).
    can_calibrate = (
        X_cal.shape[0] >= 20
        and len(np.unique(y_train_cls)) == 2
        and len(np.unique(y_cal_cls)) == 2
    )

    clf_calibrated = None
    brier_score = 0.25
    log_loss_holdout = 0.693
    if can_calibrate:
        gb_clf = GradientBoostingClassifier(
            n_estimators=200, max_depth=3, learning_rate=0.05,
            min_samples_leaf=8, random_state=42,
        )
        gb_clf.fit(X_train, y_train_cls)
        # Isotonic calibration is non-parametric and overfits when the
        # calibration block is small (<150 samples) — it can collapse
        # probabilities to near-0/near-1 which then blow up LogLoss on a
        # single misclassification. Sigmoid (Platt) is a parametric
        # 2-parameter fit, far more stable when calibration data is scarce.
        calibration_method = "isotonic" if X_cal.shape[0] >= 150 else "sigmoid"
        # Pre-fit the base classifier on train, then calibrate on the held-out
        # block. sklearn ≥ 1.6 requires the `FrozenEstimator` wrapper; older
        # versions accept cv="prefit".
        if _HAS_FROZEN:
            clf_calibrated = CalibratedClassifierCV(
                FrozenEstimator(gb_clf), method=calibration_method, cv=None
            )
        else:
            clf_calibrated = CalibratedClassifierCV(gb_clf, method=calibration_method, cv="prefit")
        clf_calibrated.fit(X_cal, y_cal_cls)
        # Honest holdout metrics.
        if X_test.shape[0] >= 10 and len(np.unique(y_test_cls)) == 2:
            # Clip probabilities to [0.02, 0.98] before log-loss so a single
            # over-confident miss can't make the holdout metric meaningless.
            proba_test_raw = clf_calibrated.predict_proba(X_test)[:, 1]
            proba_test = np.clip(proba_test_raw, 0.02, 0.98)
            brier_score = float(np.mean((proba_test - y_test_cls) ** 2))
            log_loss_holdout = float(
                -np.mean(
                    y_test_cls * np.log(proba_test)
                    + (1 - y_test_cls) * np.log(1.0 - proba_test)
                )
            )

    # Direction accuracy on OOS — use the CLASSIFIER (calibrated probability
    # > 0.5), not sign(regressor). The classifier is the head the UI uses
    # for confidence so directional-accuracy should be measured on it.
    if clf_calibrated is not None and X_test.shape[0] > 0:
        proba_test = clf_calibrated.predict_proba(X_test)[:, 1]
        # Only score directional bets where the model has *some* conviction
        # (probability away from 0.5 by ≥ 5 pp). This is what you'd actually
        # trade on — flat-coin predictions don't count.
        conviction_mask = np.abs(proba_test - 0.5) >= 0.05
        if conviction_mask.sum() > 0:
            pred_dir = (proba_test[conviction_mask] >= 0.5).astype(int)
            actual_dir = y_test_cls[conviction_mask]
            direction_acc = float((pred_dir == actual_dir).mean() * 100)
        else:
            direction_acc = 50.0
    else:
        # Fall back to regressor sign-accuracy if no calibrated classifier.
        dir_actual = np.sign(y_test)
        dir_pred = np.sign(test_pred)
        mask = np.abs(test_pred) > 1e-4
        direction_acc = float((dir_actual[mask] == dir_pred[mask]).mean() * 100) if mask.sum() > 0 else 50.0

    # Time-series cross-validation on the training portion only.
    cv_scores: List[float] = []
    if X_train.shape[0] >= 60:
        tss = TimeSeriesSplit(n_splits=5)
        for fold_train, fold_test in tss.split(X_train):
            rf_cv = RandomForestRegressor(n_estimators=100, max_depth=6, n_jobs=1, random_state=42)
            rf_cv.fit(X_train[fold_train], y_train[fold_train])
            pred = rf_cv.predict(X_train[fold_test])
            cv_scores.append(r2(y_train[fold_test], pred))
    cv_mean = float(np.mean(cv_scores)) if cv_scores else 0.0
    cv_std = float(np.std(cv_scores)) if cv_scores else 0.0

    # Feature importance from RF (most interpretable of the three).
    fi = dict(zip(FEATURE_NAMES, rf.feature_importances_.tolist()))

    elapsed_ms = int((time.time() - t0) * 1000)
    median_vs = float(np.median(vol_scalers)) if vol_scalers.size else 0.01
    model = TrainedModel(
        symbol=symbol,
        trained_at=int(time.time()),
        horizon_bars=horizon,
        n_features=N_FEATURES,
        n_train=int(X_train.shape[0]),
        n_test=int(X_test.shape[0]),
        feature_names=FEATURE_NAMES,
        feature_importance=fi,
        in_sample_r2=in_sample_r2,
        oos_r2=oos_r2,
        direction_accuracy_pct=direction_acc,
        brier_score=brier_score,
        log_loss_holdout=log_loss_holdout,
        cv_r2_mean=cv_mean,
        cv_r2_std=cv_std,
        train_ms=elapsed_ms,
        rf=rf, gbm=gbm, mlp=mlp, scaler=scaler,
        clf_calibrated=clf_calibrated,
        median_vol_scaler=max(median_vs, 1e-6),
    )
    _LIVE_MODELS[symbol] = model
    _persist(model)
    return model.to_metrics_dict()


def predict_with_trained(symbol: str, candles: List[dict]) -> dict:
    model = _load(symbol)
    if model is None:
        return {"ready": False, "reason": "no trained model — call /ml/train first"}
    X, _y, _t, vol_scalers = build_features(candles)
    if X.shape[0] == 0:
        return {"ready": False, "reason": "not enough history to predict"}
    x_last = X[-1:].copy()
    x_last_s = model.scaler.transform(x_last)
    # Each model returns a VOL-SCALED log-return (target was log_ret/vol_20
    # during training). We de-scale here using the latest bar's vol_20 so
    # the % reported to the UI is on the right scale.
    raw_scaled = np.array([
        float(model.rf.predict(x_last)[0]),
        float(model.gbm.predict(x_last)[0]),
        float(model.mlp.predict(x_last_s)[0]),
    ])
    # Clip in scaled space (±5 stds) — that is the universe the model was
    # trained on. Translates to ±5 × σ in nominal % space.
    clipped = np.clip(raw_scaled, -5.0, 5.0)
    # De-scale using the current bar's volatility, falling back to the
    # training median if anything went wrong.
    live_vol = float(vol_scalers[-1]) if vol_scalers.size > 0 and vol_scalers[-1] > 0 else model.median_vol_scaler
    rf_p = float(clipped[0]) * live_vol
    gbm_p = float(clipped[1]) * live_vol
    mlp_p = float(clipped[2]) * live_vol
    ensemble = float(np.median([rf_p, gbm_p, mlp_p]))  # median = robust to one outlier
    # Final hard cap at ±5% nominal — extreme tails are almost always
    # spurious for a 5-bar forward horizon, and the UI should never show
    # a prediction larger than what the model has any business making.
    ensemble = max(-0.05, min(0.05, ensemble))
    exp_pct = (np.exp(ensemble) - 1.0) * 100
    last_close = float(candles[-1]["c"])
    predicted_price = float(np.exp(ensemble) * last_close)

    # ── Calibrated probability + honest confidence ───────────────────────
    # If we have a calibrated classifier, P(UP) is the *direct, calibrated*
    # probability of next-N-bar > 0. The confidence reported to the UI is
    # the distance from 0.5, scaled and capped — this is what "55% chance
    # the next candle is up" actually means. The direction shown is the
    # classifier's call (not the noisier regressor).
    proba_up = None
    if model.clf_calibrated is not None:
        try:
            raw_proba = float(model.clf_calibrated.predict_proba(x_last)[0, 1])
            # Mirror the [0.02, 0.98] clip used during holdout — guarantees
            # the UI never shows a fake "99.9% certainty" number that the
            # calibrator can't actually justify.
            proba_up = max(0.02, min(0.98, raw_proba))
        except Exception:
            proba_up = None

    if proba_up is not None:
        # Direction comes from the classifier when we have one.
        direction = "UP" if proba_up >= 0.55 else "DOWN" if proba_up <= 0.45 else "FLAT"
        # ── Honest confidence formula ──────────────────────────────────
        # confidence = conviction × skill
        #   conviction = how far P(UP) is from 0.5 (calibrated, 0..1)
        #   skill      = blended evidence that THIS model has real edge,
        #                from two independent holdout metrics:
        #                  edge_score = (0.25 - Brier) / 0.05, clipped to [0,1]
        #                                  Brier 0.20 → 1.0, Brier 0.25 → 0
        #                  dir_score  = (dir_acc - 0.5) × 5, clipped to [0,1]
        #                                  70% acc → 1.0, 50% acc → 0
        # The result is correctly ZERO when the model has no demonstrated
        # edge (Brier ≥ 0.25 AND dir_acc ≤ 50%) no matter how confidently
        # it predicts today.
        edge_score = max(0.0, min(1.0, (0.25 - model.brier_score) / 0.05))
        dir_score = max(0.0, min(1.0, (model.direction_accuracy_pct / 100.0 - 0.5) * 5.0))
        skill = (edge_score + dir_score) / 2.0
        conviction = abs(proba_up - 0.5) * 2.0                  # 0..1
        confidence = round(min(0.95, conviction * skill), 3)
    else:
        direction = "UP" if ensemble > 5e-4 else "DOWN" if ensemble < -5e-4 else "FLAT"
        # No classifier → fall back to magnitude × OOS-evidence, capped low
        # because the regressor is the weaker head.
        base_conf = max(0.0, min(0.4, abs(exp_pct) / 1.0))
        oos_factor = max(0.0, model.oos_r2)
        confidence = round(min(0.6, base_conf + oos_factor * 0.4), 3)

    return {
        "ready": True,
        "symbol": symbol,
        "horizonBars": model.horizon_bars,
        "predictedLogReturn": round(ensemble, 5),
        "predictedReturnPct": round(exp_pct, 3),
        "predictedPrice": round(predicted_price, 2),
        "lastPrice": round(last_close, 2),
        "direction": direction,
        "confidence": confidence,
        # P(UP) directly from the calibrated classifier. Anything in
        # [0.45, 0.55] is essentially "no call".
        "probUp": round(proba_up, 4) if proba_up is not None else None,
        "ensemble": {
            "rf": round((np.exp(rf_p) - 1) * 100, 3),
            "gbm": round((np.exp(gbm_p) - 1) * 100, 3),
            "mlp": round((np.exp(mlp_p) - 1) * 100, 3),
        },
        "model": {
            "type": "RF+GBM+MLP regression + calibrated GB classifier",
            "trainSamples": model.n_train,
            "testSamples": model.n_test,
            "inSampleR2": round(model.in_sample_r2, 4),
            "outOfSampleR2": round(model.oos_r2, 4),
            "directionAccuracyPct": round(model.direction_accuracy_pct, 2),
            # Brier ≤ 0.20 = the model has real, calibrated edge.
            # Brier ≈ 0.25 = coin flip in disguise; ignore the prediction.
            "brierScore": round(model.brier_score, 4),
            "logLoss": round(model.log_loss_holdout, 4),
            "cvR2Mean": round(model.cv_r2_mean, 4),
            "cvR2Std": round(model.cv_r2_std, 4),
            "trainedAt": model.trained_at,
            "ageSec": int(time.time()) - model.trained_at,
            "featureImportance": {k: round(v, 4) for k, v in sorted(model.feature_importance.items(), key=lambda x: -x[1])[:8]},
        },
    }


def registry() -> dict:
    metadata_path = MODEL_DIR / "registry.json"
    if not metadata_path.exists():
        return {"models": {}}
    try:
        return {"models": json.loads(metadata_path.read_text())}
    except Exception:
        return {"models": {}}
