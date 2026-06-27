"""ML pattern classifier — sklearn ensemble.

Per the project decision, the spec's TF CNN + LSTM are replaced by two
sklearn models:

  • Model A — GradientBoostingClassifier on a flat 20-bar feature vector
              (plays the CNN role: pattern-recognition on a fixed window).
  • Model B — MLPClassifier on a 50-bar normalised feature sequence
              (plays the LSTM role: temporal context).

The reasoning is documented in the project memory: TensorFlow has no
official Python 3.14 wheels yet, and sklearn is already a dependency.

Both models output 3-class probabilities — `bullish_move`, `bearish_move`,
`no_move` — over a forward window. The Confidence Engine consumes the
ensemble probability of the *agreeing* class for the rule-engine pattern
direction.

Lazy-loading: if no trained model file is on disk, `predict_proba()`
returns `{source: "rule_only", ...}` with neutral 1/3 probabilities so
upstream consumers degrade gracefully to pure rule-based scoring.

Persistence: `ai-service/models/{gb_patterns,mlp_patterns}_{tf}.joblib`
+ a sidecar JSON with the feature ordering and OOS metrics. Models are
keyed by timeframe (e.g. `D1`, `H1`, `M15`, `M5`) because the optimal
volatility / persistence patterns differ across horizons.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

import numpy as np
import pandas as pd

from ._helpers import (
    adx,
    atr,
    ema,
    ensure_df,
    is_bull,
    candle_range,
    upper_shadow,
    lower_shadow,
    volume_ratio,
    _val,
)


CLASS_NAMES = ("no_move", "bullish_move", "bearish_move")
ClassName = Literal["no_move", "bullish_move", "bearish_move"]


# ─── Model directory (overridable via env) ─────────────────────────────────

MODELS_DIR = Path(os.environ.get("PATTERN_MODELS_DIR", str(Path(__file__).resolve().parent.parent / "models")))


def models_dir() -> Path:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    return MODELS_DIR


# ─── Feature extraction ────────────────────────────────────────────────────

GB_WINDOW = 20
MLP_WINDOW = 50

# Static ordering — both training and inference must reference the same list
# in the same order. Adding a feature here is a model-incompatible change;
# bump the FEATURE_VERSION below and retrain.
FEATURE_VERSION = 1

GB_FEATURE_NAMES = [
    # Returns over multiple horizons
    "r1", "r3", "r5", "r10", "r20",
    # Volatility / stats
    "ret_std_20", "ret_skew_20",
    # Momentum
    "rsi14", "adx14",
    # Trend ratios
    "ema9_over_21", "ema21_over_50", "close_over_ema50",
    # ATR
    "atr_pct",
    # Volume
    "vol_ratio_20",
    # Range position
    "close_in_20_range",
    # Recent 5-bar shape features: body/range, upper/range, lower/range, is_bull
    "body_pct_t0", "upper_pct_t0", "lower_pct_t0", "isbull_t0",
    "body_pct_t1", "upper_pct_t1", "lower_pct_t1", "isbull_t1",
    "body_pct_t2", "upper_pct_t2", "lower_pct_t2", "isbull_t2",
    "body_pct_t3", "upper_pct_t3", "lower_pct_t3", "isbull_t3",
    "body_pct_t4", "upper_pct_t4", "lower_pct_t4", "isbull_t4",
]


def _safe_ratio(a: float, b: float) -> float:
    if abs(b) < 1e-9:
        return 0.0
    return float(a / b)


def _per_bar_shape(row) -> Tuple[float, float, float, float]:
    rng = candle_range(row)
    if rng <= 0:
        return 0.0, 0.0, 0.0, 0.0
    body_pct = float(abs(_val(row, "close") - _val(row, "open"))) / rng
    upper_pct = float(upper_shadow(row)) / rng
    lower_pct = float(lower_shadow(row)) / rng
    isbull = 1.0 if is_bull(row) else 0.0
    return body_pct, upper_pct, lower_pct, isbull


def extract_gb_features(df: pd.DataFrame) -> Optional[np.ndarray]:
    """Vector of length len(GB_FEATURE_NAMES) over the most recent GB_WINDOW
    bars. Returns None if there isn't enough history to compute it."""
    df = ensure_df(df)
    n = len(df)
    if n < GB_WINDOW + 5:
        return None
    closes = df["close"].astype(float)
    last = float(closes.iloc[-1])
    if last <= 0:
        return None
    # Returns
    def _ret(k: int) -> float:
        if n < k + 1:
            return 0.0
        prev = float(closes.iloc[-1 - k])
        return _safe_ratio(last - prev, prev)
    r1, r3, r5, r10, r20 = _ret(1), _ret(3), _ret(5), _ret(10), _ret(20)
    rets20 = closes.pct_change().dropna().tail(20)
    ret_std = float(rets20.std()) if len(rets20) > 1 else 0.0
    ret_skew = float(rets20.skew()) if len(rets20) > 2 else 0.0

    # Momentum & trend
    rsi_series = _rsi(closes, 14)
    rsi_now = float(rsi_series.iloc[-1])
    adx_now = float(adx(df, 14).iloc[-1])
    ema9 = float(ema(closes, 9).iloc[-1])
    ema21 = float(ema(closes, 21).iloc[-1])
    ema50 = float(ema(closes, 50).iloc[-1])

    atr14 = float(atr(df, 14).iloc[-1])
    atr_pct = _safe_ratio(atr14, last)
    vol_r = volume_ratio(df, window=20, idx=n - 1)

    win = df.iloc[-GB_WINDOW:]
    win_hi = float(win["high"].max())
    win_lo = float(win["low"].min())
    range_pos = _safe_ratio(last - win_lo, max(win_hi - win_lo, 1e-9))

    out: List[float] = [
        r1, r3, r5, r10, r20,
        ret_std, ret_skew,
        rsi_now / 100.0, adx_now / 100.0,
        _safe_ratio(ema9, ema21), _safe_ratio(ema21, ema50), _safe_ratio(last, ema50),
        atr_pct,
        vol_r,
        range_pos,
    ]
    for k in range(5):
        body, up, lo, isb = _per_bar_shape(df.iloc[-1 - k])
        out.extend([body, up, lo, isb])
    arr = np.asarray(out, dtype="float32")
    # Sanity: NaN/Inf would crash sklearn. Replace with 0.
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    if arr.shape[0] != len(GB_FEATURE_NAMES):
        raise RuntimeError(
            f"GB feature vector length mismatch: produced {arr.shape[0]} but expected {len(GB_FEATURE_NAMES)}. "
            "Did you edit GB_FEATURE_NAMES without bumping FEATURE_VERSION?"
        )
    return arr


