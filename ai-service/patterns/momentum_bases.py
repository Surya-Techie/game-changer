"""O'Neil / Minervini momentum base detectors.

STUB. Each function returns None safely so the master engine and
/api/patterns/scan-all can call them without errors. Full implementation
per the Phase-2 spec is a follow-up.

Functions:
  detect_power_earnings_gap(df, earnings_dates=[])
  detect_high_tight_flag(df)
  detect_flat_base(df)
  detect_three_weeks_tight(df_weekly)
  detect_scallop(df)
"""

from __future__ import annotations

from typing import Optional

import pandas as pd


def detect_power_earnings_gap(df: pd.DataFrame, earnings_dates=None) -> Optional[dict]:
    return None


def detect_high_tight_flag(df: pd.DataFrame) -> Optional[dict]:
    return None


def detect_flat_base(df: pd.DataFrame) -> Optional[dict]:
    return None


def detect_three_weeks_tight(df_weekly: pd.DataFrame) -> Optional[dict]:
    return None


def detect_scallop(df: pd.DataFrame) -> Optional[dict]:
    return None
