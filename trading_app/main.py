"""
Full-portfolio backtest report.

Usage:
    python -m trading_app.main
    python -m trading_app.main --days 30
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

from trading_app import config
from trading_app.data.fetcher import fetch, to_ist
from trading_app.strategies import ALL_STRATEGIES
from trading_app.backtester.engine import Backtester
from trading_app.backtester.metrics import monte_carlo


def _row(name, strat, sym, m, n_trades) -> dict:
    return {
        "Strategy":      name,
        "Symbol":        sym,
        "Trades":        m["total_trades"],
        "WinRate%":      round(m["win_rate"] * 100, 1),
        "Return%":       round(m["total_return"] * 100, 2),
        "Sharpe":        round(m["sharpe"], 2),
        "ProfitFactor":  round(m["profit_factor"], 2),
        "MaxDD%":        round(m["max_drawdown"] * 100, 2),
        "AvgDailyRet%":  round(m["avg_daily_return"] * 100, 3),
        "5%-Days":       m["days_5pct"],
        "Expectancy":    round(m["expectancy"], 1),
    }


def run_full_backtest(days_equity: int = 30, days_crypto: int = 60) -> dict:
    print("=" * 80)
    print(f"PPS Trading App — Full Backtest Report")
    print(f"  Capital      : ₹{config.CAPITAL:,}")
    print(f"  Target/day   : +{config.DAILY_PROFIT_TARGET*100:.0f}%")
    print(f"  Max loss/day : -{config.MAX_DAILY_LOSS*100:.0f}%")
    print(f"  Risk/trade   : {config.MAX_RISK_PER_TRADE*100:.1f}%")
    print(f"  Slippage     : {config.SLIPPAGE_PCT*100:.2f}% per side")
    print(f"  Commission   : {config.COMMISSION_PCT*100:.2f}% per trade")
    print("=" * 80)

    all_rows = []
    daily_summary = defaultdict(list)
    best_combos = []

    # ── NSE equity (5m bars) ──
    print("\n▶ NSE EQUITIES (5-min bars, last", days_equity, "days)")
    print("-" * 80)
    for sym in config.NSE_STOCKS:
        print(f"\n  {sym}")
        df = fetch(sym, interval=config.DEFAULT_INTERVAL_EQUITY, days=days_equity)
        if df.empty or len(df) < 100:
            print(f"    skipped (only {len(df)} bars)")
            continue
        df = to_ist(df)
        for cls in ALL_STRATEGIES:
            try:
                s   = cls()
                sig = s.run(df)
                res = Backtester(intraday=True).run(df, sig)
                m   = res["metrics"]
                row = _row(cls.__name__, s, sym, m, m["total_trades"])
                all_rows.append(row)
                if m["total_trades"] > 0:
                    print(f"    {cls.__name__:<24}"
                          f" n={m['total_trades']:>3}"
                          f"  WR={m['win_rate']*100:5.1f}%"
                          f"  ret={m['total_return']*100:6.2f}%"
                          f"  Sharpe={m['sharpe']:5.2f}"
                          f"  5%-days={m['days_5pct']}")
                    best_combos.append((row["Return%"], sym, cls.__name__))
                # collect daily returns for "how many 5% days"
                if len(res["equity"]) > 5:
                    eq = res["equity"]
                    daily = eq.resample("1D").last().pct_change().dropna()
                    for d, r in daily.items():
                        daily_summary[(sym, cls.__name__)].append(float(r))
            except Exception as e:
                print(f"    {cls.__name__:<24} ERROR: {e}")

    # ── crypto (1h bars) ──
    print("\n▶ CRYPTO (1-hour bars, last", days_crypto, "days)")
    print("-" * 80)
    for sym in config.CRYPTO:
        print(f"\n  {sym}")
        df = fetch(sym, interval=config.DEFAULT_INTERVAL_CRYPTO, days=days_crypto)
        if df.empty or len(df) < 100:
            print(f"    skipped ({len(df)} bars)")
            continue
        # crypto: no IST timezone shift, no intraday force-close
        for cls in ALL_STRATEGIES:
            try:
                s   = cls()
                sig = s.run(df)
                res = Backtester(intraday=False).run(df, sig)
                m   = res["metrics"]
                row = _row(cls.__name__, s, sym, m, m["total_trades"])
                all_rows.append(row)
                if m["total_trades"] > 0:
                    print(f"    {cls.__name__:<24}"
                          f" n={m['total_trades']:>3}"
                          f"  WR={m['win_rate']*100:5.1f}%"
                          f"  ret={m['total_return']*100:6.2f}%"
                          f"  Sharpe={m['sharpe']:5.2f}")
                    best_combos.append((row["Return%"], sym, cls.__name__))
            except Exception as e:
                print(f"    {cls.__name__:<24} ERROR: {e}")

    # ── consolidated report ──
    df_all = pd.DataFrame(all_rows)
    if df_all.empty:
        print("\n⚠ no results produced.")
        return {"rows": []}

    print("\n" + "=" * 80)
    print("📊 FINAL REPORT")
    print("=" * 80)

    # avg per-strategy
    by_strat = df_all.groupby("Strategy").agg(
        Trades=("Trades", "sum"),
        AvgWinRate=("WinRate%", "mean"),
        AvgReturn=("Return%", "mean"),
        TotalReturn=("Return%", "sum"),
        AvgSharpe=("Sharpe", "mean"),
        AvgDailyRet=("AvgDailyRet%", "mean"),
        Days5pct=("5%-Days", "sum"),
    ).round(2).sort_values("AvgReturn", ascending=False)
    print("\nPer-Strategy Aggregate (across all symbols):")
    print(by_strat.to_string())

    # top symbol-strategy combos
    print("\nTop 10 Symbol+Strategy combinations by return:")
    best_combos.sort(reverse=True)
    for ret, sym, strat in best_combos[:10]:
        print(f"  {ret:>+7.2f}%   {sym:<18}  {strat}")

    # 5%-day analysis
    total_days  = sum(len(v) for v in daily_summary.values())
    days_5_plus = sum(1 for ret in
                      [r for v in daily_summary.values() for r in v]
                      if ret >= 0.05)
    print(f"\n5%-Day Analysis (per-strategy-per-day buckets):")
    print(f"  Total strategy-days observed: {total_days}")
    print(f"  Days hitting ≥ +5% return   : {days_5_plus}")
    if total_days > 0:
        print(f"  Frequency                   : {days_5_plus/total_days*100:.2f} %")

    # capital allocation recommendation
    print("\nRecommended Capital Allocation (proportional to positive Sharpe):")
    positive = by_strat[by_strat["AvgSharpe"] > 0]
    if not positive.empty:
        weights = positive["AvgSharpe"] / positive["AvgSharpe"].sum()
        for name, w in weights.items():
            print(f"  {name:<28}  {w*100:5.1f}%   (~₹{config.CAPITAL*w:,.0f})")
    else:
        print("  No strategy with positive Sharpe — DO NOT TRADE LIVE.")

    # realistic daily return
    avg_daily = df_all["AvgDailyRet%"].mean()
    print(f"\nRealistic daily-return estimate (avg across runs): {avg_daily:+.3f} %")
    print(f"5% goal feasibility:",
          "achievable" if avg_daily > 1 else "ambitious — needs filter tightening")

    # save report
    out = config.RESULTS / "backtest_report.csv"
    df_all.to_csv(out, index=False)
    print(f"\nFull per-strategy-per-symbol table saved → {out}")

    return {"rows": all_rows, "by_strategy": by_strat.to_dict()}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=30, help="lookback days (equity)")
    p.add_argument("--crypto-days", type=int, default=60)
    a = p.parse_args()
    run_full_backtest(days_equity=a.days, days_crypto=a.crypto_days)