def extract_mlp_features(df: pd.DataFrame) -> Optional[np.ndarray]:
    """Flatten a normalised 50-bar feature matrix into a 1D vector. Per bar:
    [open_z, high_z, low_z, close_z, vol_z, body_pct] where *_z is the value
    divided by the close of the first bar in the window (so the network sees
    relative changes, not absolute prices). 6 × 50 = 300 features."""
    df = ensure_df(df)
    n = len(df)
    if n < MLP_WINDOW:
        return None
    win = df.iloc[-MLP_WINDOW:].reset_index(drop=True)
    base = float(win["close"].iloc[0])
    if base <= 0:
        return None
    vbase = float(win["volume"].mean()) or 1.0
    rows: List[float] = []
    for _, row in win.iterrows():
        body_pct = float(abs(row["close"] - row["open"])) / max(float(row["high"] - row["low"]), 1e-9)
        rows.extend([
            float(row["open"]) / base,
            float(row["high"]) / base,
            float(row["low"]) / base,
            float(row["close"]) / base,
            float(row["volume"]) / vbase,
            body_pct,
        ])
    arr = np.asarray(rows, dtype="float32")
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    return arr


def _rsi(closes: pd.Series, period: int = 14) -> pd.Series:
    delta = closes.diff()
    gain = delta.clip(lower=0).ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50.0)


# ─── Labeling (forward-return classification) ─────────────────────────────

