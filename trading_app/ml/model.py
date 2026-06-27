"""
PPS ML model — sklearn GradientBoosting classifier with feature scaling.

Public API:
    PPSModel              — wrapper class around a fitted sklearn pipeline
    PPSModel.train(X, y)  — fit on the labeled dataset
    PPSModel.predict(X)   — returns predicted class (-1, 0, +1)
    PPSModel.predict_proba(X) -> DataFrame with columns ['sell','hold','buy']
    PPSModel.save(path)   — joblib pickle
    PPSModel.load(path)   — class method, returns a PPSModel
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import (
    GradientBoostingClassifier, RandomForestClassifier, VotingClassifier,
)
sklearn.set_config(enable_metadata_routing=True)
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.utils.class_weight import compute_class_weight

from .features import FEATURE_COLS


MODEL_VERSION = "pps-ml-v2-ensemble"


@dataclass
class PPSModel:
    pipeline: Pipeline
    classes_: np.ndarray
    feature_cols: list
    metrics: dict
    version: str = MODEL_VERSION

    # ── training ───────────────────────────────────────────────
    @classmethod
    def train(cls, X: pd.DataFrame, y: pd.Series,
              random_state: int = 42) -> "PPSModel":
        # align
        idx = X.index.intersection(y.index)
        X = X.loc[idx, FEATURE_COLS].copy()
        y = y.loc[idx].astype(int).copy()

        # sample weights — handle class imbalance manually because
        # GradientBoostingClassifier doesn't accept `class_weight`
        classes = np.unique(y)
        w = compute_class_weight("balanced", classes=classes, y=y)
        weight_map = dict(zip(classes, w))
        sample_w = y.map(weight_map).astype(float).values

        # Single high-capacity boosted model.
        # Reason: VotingClassifier soft-averaging compresses probabilities
        # (no class ever reaches >0.85), so the high-confidence subset
        # disappears. A single deep GBM keeps probabilities spread.
        gb = GradientBoostingClassifier(
            n_estimators       = 600,
            learning_rate      = 0.04,
            max_depth          = 5,
            subsample          = 0.85,
            min_samples_leaf   = 20,
            random_state       = random_state,
        )
        # Wrap with a Random Forest blender via stacking-like calibration:
        # we stack a small RF on top to refine boundaries.
        rf = RandomForestClassifier(
            n_estimators       = 400,
            max_depth          = 14,
            min_samples_leaf   = 10,
            n_jobs             = -1,
            class_weight       = "balanced",
            random_state       = random_state,
        )
        # Soft-vote but heavily weighted toward GB so probability sharpness
        # is preserved while RF adds a small smoothing effect.
        ens = VotingClassifier(
            estimators=[("gb", gb), ("rf", rf)],
            voting="soft", weights=[3.0, 1.0], n_jobs=-1,
        )
        pipe = Pipeline([
            ("scaler", StandardScaler()),
            ("clf", ens),
        ])
        # Note: VotingClassifier in sklearn 1.8 doesn't easily pass sample_weight
        # to a single sub-estimator via metadata routing. We rely instead on
        # RF's class_weight='balanced' and the labeler's natural rebalancing.
        pipe.fit(X, y)

        # quick in-sample sanity score (NOT for production validation)
        in_sample_acc = float((pipe.predict(X) == y).mean())
        return cls(
            pipeline     = pipe,
            classes_     = pipe.classes_,
            feature_cols = FEATURE_COLS,
            metrics      = {
                "in_sample_accuracy": round(in_sample_acc, 4),
                "n_train":            int(len(X)),
                "class_weights":      {int(k): round(float(v), 3)
                                       for k, v in weight_map.items()},
            },
        )

    # ── inference ──────────────────────────────────────────────
    def predict(self, X: pd.DataFrame) -> pd.Series:
        X = X[self.feature_cols]
        return pd.Series(self.pipeline.predict(X).astype(int), index=X.index)

    def predict_proba(self, X: pd.DataFrame) -> pd.DataFrame:
        X = X[self.feature_cols]
        proba = self.pipeline.predict_proba(X)
        cols  = [{-1: "sell", 0: "hold", 1: "buy"}[c] for c in self.pipeline.classes_]
        return pd.DataFrame(proba, index=X.index, columns=cols)

    # ── persistence ────────────────────────────────────────────
    def save(self, path: Path | str) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump({
            "pipeline":     self.pipeline,
            "classes_":     self.classes_,
            "feature_cols": self.feature_cols,
            "metrics":      self.metrics,
            "version":      self.version,
        }, path)

    @classmethod
    def load(cls, path: Path | str) -> Optional["PPSModel"]:
        path = Path(path)
        if not path.exists():
            return None
        d = joblib.load(path)
        return cls(
            pipeline     = d["pipeline"],
            classes_     = d["classes_"],
            feature_cols = d["feature_cols"],
            metrics      = d.get("metrics", {}),
            version      = d.get("version", MODEL_VERSION),
        )
