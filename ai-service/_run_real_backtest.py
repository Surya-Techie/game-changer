"""Real-data backtest report — runs the fixed engine on NSE symbols.

Sanity-check that the bug fixes (gap-open fills, no same-bar look-ahead,
daily-Sharpe) produce honest, realistic numbers compared to the prior
inflated metrics.
"""

from __future__ import annotations

import json
import time
from datetime import datetime

import yfinance as yf

from backtest import BacktestRequest, run_backtest
from strategy import StrategyConfig


SYMBOLS = [
    "RELIANCE.NS",
    "TCS.NS",
    "HDFCBANK.NS",
    "INFY.NS",
    "ICICIBANK.NS",
    "ITC.NS",
]


def fetch(symbol: str, period: str = "2y", interval: str = "1d") -> list[dict]:
    df = yf.Ticker(symbol).history(period=period, interval=interval)
    if df.empty:
        return []
    candles = []
    for ts, row in df.iterrows():
        candles.append({
            "t": int(ts.timestamp() * 1000),
            "o": float(row["Open"]),
            "h": float(row["High"]),
            "l": float(row["Low"]),
            "c": float(row["Close"]),
            "v": float(row.get("Volume", 0) or 0),
        })
    return candles


def run_one(symbol: str) -> dict:
    candles = fetch(symbol)
    if len(candles) < 100:
        return {"symbol": symbol, "error": f"only {len(candles)} candles"}
    cfg = StrategyConfig(
        regime_filter=True,
        regime_min_adx=20.0,
        stop_mode="ATR",
        atr_stop_mult=1.5,
        target_rr=2.0,
        quality_gate=True,
        min_quality=0.55,
    )
    req = BacktestRequest(
        candles=candles,
        capital=100_000.0,
        risk_per_trade_pct=1.0,
        min_confidence=0.55,
        warmup=80,
        slippage_bps=5.0,            # 5 bps slippage per side (realistic for NSE)
        brokerage_flat=40.0,         # ₹20 entry + ₹20 exit = ₹40 round-trip
        brokerage_pct=0.03,          # 0.03% per side ≈ Zerodha-equivalent
        strategy_cfg=cfg,
    )
    t0 = time.time()
    res = run_backtest(req, symbol=symbol)
    res["summary"]["barsInput"] = len(candles)
    res["summary"]["runMs"] = int((time.time() - t0) * 1000)
    return {"symbol": symbol, "summary": res["summary"]}


def main() -> None:
    print("=" * 78)
    print(f" Real-data backtest report — {datetime.now().strftime('%Y-%m-%d')}")
    print(" 2 years daily NSE bars · 1% risk/trade · ATR 1.5x stop · 2:1 R:R")
    print(" 5 bps slippage · Zerodha-style ₹40 flat + 0.03% brokerage")
    print("=" * 78)

    rows = []
    for s in SYMBOLS:
        try:
            r = run_one(s)
            rows.append(r)
        except Exception as e:
            rows.append({"symbol": s, "error": str(e)})

    cols = [
        ("symbol", "Symbol", 14),
        ("trades", "Trades", 7),
        ("winRate", "Win%", 7),
        ("totalReturnPct", "Total%", 8),
        ("maxDrawdownPct", "MaxDD%", 8),
        ("sharpe", "Sharpe", 8),
        ("profitFactor", "PF", 6),
        ("avgWin", "AvgWin", 9),
        ("avgLoss", "AvgLoss", 9),
        ("expectancy", "Expectancy", 11),
    ]
    header = " ".join(f"{label:>{w}}" for _, label, w in cols)
    print(header)
    print("-" * len(header))
    agg_pos = 0
    agg_total = 0
    for r in rows:
        if "error" in r:
            print(f"{r['symbol']:>14}  ERROR: {r['error']}")
            continue
        s = r["summary"]
        agg_total += 1
        if (s.get("totalReturnPct") or 0) > 0:
            agg_pos += 1
        cells = []
        for key, _, w in cols:
            if key == "symbol":
                v = r["symbol"]
            else:
                v = s.get(key, 0)
                if v is None:
                    v = "—"
            cells.append(f"{v:>{w}}" if isinstance(v, str) else f"{v:>{w}.3f}" if isinstance(v, float) else f"{v:>{w}}")
        print(" ".join(cells))

    print("-" * len(header))
    print(f"\n{agg_pos}/{agg_total} symbols profitable in this 2-year window.")
    print(json.dumps([r for r in rows if "summary" in r], indent=2, default=str)[:0])  # silence


if __name__ == "__main__":
    main()