def forward_return_label(df: pd.DataFrame, anchor_idx: int, horizon: int, threshold_pct: float = 0.005) -> Optional[int]:
    """Classify what happened in the `horizon` bars *after* `anchor_idx`:

      0 = no_move      ( |max_excursion| ≤ threshold_pct )
      1 = bullish_move ( max_up > threshold_pct AND max_up > |max_down| )
      2 = bearish_move ( max_down > threshold_pct AND max_down > max_up )

    Returns None if the window runs past the end of the DataFrame.
    """
    if anchor_idx + horizon >= len(df):
        return None
    base = float(df["close"].iloc[anchor_idx])
    if base <= 0:
        return None
    forward = df.iloc[anchor_idx + 1 : anchor_idx + 1 + horizon]
    max_up = float(forward["high"].max() - base) / base
    max_down = float(base - forward["low"].min()) / base
    if max_up < threshold_pct and max_down < threshold_pct:
        return 0
    if max_up > max_down:
        return 1
    return 2


# ─── Model registry ────────────────────────────────────────────────────────

@dataclass
class TimeframeModel:
    timeframe: str
    gb_model: Any = None  # sklearn estimator or None
    mlp_model: Any = None
    feature_version: int = FEATURE_VERSION
    trained_at: Optional[str] = None
    metrics: Dict[str, Any] = field(default_factory=dict)

    def ready(self) -> bool:
        return self.gb_model is not None and self.mlp_model is not None


_REGISTRY: Dict[str, TimeframeModel] = {}
_REGISTRY_LOCK = threading.Lock()


def _gb_path(tf: str) -> Path:
    return models_dir() / f"gb_patterns_{tf}.joblib"


def _mlp_path(tf: str) -> Path:
    return models_dir() / f"mlp_patterns_{tf}.joblib"


def _meta_path(tf: str) -> Path:
    return models_dir() / f"patterns_{tf}.meta.json"


def _load_into_registry(timeframe: str) -> TimeframeModel:
    """Read model files from disk (if present) and cache the loaded estimators
    in the in-process registry. Cheap to call repeatedly."""
    with _REGISTRY_LOCK:
        existing = _REGISTRY.get(timeframe)
        if existing is not None:
            return existing

        tm = TimeframeModel(timeframe=timeframe)
        try:
            import joblib  # type: ignore
            if _gb_path(timeframe).exists():
                tm.gb_model = joblib.load(_gb_path(timeframe))
            if _mlp_path(timeframe).exists():
                tm.mlp_model = joblib.load(_mlp_path(timeframe))
            if _meta_path(timeframe).exists():
                meta = json.loads(_meta_path(timeframe).read_text())
                tm.trained_at = meta.get("trained_at")
                tm.feature_version = int(meta.get("feature_version", FEATURE_VERSION))
                tm.metrics = meta.get("metrics", {})
        except Exception:  # noqa: BLE001 — model files may be corrupt; treat as not-loaded
            tm = TimeframeModel(timeframe=timeframe)
        _REGISTRY[timeframe] = tm
        return tm


def save_models(timeframe: str, gb_model: Any, mlp_model: Any, metrics: Dict[str, Any]) -> dict:
    """Persist trained models + sidecar metadata. Returns the path summary."""
    import joblib  # type: ignore
    from datetime import datetime, timezone

    gp = _gb_path(timeframe)
    mp = _mlp_path(timeframe)
    metp = _meta_path(timeframe)
    joblib.dump(gb_model, gp)
    joblib.dump(mlp_model, mp)
    meta = {
        "timeframe": timeframe,
        "feature_version": FEATURE_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "gb_features": GB_FEATURE_NAMES,
        "mlp_window": MLP_WINDOW,
        "metrics": metrics,
    }
    metp.write_text(json.dumps(meta, indent=2))
    # Bust the registry cache so the next predict_proba reloads from disk.
    with _REGISTRY_LOCK:
        _REGISTRY.pop(timeframe, None)
    return {"gb": str(gp), "mlp": str(mp), "meta": str(metp), "trained_at": meta["trained_at"]}


