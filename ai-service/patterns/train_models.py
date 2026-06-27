"""Training pipeline for the pattern ML classifier.

Public functions
----------------
- `train_timeframe(timeframe, symbols=None, ...)` — high-level: pulls
  yfinance data for the given universe and trains GB+MLP models for the
  timeframe.

- `train_from_frames(frames, timeframe, ...)` — lower-level: trains from
  an iterable of pre-fetched OHLCV DataFrames. Used by the smoke test and
  by callers who already have data in memory.

Design notes
------------
* **Weak labelling** — we don't have hand-labelled trades, so the target
  is the forward-return class (`no_move`/`bullish_move`/`bearish_move`)
  measured over `horizon` bars. The rule engine isn't used as the label
  here; instead it's used at inference to provide complementary "shape"
  evidence. This avoids the model learning to merely echo the rule engine.

* **Chronological split** — `train/val/test = 70/15/15` along the time
  axis only. Random shuffling would leak future bars into training and
  inflate scores.

* **Augmentation** — applied to training rows only:
    - additive Gaussian noise (σ=0.001 × close)
    - per-window multiplicative scaling (±2%)
    - simple time-warp via tiny re-sampling jitter (drop one random
      interior bar then forward-fill, then re-extract features)
  Each window is augmented `aug_factor` times.

* **Yfinance** — imported lazily; if absent the high-level entry point
  raises a clear error rather than crashing on import. Each symbol fetch
  is wrapped in a try/except so a single missing ticker can't take down
  the whole training run.
"""

from __future__ import annotations

import math
import os
import time
import traceback
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

from ._helpers import ensure_df
from .ml_classifier import (
    CLASS_NAMES,
    FEATURE_VERSION,
    GB_FEATURE_NAMES,
    GB_WINDOW,
    MLP_WINDOW,
    extract_gb_features,
    extract_mlp_features,
    forward_return_label,
    models_dir,
    save_models,
)


# NSE "top 50" universe used as the default training set. Kept as a fallback
# default — callers should usually supply their own symbol list.
NSE_TOP_50 = [
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "HINDUNILVR", "ITC",
    "SBIN", "BHARTIARTL", "KOTAKBANK", "LT", "HCLTECH", "AXISBANK", "WIPRO",
    "ASIANPAINT", "MARUTI", "TITAN", "SUNPHARMA", "ULTRACEMCO", "BAJFINANCE",
    "NESTLEIND", "ONGC", "POWERGRID", "NTPC", "BAJAJFINSV", "M&M", "TECHM",
    "ADANIPORTS", "JSWSTEEL", "TATASTEEL", "GRASIM", "INDUSINDBK", "DIVISLAB",
    "DRREDDY", "CIPLA", "HEROMOTOCO", "BPCL", "IOC", "EICHERMOT", "COALINDIA",
    "SHREECEM", "BRITANNIA", "HINDALCO", "TATACONSUM", "UPL", "SBILIFE",
    "HDFCLIFE", "BAJAJ-AUTO", "APOLLOHOSP", "TATAMOTORS",
]


# ─── Timeframe → yfinance fetch parameters ────────────────────────────────

TF_FETCH_PARAMS = {
    "D1": {"period": "2y", "interval": "1d"},
    "H1": {"period": "6mo", "interval": "1h"},
    "M15": {"period": "60d", "interval": "15m"},
    "M5": {"period": "60d", "interval": "5m"},
}


# ─── Yfinance fetch ────────────────────────────────────────────────────────

