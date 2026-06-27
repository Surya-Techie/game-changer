"""
Strategy 3 — Gap & Go.
Gap up 3-15 % at open with 3x volume; wait for green first 5-min candle; enter on break of its high.
HIGH CONVICTION (book reinforces: ascending triangle in uptrend after gap).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import time
from typing import Any, Dict

import numpy as np
import pandas as pd

from .base_strategy import BaseStrategy
from ..indicators.custom_indicators import relative_volume, atr


@dataclass
class GapAndGo(BaseStrategy):
    name: str = "GapAndGo"
    params: Dict[str, Any] = field(default_factory=lambda: {
        "min_gap_pct":        0.03,
        "max_gap_pct":        0.15,
        "volume_surge_ratio": 3.0,
        "target_multiplier":  1.5,
    })

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        if not isinstance(df.index, pd.DatetimeIndex) or df.index.tz is None:
            return self._empty_signals(df)

        p  = self.params
        out = self._empty_signals(df)

        # find prev-day close & today's open per day
        df_d = df.copy()
        df_d["date"] = df_d.index.date

        # previous-day's last close (group by date)
        last_close_by_day = df_d.groupby("date")["close"].last()
        prev_close = last_close_by_day.shift(1)

        # today's first candle (09:15-09:20) per day
        first_bar  = df_d.between_time(time(9, 15), time(9, 20), inclusive="left")
        first_open = first_bar.groupby(first_bar.index.date)["open"].first()
        first_high = first_bar.groupby(first_bar.index.date)["high"].first()
        first_low  = first_bar.groupby(first_bar.index.date)["low"].first()
        first_close= first_bar.groupby(first_bar.index.date)["close"].first()
        first_vol  = first_bar.groupby(first_bar.index.date)["volume"].first()
        avg_vol    = df_d["volume"].rolling(20 * 75, min_periods=20).mean()  # ≈ 20 sessions

        gap_pct = (first_open - prev_close) / prev_close
        gap_ok  = (gap_pct >= p["min_gap_pct"]) & (gap_pct <= p["max_gap_pct"])
        green   = first_close > first_open
        # volume surge: first candle volume vs typical first-candle volume
        first_vol_ma = first_vol.rolling(20, min_periods=5).mean()
        vol_ok       = first_vol > first_vol_ma * p["volume_surge_ratio"]

        valid_days = gap_ok & green & vol_ok
        valid_days = valid_days.fillna(False)

        # broadcast first_high / first_low onto bar index
        date_arr   = df_d.index.date
        f_high_map = first_high.to_dict()
        f_low_map  = first_low.to_dict()
        gap_map    = gap_pct.to_dict()
        valid_map  = valid_days.to_dict()

        f_high_arr = np.array([f_high_map.get(d, np.nan) for d in date_arr])
        f_low_arr  = np.array([f_low_map.get(d,  np.nan) for d in date_arr])
        gap_arr    = np.array([gap_map.get(d,    np.nan) for d in date_arr])
        ok_arr     = np.array([valid_map.get(d,  False)  for d in date_arr])

        # entry: after 9:20, on first bar that breaks first_high
        from datetime import time as _t
        after_first = pd.Series(df.index.time, index=df.index).apply(lambda t: t >= _t(9, 20))
        already_triggered = pd.Series(False, index=df.index)
        for d in pd.Series(date_arr).unique():
            day_mask = pd.Series(date_arr == d, index=df.index)
            cond = day_mask & after_first & (df["high"] > f_high_arr) & pd.Series(ok_arr, index=df.index)
            first_idx = cond[cond].head(1).index
            if len(first_idx) > 0:
                already_triggered.loc[first_idx[0]] = True

        out.loc[already_triggered, "signal"] = 1
        for idx in already_triggered[already_triggered].index:
            i = df.index.get_loc(idx)
            entry  = float(df["close"].iloc[i])
            stop   = float(f_low_arr[i])
            target = entry + p["target_multiplier"] * (entry - stop) * 2  # 2× gap-sized move
            out.at[idx, "stop"]   = stop
            out.at[idx, "target"] = target
            out.at[idx, "reason"] = f"GapGo {gap_arr[i]*100:.1f}%"
        return out