def registry_status() -> dict:
    """Inspectable summary of what's currently loaded — used by the admin
    panel + the /patterns/accuracy endpoint."""
    info: Dict[str, Any] = {}
    for tf in ("M5", "M15", "H1", "D1"):
        # Force a registry load (no-op if already loaded).
        _load_into_registry(tf)
        tm = _REGISTRY.get(tf) or TimeframeModel(timeframe=tf)
        info[tf] = {
            "ready": tm.ready(),
            "trained_at": tm.trained_at,
            "feature_version": tm.feature_version,
            "metrics": tm.metrics,
        }
    info["model_dir"] = str(models_dir())
    info["feature_version"] = FEATURE_VERSION
    return info


# ─── Inference ─────────────────────────────────────────────────────────────

@dataclass
class EnsembleProbabilities:
    no_move: float
    bullish_move: float
    bearish_move: float
    source: str  # "ensemble" | "rule_only"
    gb_probs: Optional[Dict[str, float]] = None
    mlp_probs: Optional[Dict[str, float]] = None

    def for_direction(self, direction: str) -> float:
        """Return the ensemble probability of the class matching `direction`
        (the rule-engine's pattern direction)."""
        if direction == "bullish":
            return self.bullish_move
        if direction == "bearish":
            return self.bearish_move
        return self.no_move

    def to_dict(self) -> dict:
        return {
            "no_move": round(self.no_move, 4),
            "bullish_move": round(self.bullish_move, 4),
            "bearish_move": round(self.bearish_move, 4),
            "source": self.source,
            "gb_probs": self.gb_probs,
            "mlp_probs": self.mlp_probs,
        }


def _proba_to_dict(model: Any, x: np.ndarray) -> Dict[str, float]:
    """Map sklearn .predict_proba output to the 3-class name dict.

    sklearn keeps each model's `classes_` attribute, so we look up the column
    index for each class name to be robust to class-ordering differences.
    """
    if not hasattr(model, "predict_proba") or not hasattr(model, "classes_"):
        return {name: 1.0 / len(CLASS_NAMES) for name in CLASS_NAMES}
    probs = model.predict_proba(x.reshape(1, -1))[0]
    classes = list(getattr(model, "classes_"))
    out: Dict[str, float] = {}
    for k, name in enumerate(CLASS_NAMES):
        if k in classes:
            j = classes.index(k)
            out[name] = float(probs[j])
        else:
            out[name] = 0.0
    s = sum(out.values()) or 1.0
    return {k: v / s for k, v in out.items()}


def predict_proba(df: pd.DataFrame, timeframe: str = "D1") -> EnsembleProbabilities:
    """Run the ensemble (if models are loaded). Falls back to neutral
    1/3-1/3-1/3 with source='rule_only' otherwise."""
    tm = _load_into_registry(timeframe)
    if not tm.ready():
        return EnsembleProbabilities(
            no_move=1.0 / 3, bullish_move=1.0 / 3, bearish_move=1.0 / 3, source="rule_only",
        )

    gb_feat = extract_gb_features(df)
    mlp_feat = extract_mlp_features(df)
    if gb_feat is None or mlp_feat is None:
        return EnsembleProbabilities(
            no_move=1.0 / 3, bullish_move=1.0 / 3, bearish_move=1.0 / 3, source="rule_only",
        )

    gb_dict = _proba_to_dict(tm.gb_model, gb_feat)
    mlp_dict = _proba_to_dict(tm.mlp_model, mlp_feat)

    # Equal-weight ensemble (we'd tune these post-hoc with validation perf).
    blended = {k: 0.5 * gb_dict[k] + 0.5 * mlp_dict[k] for k in CLASS_NAMES}
    total = sum(blended.values()) or 1.0
    blended = {k: v / total for k, v in blended.items()}

    return EnsembleProbabilities(
        no_move=blended["no_move"],
        bullish_move=blended["bullish_move"],
        bearish_move=blended["bearish_move"],
        source="ensemble",
        gb_probs={k: round(v, 4) for k, v in gb_dict.items()},
        mlp_probs={k: round(v, 4) for k, v in mlp_dict.items()},
    )
