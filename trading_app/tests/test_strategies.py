"""
pytest -v
"""
from __future__ import annotations

from datetime import time

import numpy as np
import pandas as pd
import pytest

from trading_app import config
from trading_app.strategies import ALL_STRATEGIES
from trading_app.backtester.engine import Backtester
from trading_app.backtester.metrics import compute_metrics, monte_carlo
from trading_app.risk.risk_manager import IntradayRiskManager


# ── synthetic intraday data (deterministic) ────────────────────
@pytest.fixture(scope="module")
def synthetic_df():
    """Two trading sessions of 5-min bars (IST) with realistic OHLCV."""
    rng = np.random.default_rng(42)
    rows = []
    base = 100.0
    for day_offset in range(5):
        date = pd.Timestamp("2025-01-13", tz="Asia/Kolkata") + pd.Timedelta(days=day_offset)
        t = date.replace(hour=9, minute=15)
        for _ in range(75):                       # 9:15 → 15:30 ≈ 75 × 5-min
            move    = rng.normal(0, 0.4)
            o = base
            c = max(0.1, base + move)
            h = max(o, c) + abs(rng.normal(0, 0.2))
            l = min(o, c) - abs(rng.normal(0, 0.2))
            v = int(rng.integers(50_000, 500_000))
            rows.append((t, o, h, l, c, v))
            base = c
            t = t + pd.Timedelta(minutes=5)
    df = pd.DataFrame(rows, columns=["datetime","open","high","low","close","volume"])
    df = df.set_index("datetime")
    return df


# ── 1. signal validity ─────────────────────────────────────────
@pytest.mark.parametrize("cls", ALL_STRATEGIES,
                         ids=[c.__name__ for c in ALL_STRATEGIES])
def test_signal_generation(cls, synthetic_df):
    s   = cls()
    sig = s.run(synthetic_df)
    assert set(["signal", "stop", "target", "reason"]).issubset(sig.columns)
    assert sig["signal"].dropna().isin([-1, 0, 1]).all(), \
        f"{cls.__name__} produced out-of-range signals"
    assert len(sig) == len(synthetic_df)


# ── 2. no look-ahead ───────────────────────────────────────────
@pytest.mark.parametrize("cls", ALL_STRATEGIES,
                         ids=[c.__name__ for c in ALL_STRATEGIES])
def test_no_lookahead_bias(cls, synthetic_df):
    s          = cls()
    full_sig   = s.run(synthetic_df)
    # truncate, re-run, signals up to the cut must be IDENTICAL
    cut        = len(synthetic_df) - 5
    partial    = synthetic_df.iloc[:cut]
    part_sig   = s.run(partial)
    common     = full_sig.iloc[:cut]
    assert (common["signal"].values == part_sig["signal"].values).all(), \
        f"{cls.__name__} signals change when future bars are revealed"


# ── 3. position sizing under 2% risk ───────────────────────────
def test_position_sizing():
    rm = IntradayRiskManager(capital=100_000)
    qty = rm.size_position(entry=100, stop=99)
    max_loss = qty * 1.0                       # ₹1 risk/share
    assert max_loss <= 100_000 * 0.01, "size exceeds 1% risk"

    # 2% safety cap (config.MAX_RISK_PER_TRADE is 0.01)
    qty2 = rm.size_position(entry=200, stop=190)
    risk = qty2 * 10
    assert risk <= 100_000 * 0.02


# ── 4. stop loss always present on signal bars ─────────────────
@pytest.mark.parametrize("cls", ALL_STRATEGIES,
                         ids=[c.__name__ for c in ALL_STRATEGIES])