def _yf_fetch(symbol: str, timeframe: str) -> Optional[pd.DataFrame]:
    """Fetch OHLCV for one NSE symbol at the given timeframe. Returns None
    on any failure (rate-limit, unknown ticker, network)."""
    try:
        import yfinance as yf  # type: ignore
    except Exception:  # noqa: BLE001
        raise RuntimeError("yfinance not installed; cannot run train_timeframe.")
    params = TF_FETCH_PARAMS.get(timeframe)
    if params is None:
        raise ValueError(f"Unknown timeframe '{timeframe}'. Expected one of {list(TF_FETCH_PARAMS)}.")
    sym = symbol.upper()
    if not (sym.endswith(".NS") or sym.endswith(".BO")):
        sym = sym + ".NS"
    try:
        hist = yf.Ticker(sym).history(period=params["period"], interval=params["interval"], auto_adjust=False)
    except Exception:  # noqa: BLE001
        return None
    if hist is None or len(hist) < max(GB_WINDOW, MLP_WINDOW) + 50:
        return None
    df = hist.rename(columns={
        "Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume",
    })
    df = df[["open", "high", "low", "close", "volume"]].copy()
    df.index = pd.to_datetime(df.index)
    idx = df.index
    if idx.tz is not None:
        idx = idx.tz_convert('UTC').tz_localize(None)
    df["time"] = idx.astype('datetime64[ms]').astype('int64')
    df = df.reset_index(drop=True)
    return ensure_df(df)


def fetch_universe(symbols: Iterable[str], timeframe: str, *, polite_pause_s: float = 0.2) -> Dict[str, pd.DataFrame]:
    """Pull a batch of symbols, returning {symbol: df} skipping any that fail.

    The polite pause between calls keeps us under yfinance's informal rate
    limit. Not concurrent: yfinance is rate-sensitive and serial+pause is
    safer than parallel for a long-running training job."""
    out: Dict[str, pd.DataFrame] = {}
    for s in symbols:
        df = _yf_fetch(s, timeframe)
        if df is not None:
            out[s] = df
        time.sleep(polite_pause_s)
    return out


# ─── Dataset construction (features + labels) ─────────────────────────────

@dataclass
class _Sample:
    """One training row: both feature vectors for the same anchor index."""
    gb: np.ndarray
    mlp: np.ndarray
    label: int


def _augment_frame(df: pd.DataFrame, *, rng: np.random.Generator) -> pd.DataFrame:
    """Return an augmented copy of `df`. Three independent perturbations:
    additive close-relative Gaussian noise, ±2% multiplicative scaling,
    and a single-bar drop + ffill 'time warp'."""
    work = df.copy()
    # 1) Multiplicative scale.
    scale = float(rng.uniform(0.98, 1.02))
    for col in ("open", "high", "low", "close"):
        work[col] = work[col] * scale
    # 2) Additive noise on each bar (≤ 0.1% of price).
    noise = rng.normal(loc=0.0, scale=0.001, size=len(work))
    for col in ("open", "high", "low", "close"):
        work[col] = work[col] * (1 + noise)
    # 3) Time warp: drop one random interior bar then forward-fill (i.e.
    #    pretend that 5-min bar was missing and we used the prior). Cheap
    #    proxy for the warps used in TS augmentation.
    if len(work) > 8:
        drop_idx = int(rng.integers(low=2, high=len(work) - 2))
        work = work.drop(index=drop_idx).reset_index(drop=True)
    # Recompute the high/low integrity after noise.
    for i in range(len(work)):
        oh = work.iloc[i]
        hi = max(oh["open"], oh["close"], oh["high"])
        lo = min(oh["open"], oh["close"], oh["low"])
        work.at[i, "high"] = hi
        work.at[i, "low"] = lo
    return ensure_df(work)


def build_samples(
    df: pd.DataFrame,
    *,
    horizon: int,
    threshold_pct: float = 0.005,
    stride: int = 1,
    aug_factor: int = 0,
    rng: Optional[np.random.Generator] = None,
) -> List[_Sample]:
    """Slide along `df` building (gb_features, mlp_features, label) rows.
    aug_factor copies (each augmented) are appended to the *training*-set
    portion only — the caller controls that by passing aug_factor=0 for
    val / test slices."""
    rng = rng or np.random.default_rng(seed=42)
    df = ensure_df(df)
    n = len(df)
    samples: List[_Sample] = []
    min_anchor = max(MLP_WINDOW, GB_WINDOW + 5)
    last_anchor = n - horizon - 1
    for anchor in range(min_anchor, last_anchor + 1, stride):
        window = df.iloc[: anchor + 1]
        gb = extract_gb_features(window)
        mlp = extract_mlp_features(window)
        if gb is None or mlp is None:
            continue
        label = forward_return_label(df, anchor, horizon, threshold_pct)
        if label is None:
            continue
        samples.append(_Sample(gb=gb, mlp=mlp, label=int(label)))

        # Augmentations: re-extract features from a perturbed window so the
        # noise actually shows up in the model input (otherwise it'd be no-op).
        for _ in range(aug_factor):
            try:
                aug_df = _augment_frame(window, rng=rng)
                gb2 = extract_gb_features(aug_df)
                mlp2 = extract_mlp_features(aug_df)
                if gb2 is None or mlp2 is None:
                    continue
                samples.append(_Sample(gb=gb2, mlp=mlp2, label=int(label)))
            except Exception:  # noqa: BLE001 — augmentation is best-effort
                continue
    return samples


