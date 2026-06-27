"""Phase 7 smoke test for the pattern backtester.

Runs `run_pattern_backtest` on synthetic OHLCV with a deliberately trendy
shape so at least one extended pattern (Western/institutional) is likely
to fire. Verifies:

  1. result has the documented top-level keys
  2. equity_curve is non-empty and matches the bar count we expect
  3. by_pattern rollup is consistent (sum of wins/losses/breakevens/expired
     equals trades; pnl_total matches pnl sum)
  4. final_equity == capital + sum(trade pnls) (within float tolerance)

Also exercises the /patterns/names endpoint helper.

Run with:
    cd ai-service && python patterns/_phase7_smoke_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))


def synthetic(n: int, seed: int) -> pd.DataFrame:
    """A mix of uptrend, range, downtrend, range — gives multiple chances for
    western patterns (flags, channels) and institutional setups to fire."""
    rng = np.random.default_rng(seed=seed)
    seg = n // 4
    parts = [
        100 + np.cumsum(rng.normal(loc=0.45, scale=0.9, size=seg)),
        # range
        np.zeros(seg),  # filled in below
        # decline
        np.zeros(seg),
        np.zeros(n - 3 * seg),
    ]
    last_up = parts[0][-1]
    parts[1] = last_up + rng.normal(loc=0.0, scale=0.4, size=seg).cumsum() * 0.2
    last_range = parts[1][-1]
    parts[2] = last_range + np.cumsum(rng.normal(loc=-0.45, scale=0.9, size=seg))
    last_down = parts[2][-1]
    parts[3] = last_down + rng.normal(loc=0.05, scale=0.5, size=n - 3 * seg).cumsum() * 0.3
    close = np.concatenate(parts)
    open_ = np.concatenate([[close[0]], close[:-1]])
    high = np.maximum(open_, close) + rng.uniform(0.2, 1.5, size=n)
    low = np.minimum(open_, close) - rng.uniform(0.2, 1.5, size=n)
    vol = rng.integers(100_000, 1_000_000, size=n).astype(float)
    t = (np.arange(n, dtype="int64")) * 24 * 60 * 60 * 1000  # 1 day bars
    t += 1_700_000_000_000  # arbitrary start
    return pd.DataFrame({
        "time": t, "open": open_, "high": high, "low": low, "close": close, "volume": vol,
    })


def main() -> int:
    from patterns._helpers import ensure_df
    from pattern_backtest import (
        PatternBacktestRequest,
        list_all_pattern_names,
        run_pattern_backtest,
    )

    n = 400
    df = ensure_df(synthetic(n, seed=2026))
    req = PatternBacktestRequest(
        symbol="SYNTH",
        capital=100_000.0,
        risk_per_trade_pct=1.0,
        min_confidence=30,    # permissive so synthetic data yields trades
        warmup=80,
        max_hold_bars=20,
        timeframe="D1",
        periods_per_year=252,
        slippage_bps=2.0,
        brokerage_pct=0.0,
    )
    res = run_pattern_backtest(df, req)
    if "error" in res:
        print("FAIL: backtester returned error:", res["error"])
        return 1

    required_keys = {
        "symbol", "timeframe", "config",
        "total_trades", "wins", "losses", "win_rate",
        "profit_factor", "total_return_pct", "max_drawdown",
        "sharpe", "avg_rr_achieved", "final_equity",
        "by_pattern", "equity_curve", "trade_log",
    }
    missing = required_keys - set(res.keys())
    if missing:
        print(f"FAIL: missing keys: {sorted(missing)}")
        return 1

    n_curve = len(res["equity_curve"])
    n_expected = n - req.warmup
    if n_curve != n_expected:
        print(f"FAIL: equity_curve length {n_curve} != expected {n_expected}")
        return 1

    # Per-pattern rollups: components sum to trades, pnl_total matches.
    pnl_sum = 0.0
    for name, rollup in res["by_pattern"].items():
        sum_components = rollup["wins"] + rollup["losses"] + rollup["breakevens"] + rollup["expired"]
        if sum_components != rollup["trades"]:
            print(f"FAIL: by_pattern {name} components {sum_components} != trades {rollup['trades']}")
            return 1
        pnl_sum += rollup["pnl_total"]

    # Trade log totals reconcile with final equity.
    log_pnl = sum(t["pnl"] for t in res["trade_log"])
    capital = req.capital
    diff = abs((capital + log_pnl) - res["final_equity"])
    if diff > 1.0:  # ₹1 tolerance for rounding
        print(f"FAIL: final_equity {res['final_equity']} != capital+pnl {capital + log_pnl}, diff={diff:.2f}")
        return 1
    if abs(log_pnl - pnl_sum) > 1.0:
        print(f"FAIL: trade_log pnl {log_pnl:.2f} != by_pattern pnl_total {pnl_sum:.2f}")
        return 1

    # Pattern name registry should be non-empty.
    names = list_all_pattern_names()
    if len(names) < 50:
        print(f"FAIL: pattern names list too short ({len(names)})")
        return 1

    print(f"PASS — pattern backtest reconciles. "
          f"Trades: {res['total_trades']} (W {res['wins']} / L {res['losses']}), "
          f"Win rate {res['win_rate'] * 100:.1f}%, "
          f"Return {res['total_return_pct']:.2f}%, "
          f"Sharpe {res['sharpe']:.2f}, "
          f"MaxDD {res['max_drawdown']:.2f}%, "
          f"Equity curve {n_curve} points, "
          f"Pattern names registered: {len(names)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