def test_stop_loss_valid(cls, synthetic_df):
    s   = cls()
    sig = s.run(synthetic_df)
    active = sig[sig["signal"] != 0]
    if active.empty:
        pytest.skip(f"{cls.__name__} produced no signals on synthetic data")
    assert active["stop"].notna().all(),  f"{cls.__name__} has NaN stop"
    assert active["target"].notna().all(), f"{cls.__name__} has NaN target"
    # stop on the correct side
    for _, row in active.iterrows():
        if row["signal"] == 1:
            assert row["stop"] < row["target"], f"{cls.__name__} long stop ≥ target"
        else:
            assert row["stop"] > row["target"], f"{cls.__name__} short stop ≤ target"


# ── 5. backtester runs end-to-end ──────────────────────────────
@pytest.mark.parametrize("cls", ALL_STRATEGIES,
                         ids=[c.__name__ for c in ALL_STRATEGIES])
def test_backtest_runs(cls, synthetic_df):
    s   = cls()
    sig = s.run(synthetic_df)
    res = Backtester().run(synthetic_df, sig)
    assert "equity" in res and "trades" in res and "metrics" in res
    assert len(res["equity"]) == len(synthetic_df)
    assert isinstance(res["metrics"], dict)


# ── 6. all metrics are numeric ─────────────────────────────────
def test_metrics_valid(synthetic_df):
    from trading_app.strategies import OpeningRangeBreakout
    s   = OpeningRangeBreakout()
    sig = s.run(synthetic_df)
    res = Backtester().run(synthetic_df, sig)
    m   = res["metrics"]
    keys = ["total_return","cagr","sharpe","sortino","max_drawdown",
            "win_rate","profit_factor","expectancy","calmar",
            "avg_win","avg_loss","total_trades","days_5pct"]
    for k in keys:
        assert k in m, f"missing metric {k}"
        assert isinstance(m[k], (int, float)), f"{k} not numeric"
        assert np.isfinite(m[k]), f"{k} not finite ({m[k]})"


# ── 7. monte carlo returns sensible quantiles ─────────────────
def test_monte_carlo():
    trades = pd.DataFrame({
        "pnl": [100, -50, 200, -75, 50, -25, 300],
    })
    mc = monte_carlo(trades, runs=200, capital=10_000)
    assert mc["p5_final"] <= mc["median_final"] <= mc["p95_final"]
    assert mc["runs"] == 200


# ── 8. risk manager kill-switches ─────────────────────────────
def test_risk_kill_switches():
    from datetime import datetime
    rm = IntradayRiskManager(capital=100_000)
    rm.reset_day()

    # +5% halts
    rm.on_close(5_500)
    ok, _ = rm.permit_new_entry(datetime(2025,1,1,11,0))
    assert not ok and rm.halted

    # -2% halts
    rm.reset_day()
    rm.on_close(-2_500)
    ok, _ = rm.permit_new_entry(datetime(2025,1,1,11,0))
    assert not ok and rm.halted

    # 3 consecutive losses halts
    rm.reset_day()
    for _ in range(3):
        rm.on_close(-100)
    ok, _ = rm.permit_new_entry(datetime(2025,1,1,11,0))
    assert not ok and rm.halted

    # max open trades
    rm.reset_day()
    rm.on_open(); rm.on_open()
    ok, msg = rm.permit_new_entry(datetime(2025,1,1,11,0))
    assert not ok and "max open" in msg


# ── 8b. hardened risk controls (weekly halt, per-symbol cap, cooldown, scaled sizing) ─
def test_weekly_drawdown_halt():
    from datetime import datetime
    rm = IntradayRiskManager(capital=100_000, max_weekly_loss=0.03,
                              cooldown_hours=0.0)  # disable cooldown for this test
    rm.reset_day()
    # -3.5% on Monday → trip the weekly halt next time permit is asked.
    rm.on_close(-3_500, timestamp=datetime(2025, 6, 2, 11, 0))  # 2025-W23 Monday
    # Daily kill switch must have fired (-3500 ≤ -2000). Reset day to clear
    # halted+daily_pnl so we can probe the weekly gate cleanly.
    rm.reset_day()
    # Re-record the weekly loss after reset_day (we cleared daily_pnl but
    # weekly_pnl is preserved by design — that's exactly what the gate guards).
    ok, msg = rm.permit_new_entry(datetime(2025, 6, 3, 10, 0))  # Tuesday same week
    assert not ok and "weekly" in msg.lower()
    # Next ISO week → not halted (weekly bucket is per-ISO-week).
    rm.reset_day()
    ok, _ = rm.permit_new_entry(datetime(2025, 6, 9, 11, 0))    # 2025-W24 Monday
    assert ok