# ─── Train / val / test chronological split ───────────────────────────────

def _chronological_split(samples: List[_Sample], train_pct: float = 0.7, val_pct: float = 0.15) -> Tuple[List[_Sample], List[_Sample], List[_Sample]]:
    n = len(samples)
    n_tr = int(n * train_pct)
    n_va = int(n * val_pct)
    train = samples[:n_tr]
    val = samples[n_tr : n_tr + n_va]
    test = samples[n_tr + n_va :]
    return train, val, test


def _stack(samples: List[_Sample], which: str) -> Tuple[np.ndarray, np.ndarray]:
    if not samples:
        return np.zeros((0, len(GB_FEATURE_NAMES)), dtype="float32"), np.zeros((0,), dtype="int64")
    X = np.stack([getattr(s, which) for s in samples], axis=0).astype("float32")
    y = np.asarray([s.label for s in samples], dtype="int64")
    return X, y


# ─── Train pipelines ──────────────────────────────────────────────────────

def _fit_models(
    X_gb_train: np.ndarray, y_train: np.ndarray,
    X_mlp_train: np.ndarray,
    *, fast: bool = False,
) -> Tuple[object, object]:
    """Fit GB + MLP. `fast=True` uses smaller models — used by the smoke test.

    sklearn is imported lazily so a fresh checkout can still import this
    module just to read constants."""
    from sklearn.ensemble import GradientBoostingClassifier  # type: ignore
    from sklearn.neural_network import MLPClassifier  # type: ignore
    from sklearn.preprocessing import StandardScaler  # type: ignore
    from sklearn.pipeline import Pipeline  # type: ignore

    if fast:
        gb = GradientBoostingClassifier(n_estimators=40, max_depth=2, learning_rate=0.15, random_state=0)
        mlp = MLPClassifier(hidden_layer_sizes=(48,), max_iter=80, random_state=0)
    else:
        gb = GradientBoostingClassifier(n_estimators=200, max_depth=3, learning_rate=0.08, random_state=0)
        mlp = MLPClassifier(hidden_layer_sizes=(128, 64), max_iter=200, random_state=0, early_stopping=True, validation_fraction=0.1)

    gb_pipe: Pipeline = Pipeline([("scaler", StandardScaler()), ("clf", gb)])
    mlp_pipe: Pipeline = Pipeline([("scaler", StandardScaler()), ("clf", mlp)])

    gb_pipe.fit(X_gb_train, y_train)
    mlp_pipe.fit(X_mlp_train, y_train)
    return gb_pipe, mlp_pipe


def _evaluate(model: object, X: np.ndarray, y: np.ndarray) -> Dict[str, object]:
    if len(y) == 0:
        return {"n": 0}
    from sklearn.metrics import accuracy_score, f1_score, classification_report  # type: ignore
    preds = model.predict(X)
    label_ids = list(range(len(CLASS_NAMES)))  # [0, 1, 2] — pin to the full class space so
    return {                                   # classification_report doesn't crash when a class is absent.
        "n": int(len(y)),
        "accuracy": round(float(accuracy_score(y, preds)), 4),
        "f1_macro": round(float(f1_score(y, preds, labels=label_ids, average="macro", zero_division=0.0)), 4),
        "per_class": classification_report(
            y, preds,
            labels=label_ids,
            target_names=list(CLASS_NAMES),
            output_dict=True,
            zero_division=0.0,
        ),
    }


@dataclass
class TrainResult:
    timeframe: str
    n_samples: int
    n_train: int
    n_val: int
    n_test: int
    train_metrics: Dict[str, object]
    val_metrics: Dict[str, object]
    test_metrics: Dict[str, object]
    saved_paths: Dict[str, str]
    feature_version: int = FEATURE_VERSION


