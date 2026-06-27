"""Gainz Alpha composite ensemble.

Fuses the trained Brandt pattern model with three optional auxiliary
ML models (RSI/MACD, sentiment+volume, momentum/price-action) into a
single 0..100 alpha score and a discrete BUY/SELL/STRONG_* signal.

Design choices:

* The auxiliary models are **optional**. If any of their .pkl files is
  missing at construction time we redistribute their weight onto the
  remaining live models so the engine still produces a meaningful score
  from Brandt alone. This is the current real-world state — the user
  has the Brandt model now and will add the others later.

* The Brandt rule-based scorer runs as a *hard gate*: if it returns
  ``reject=True`` the engine short-circuits with ``NO_TRADE``, no
  matter what the auxiliary models say.

* A confidence multiplier is applied after the weighted sum. The
  highest-confidence Brandt setup (horizontal pattern + RR ≥ 3 +
  weekly aligned) gets a 1.5× boost; diagonal patterns get a 0.85×
  haircut, per Brandt's reliability hierarchy.
"""

from __future__ import annotations

import os
from typing import Dict, Optional

import joblib
import numpy as np

from .brandt_features import BRANDT_ML_FEATURES
from .brandt_scorer import compute_brandt_score


class GainzAlphaEngine:

    BASE_WEIGHTS = {
        "brandt_pattern":          0.35,
        "model_1_rsi_macd":        0.25,
        "model_2_sentiment_volume": 0.25,
        "model_3_momentum":        0.15,
    }

    SIGNAL_THRESHOLDS = [
        ("STRONG_BUY",  75),
        ("BUY",         60),
        ("NEUTRAL",     45),
        ("SELL",        30),
        ("STRONG_SELL", 15),
    ]

    def __init__(self, model_paths: Dict[str, str]):
        self.models: Dict[str, object] = {}
        for key in ("brandt", "model_1", "model_2", "model_3"):
            path = model_paths.get(key)
            if path and os.path.exists(path):
                try:
                    self.models[key] = joblib.load(path)
                except Exception as e:
                    print(f"[GainzAlpha] failed to load {key}: {e}")
                    self.models[key] = None
            else:
                self.models[key] = None

        # Brandt is mandatory.
        if self.models.get("brandt") is None:
            raise FileNotFoundError(
                f"Brandt model not found at {model_paths.get('brandt')!r}. "
                f"Train it with brandt_model_trainer.py first."
            )

        self.weights = self._renormalize_weights()

    def _renormalize_weights(self) -> Dict[str, float]:
        live = {
            "brandt_pattern":          True,
            "model_1_rsi_macd":        self.models.get("model_1") is not None,
            "model_2_sentiment_volume": self.models.get("model_2") is not None,
            "model_3_momentum":        self.models.get("model_3") is not None,
        }
        total = sum(self.BASE_WEIGHTS[k] for k, v in live.items() if v)
        return {k: (self.BASE_WEIGHTS[k] / total if v else 0.0) for k, v in live.items()}

    # ─────────────────────────────────────────────────────────────────

    def compute_alpha_score(
        self,
        brandt_features: Dict[str, float],
        indicator_features: Optional[Dict[str, Dict[str, float]]] = None,
        capital: Optional[float] = None,
    ) -> Dict:
        """Return composite alpha score + BUY/SELL signal + risk block.

        ``indicator_features`` is an optional dict shaped::

            {
                "model_1_features": {...},
                "model_2_features": {...},
                "model_3_features": {...},
            }

        Missing keys are tolerated — the corresponding model is treated
        as unavailable for this request.
        """
        indicator_features = indicator_features or {}

        # 1. Brandt hard filters.
        brandt_rule_result = compute_brandt_score(brandt_features)
        if brandt_rule_result.get("reject"):
            return {
                "alpha_score": 0.0,
                "signal": "NO_TRADE",
                "reject_reasons": brandt_rule_result["reasons"],
                "component_scores": {},
                "constraint_multiplier": 0.0,
                "brandt_bonuses": [],
                "stop_loss_pct": None,
                "target_pct": None,
                "reward_risk": brandt_features.get("reward_risk_ratio"),
            }

        # 2. Brandt ML probability.
        brandt_vec = np.array([[brandt_features[k] for k in BRANDT_ML_FEATURES]], dtype=float)
        try:
            brandt_prob = float(self.models["brandt"].predict_proba(brandt_vec)[0][1])
        except Exception as e:
            brandt_prob = 0.5
            print(f"[GainzAlpha] brandt predict failed: {e}")
        brandt_ml = brandt_prob * 100

        # 3. Auxiliary models (graceful when missing).
        m1 = self._predict_aux("model_1", indicator_features.get("model_1_features"))
        m2 = self._predict_aux("model_2", indicator_features.get("model_2_features"))
        m3 = self._predict_aux("model_3", indicator_features.get("model_3_features"))

        # 4. Weighted sum.
        weighted = (
            self.weights["brandt_pattern"]          * brandt_ml +
            self.weights["model_1_rsi_macd"]        * (m1 if m1 is not None else 0) +
            self.weights["model_2_sentiment_volume"] * (m2 if m2 is not None else 0) +
            self.weights["model_3_momentum"]        * (m3 if m3 is not None else 0)
        )

        # 5. Brandt confidence multiplier.
        multiplier = 1.0
        if (brandt_features.get("pattern_boundary_type") == 0 and
                brandt_features.get("reward_risk_ratio", 0) >= 3.0 and
                brandt_features.get("weekly_chart_alignment", 0) == 1):
            multiplier = 1.5
        elif brandt_features.get("pattern_boundary_type") == 1:
            multiplier = 0.85

        alpha = float(min(100.0, weighted * multiplier))

        # 6. Map score → discrete signal. Use breakout direction for
        # BUY-vs-SELL polarity (Brandt: every trade has a known side).
        direction = brandt_features.get("breakout_direction", 0)
        signal = self._score_to_signal(alpha, direction)

        # 7. Risk block.
        stop_pct = brandt_features.get("last_day_rule_stop_pct")
        target_pct = brandt_features.get("measured_move_target_pct")
        position_block = self._position_block(stop_pct, capital)

        return {
            "alpha_score": round(alpha, 2),
            "signal": signal,
            "component_scores": {
                "brandt_pattern":          round(brandt_ml, 2),
                "model_1_rsi_macd":        round(m1, 2) if m1 is not None else None,
                "model_2_sentiment_volume": round(m2, 2) if m2 is not None else None,
                "model_3_momentum":        round(m3, 2) if m3 is not None else None,
            },
            "weights": {k: round(v, 3) for k, v in self.weights.items()},
            "constraint_multiplier": multiplier,
            "brandt_rule_score": brandt_rule_result["brandt_score"],
            "brandt_bonuses": brandt_rule_result["reasons"],
            "stop_loss_pct": stop_pct,
            "target_pct": target_pct,
            "reward_risk": brandt_features.get("reward_risk_ratio"),
            "position_sizing": position_block,
        }

    # ─────────────────────────────────────────────────────────────────

    def _predict_aux(self, key: str, features: Optional[Dict[str, float]]) -> Optional[float]:
        model = self.models.get(key)
        if model is None or features is None:
            return None
        try:
            vec = np.array([list(features.values())], dtype=float)
            prob = float(model.predict_proba(vec)[0][1])
            return prob * 100
        except Exception as e:
            print(f"[GainzAlpha] {key} predict failed: {e}")
            return None

    def _score_to_signal(self, score: float, direction: float) -> str:
        # Map magnitude → tier, then assign BUY/SELL polarity from
        # the pattern direction. Score < 15 collapses to NEUTRAL since
        # neither side has conviction.
        if score < 15:
            return "NEUTRAL"
        if direction > 0:
            for name, thresh in self.SIGNAL_THRESHOLDS:
                if score >= thresh and "SELL" not in name:
                    return name
            return "NEUTRAL"
        if direction < 0:
            if score >= 75: return "STRONG_SELL"
            if score >= 60: return "SELL"
            return "NEUTRAL"
        return "NEUTRAL"

    def _position_block(self, stop_pct: Optional[float], capital: Optional[float]) -> Dict:
        if not stop_pct or stop_pct <= 0:
            return {"note": "stop_pct unavailable"}
        if capital and capital > 0:
            risk_capital = capital * 0.01  # 1% rule
            max_position = risk_capital / (stop_pct / 100.0)
            return {
                "capital_inr": capital,
                "max_risk_inr": round(risk_capital, 2),
                "max_position_inr": round(max_position, 2),
                "stop_pct": stop_pct,
                "rule": "Brandt 1% risk cap",
                "note": f"Risk max 1% of ₹{capital:,.0f} / {stop_pct:.2f}% stop = max ₹{max_position:,.0f} per trade",
            }
        return {
            "stop_pct": stop_pct,
            "rule": "Brandt 1% risk cap",
            "note": f"Risk max 1% of capital / {stop_pct:.2f}% stop",
        }
