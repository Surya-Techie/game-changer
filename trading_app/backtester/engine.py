"""
Vectorized event-driven backtester.

Design:
  - signals are already 1-bar shifted by BaseStrategy (no look-ahead)
  - one position at a time per strategy run
  - exit on stop, target, opposite signal, or force-close time
  - slippage 0.05 % per side, commission 0.1 % per trade
  - returns trade list + equity curve + metrics
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import time
from typing import List, Optional

import numpy as np
import pandas as pd

from .. import config
from .metrics import compute_metrics


@dataclass
class Trade:
    entry_time:  pd.Timestamp
    exit_time:   pd.Timestamp
    side:        int             # +1 long, -1 short
    entry_price: float
    exit_price:  float
    stop:        float
    target:      float
    qty:         int
    pnl:         float
    pnl_pct:     float
    reason_in:   str
    reason_out:  str


class Backtester:
    def __init__(
        self,
        capital:     float = config.CAPITAL,
        slip:        float = config.SLIPPAGE_PCT,
        commission:  float = config.COMMISSION_PCT,
        risk_pct:    float = config.MAX_RISK_PER_TRADE,
        force_close: Optional[time] = config.FORCE_CLOSE,
        intraday:    bool = True,
    ):
        self.capital     = capital
        self.slip        = slip
        self.commission  = commission
        self.risk_pct    = risk_pct
        self.force_close = force_close
        self.intraday    = intraday

    # ── core loop ──────────────────────────────────────────────
    def run(self, df: pd.DataFrame, signals: pd.DataFrame) -> dict:
        trades:    List[Trade] = []
        equity:    List[float] = [self.capital]
        eq_index:  List[pd.Timestamp] = [df.index[0]]
        cur_pos: Optional[Trade] = None
        cash = self.capital

        # vectorize columns we'll touch hot in the loop
        opens  = df["open"].to_numpy()
        highs  = df["high"].to_numpy()
        lows   = df["low"].to_numpy()
        closes = df["close"].to_numpy()
        times  = df.index
        sigs   = signals["signal"].to_numpy()
        stops  = signals["stop"].to_numpy()
        tgts   = signals["target"].to_numpy()
        reasons = signals["reason"].astype(str).to_numpy()

        force_close = self.force_close

        for i in range(1, len(df)):
            t  = times[i]
            o, h, l, c = opens[i], highs[i], lows[i], closes[i]
            ts_time = t.time() if hasattr(t, "time") else None

            # ── manage open position ─────────────────────────
            if cur_pos is not None:
                exit_price = None
                reason_out = ""
                # 1) stop hit — gap-open handling: if the bar opened past the
                #    stop, fill at the open (worse). Filling at the stop level
                #    after a gap-through is the single most common source of
                #    inflated backtest profitability.
                if cur_pos.side == 1 and o <= cur_pos.stop:
                    exit_price = o
                    reason_out = "stop-gap"
                elif cur_pos.side == -1 and o >= cur_pos.stop:
                    exit_price = o
                    reason_out = "stop-gap"
                elif cur_pos.side == 1 and l <= cur_pos.stop:
                    exit_price = cur_pos.stop
                    reason_out = "stop"
                elif cur_pos.side == -1 and h >= cur_pos.stop:
                    exit_price = cur_pos.stop
                    reason_out = "stop"
                # 2) target hit
                elif cur_pos.side == 1 and h >= cur_pos.target:
                    exit_price = cur_pos.target
                    reason_out = "target"
                elif cur_pos.side == -1 and l <= cur_pos.target:
                    exit_price = cur_pos.target
                    reason_out = "target"
                # 3) opposite signal
                elif sigs[i] == -cur_pos.side:
                    exit_price = o
                    reason_out = "opposite-sig"
                # 4) time exit (intraday)
                elif (self.intraday and force_close is not None
                      and ts_time is not None and ts_time >= force_close):
                    exit_price = c
                    reason_out = "time-exit"

                if exit_price is not None:
                    # apply slip + commission both ways
                    fill_exit = exit_price * (1 - self.slip * cur_pos.side)
                    gross     = (fill_exit - cur_pos.entry_price) * cur_pos.side * cur_pos.qty
                    cost      = (cur_pos.entry_price + fill_exit) * cur_pos.qty * self.commission
                    pnl       = gross - cost
                    cur_pos.exit_time  = t
                    cur_pos.exit_price = fill_exit
                    cur_pos.pnl        = pnl
                    cur_pos.pnl_pct    = pnl / self.capital
                    cur_pos.reason_out = reason_out
                    trades.append(cur_pos)
                    cash += pnl
                    cur_pos = None

            # ── open new position ─────────────────────────────
            if (cur_pos is None
                and sigs[i] != 0
                and not np.isnan(stops[i])
                and not np.isnan(tgts[i])):
                # block new entries after force-close window
                if (self.intraday and force_close is not None
                    and ts_time is not None and ts_time >= time(14, 30)):
                    pass
                else:
                    side  = int(sigs[i])
                    entry = o * (1 + self.slip * side)
                    stop  = float(stops[i])
                    tgt   = float(tgts[i])
                    risk_per_share = abs(entry - stop)
                    if risk_per_share > 0:
                        max_risk = cash * self.risk_pct
                        qty = int(max_risk // risk_per_share)
                        if qty > 0:
                            cur_pos = Trade(
                                entry_time  = t,
                                exit_time   = t,
                                side        = side,
                                entry_price = entry,
                                exit_price  = np.nan,
                                stop        = stop,
                                target      = tgt,
                                qty         = qty,
                                pnl         = 0.0,
                                pnl_pct     = 0.0,
                                reason_in   = str(reasons[i]),
                                reason_out  = "",
                            )

            # ── mark to market equity ────────────────────────
            mtm = 0.0
            if cur_pos is not None:
                mtm = (c - cur_pos.entry_price) * cur_pos.side * cur_pos.qty
            equity.append(cash + mtm)
            eq_index.append(t)

        # close any remaining position at last bar
        if cur_pos is not None:
            exit_price = closes[-1] * (1 - self.slip * cur_pos.side)
            gross      = (exit_price - cur_pos.entry_price) * cur_pos.side * cur_pos.qty
            cost       = (cur_pos.entry_price + exit_price) * cur_pos.qty * self.commission
            pnl        = gross - cost
            cur_pos.exit_time  = times[-1]
            cur_pos.exit_price = exit_price
            cur_pos.pnl        = pnl
            cur_pos.pnl_pct    = pnl / self.capital
            cur_pos.reason_out = "eod"
            trades.append(cur_pos)
            cash += pnl

        equity_curve = pd.Series(equity, index=pd.DatetimeIndex(eq_index))
        trades_df    = pd.DataFrame([asdict(t) for t in trades])
        metrics      = compute_metrics(equity_curve, trades_df, self.capital)

        return {
            "trades":    trades_df,
            "equity":    equity_curve,
            "metrics":   metrics,
            "final_eq":  cash,
        }