def test_per_symbol_cap():
    from datetime import datetime
    rm = IntradayRiskManager(capital=100_000, max_open_trades=4, max_per_symbol=1)
    rm.reset_day()
    rm.on_open(symbol="RELIANCE")
    ok, msg = rm.permit_new_entry(datetime(2025, 1, 1, 11, 0), symbol="RELIANCE")
    assert not ok and "RELIANCE" in msg
    # Different symbol → permitted.
    ok, _ = rm.permit_new_entry(datetime(2025, 1, 1, 11, 0), symbol="INFY")
    assert ok


def test_post_kill_cooldown():
    from datetime import datetime
    rm = IntradayRiskManager(capital=100_000, max_daily_loss=0.02, cooldown_hours=16)
    rm.reset_day()
    # Trigger the -2% kill switch at 11:00.
    rm.on_close(-2_500, timestamp=datetime(2025, 1, 1, 11, 0))
    ok, _ = rm.permit_new_entry(datetime(2025, 1, 1, 11, 0))
    assert not ok and rm.halted
    # Clear ONLY the halted flag (NOT reset_day) — production semantic
    # for the cooldown is: "even if you manually un-halt, you cannot
    # re-enter within the cooldown window." reset_day is a session-edge
    # event that clears kill_at by design.
    rm.halted = False
    rm.halted_reason = ""
    ok, msg = rm.permit_new_entry(datetime(2025, 1, 1, 21, 0))
    assert not ok and "cooldown" in msg.lower()
    # 24h after the kill — cooldown gate is naturally cleared inside
    # permit_new_entry. We zero daily_pnl too because that's a separate
    # halt mechanism; we're testing the cooldown gate in isolation here.
    rm.halted = False
    rm.halted_reason = ""
    rm.daily_pnl = 0.0
    ok, _ = rm.permit_new_entry(datetime(2025, 1, 2, 11, 0))
    assert ok
    assert rm.kill_at is None  # cooldown gate cleared its own marker


def test_confidence_scaled_sizing():
    rm = IntradayRiskManager(capital=100_000, max_risk_per_trade=0.01,
                              high_conviction_floor=0.65)
    # High-conviction trade gets the full 1% (= ₹1000) budget.
    qty_hi = rm.size_position_scaled(entry=100.0, stop=95.0, confidence=0.80)
    # Low-conviction same setup gets HALF the budget.
    qty_lo = rm.size_position_scaled(entry=100.0, stop=95.0, confidence=0.55)
    assert qty_hi > qty_lo > 0
    # The ratio should be ~2:1 (rounding floor allowed).
    assert qty_hi // qty_lo in (2, 3)


# ── 9. time-of-day rules ──────────────────────────────────────
def test_time_of_day():
    from datetime import datetime
    rm = IntradayRiskManager(capital=100_000)
    rm.reset_day()
    assert not rm.permit_new_entry(datetime(2025,1,1, 9, 5))[0]   # before open
    assert not rm.permit_new_entry(datetime(2025,1,1, 9,17))[0]   # first 5 min
    assert     rm.permit_new_entry(datetime(2025,1,1, 9,17), is_gap_go=True)[0]
    assert     rm.permit_new_entry(datetime(2025,1,1,11, 0))[0]   # normal
    assert not rm.permit_new_entry(datetime(2025,1,1,14,45))[0]   # too late