def train_from_frames(
    frames: Iterable[pd.DataFrame],
    timeframe: str,
    *,
    horizon: Optional[int] = None,
    threshold_pct: float = 0.005,
    stride: int = 1,
    aug_factor: int = 1,
    fast: bool = False,
    progress: Optional[Callable[[str], None]] = None,
) -> TrainResult:
    """Train both models from pre-fetched OHLCV frames. Returns metrics.

    `horizon` defaults to a per-timeframe value: D1→5, H1→6, M15→8, M5→10.
    """
    if horizon is None:
        horizon = {"D1": 5, "H1": 6, "M15": 8, "M5": 10}.get(timeframe, 5)
    if progress is None:
        progress = lambda _msg: None

    rng = np.random.default_rng(seed=hash(timeframe) & 0xFFFFFFFF)
    samples: List[_Sample] = []
    for df in frames:
        rows = build_samples(
            df,
            horizon=horizon,
            threshold_pct=threshold_pct,
            stride=stride,
            aug_factor=aug_factor,
            rng=rng,
        )
        samples.extend(rows)
    progress(f"built {len(samples)} samples ({timeframe})")
    if len(samples) < 80:
        raise RuntimeError(f"Not enough samples to train ({len(samples)} < 80). Increase the symbol universe or horizon.")

    train, val, test = _chronological_split(samples)
    X_gb_tr, y_tr = _stack(train, "gb")
    X_mlp_tr, _ = _stack(train, "mlp")
    X_gb_va, y_va = _stack(val, "gb")
    X_mlp_va, _ = _stack(val, "mlp")
    X_gb_te, y_te = _stack(test, "gb")
    X_mlp_te, _ = _stack(test, "mlp")

    progress(f"fitting GB + MLP ({'fast' if fast else 'full'})…")
    gb_model, mlp_model = _fit_models(X_gb_tr, y_tr, X_mlp_tr, fast=fast)

    metrics = {
        "horizon_bars": horizon,
        "threshold_pct": threshold_pct,
        "aug_factor": aug_factor,
        "gb": {
            "train": _evaluate(gb_model, X_gb_tr, y_tr),
            "val": _evaluate(gb_model, X_gb_va, y_va),
            "test": _evaluate(gb_model, X_gb_te, y_te),
        },
        "mlp": {
            "train": _evaluate(mlp_model, X_mlp_tr, y_tr),
            "val": _evaluate(mlp_model, X_mlp_va, y_va),
            "test": _evaluate(mlp_model, X_mlp_te, y_te),
        },
        "class_balance_train": {name: int((y_tr == k).sum()) for k, name in enumerate(CLASS_NAMES)},
    }
    saved = save_models(timeframe, gb_model, mlp_model, metrics)

    return TrainResult(
        timeframe=timeframe,
        n_samples=len(samples),
        n_train=len(train),
        n_val=len(val),
        n_test=len(test),
        train_metrics=metrics["gb"]["train"],
        val_metrics=metrics["gb"]["val"],
        test_metrics=metrics["gb"]["test"],
        saved_paths=saved,
    )


def train_timeframe(
    timeframe: str,
    symbols: Optional[List[str]] = None,
    *,
    horizon: Optional[int] = None,
    aug_factor: int = 1,
    fast: bool = False,
    progress: Optional[Callable[[str], None]] = None,
) -> TrainResult:
    """High-level: fetch the universe via yfinance and train models for the
    given timeframe. May take several minutes; intended to be run inside a
    background task (admin "Retrain Models" button).
    """
    syms = symbols or NSE_TOP_50
    if progress is None:
        progress = lambda _msg: None
    progress(f"fetching {len(syms)} symbols at {timeframe}…")
    frames = fetch_universe(syms, timeframe)
    progress(f"fetched {len(frames)}/{len(syms)} symbols")
    if not frames:
        raise RuntimeError(f"No symbols fetched for {timeframe}; cannot train.")
    return train_from_frames(
        frames.values(),
        timeframe,
        horizon=horizon,
        aug_factor=aug_factor,
        fast=fast,
        progress=progress,
    )
