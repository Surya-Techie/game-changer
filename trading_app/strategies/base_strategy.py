"""
BaseStrategy — common interface for every strategy.

Contract:
    generate_signals(df) -> pd.DataFrame
        must contain columns:
            signal   ∈ {-1, 0, +1}           (entry direction)
            stop     -> float price          (initial stop)
            target   -> float price          (initial target)
            reason   -> str                  (debug tag)
        signals are ALREADY shifted by 1 bar inside generate_signals so the
        backtester can execute on next bar's open without look-ahead.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict

import numpy as np
import pandas as pd


@dataclass
class BaseStrategy(ABC):
    name: str = "BaseStrategy"
    params: Dict[str, Any] = field(default_factory=dict)
    timeframe: str = "5m"
    asset_class: str = "equity"        # equity | crypto

    def __post_init__(self):
        """
        Merge any user-supplied params dict on top of the subclass's
        defaults so callers can pass partial grids (e.g. {'rsi_period':9})
        without losing the rest of the configuration.
        """
        # The subclass's default factory has *already* produced its
        # defaults via the dataclass field; here we grab a *fresh*
        # default copy and overlay the user's overrides.
        cls = type(self)
        try:
            base_defaults = cls.__dataclass_fields__["params"].default_factory()  # type: ignore[arg-type]
        except Exception:
            base_defaults = {}
        if not isinstance(base_defaults, dict):
            base_defaults = {}
        # if user passed something, merge; else keep defaults
        merged = {**base_defaults, **(self.params or {})}
        object.__setattr__(self, "params", merged)

    # ---- public API -------------------------------------------
    def run(self, df: pd.DataFrame) -> pd.DataFrame:
        if df is None or df.empty or len(df) < 50:
            return self._empty_signals(df)
        sig = self.generate_signals(df.copy())
        sig = self._sanitize(sig, df)
        return sig

    # ---- override --------------------------------------------
    @abstractmethod
    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame: ...

    # ---- helpers ---------------------------------------------
    @staticmethod
    def _empty_signals(df: pd.DataFrame) -> pd.DataFrame:
        idx = df.index if df is not None else pd.Index([])
        return pd.DataFrame({
            "signal": pd.Series(0,   index=idx, dtype=int),
            "stop":   pd.Series(np.nan, index=idx, dtype=float),
            "target": pd.Series(np.nan, index=idx, dtype=float),
            "reason": pd.Series("",  index=idx, dtype=object),
        })

    @staticmethod
    def _sanitize(sig: pd.DataFrame, df: pd.DataFrame) -> pd.DataFrame:
        """Force schema, clip signals, prevent look-ahead by shifting 1 bar."""
        for col, default in [("signal", 0), ("stop", np.nan),
                             ("target", np.nan), ("reason", "")]:
            if col not in sig.columns:
                sig[col] = default
        sig["signal"] = sig["signal"].fillna(0).clip(-1, 1).astype(int)
        # critical: shift by 1 bar to avoid look-ahead
        sig = sig.shift(1)
        sig["signal"] = sig["signal"].fillna(0).astype(int)
        sig["reason"] = sig["reason"].fillna("").astype(str)
        return sig.reindex(df.index).fillna({"signal": 0, "reason": ""})

    # ---- generic sizing --------------------------------------
    @staticmethod
    def position_size(capital: float, entry: float, stop: float,
                      risk_pct: float = 0.01) -> int:
        """Risk-based sizing — never exceed `risk_pct` of capital."""
        if entry is None or stop is None or entry <= 0:
            return 0
        risk_per_share = abs(entry - stop)
        if risk_per_share <= 0:
            return 0
        max_risk = capital * risk_pct
        qty = int(max_risk // risk_per_share)
        return max(qty, 0)
