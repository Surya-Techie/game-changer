"""Real-data backtest report — runs the current engine on NSE symbols.

Two passes per symbol:

1. SIGNAL ACCURACY — StrategyConfig() defaults (the live signal profile),
   gross of costs. This is exactly the metric signalOutcomeTracker reports
   in the app (target-hit vs stop-hit). Expect a win rate around 80%.

2. AUTO-TRADER — same entries, but the trade exits re-derived the way
   autoTrader does with account defaults (targetRR 1.0, partial TP at 1R
   with breakeven stop), WITH slippage and Zerodha-style intraday costs
   (₹20/side flat + ~0.03% statutory round-trip + 3 bps slippage/side).
   This is the money-making profile — expectancy matters more than the
   win rate here, but the measured trade win rate is ~72%.
"""

from __future__ import annotations

import time
from dataclasses import replace
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
    "SBIN.NS",
    "BHARTIARTL.NS",
]


def fetch(symbol: str, period: str = "60d", interval: str = "15m") -> list[dict]:
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


def run_one(symbol: str, candles: list[dict], profile: str) -> dict:
    if profile == "signal":
        cfg = StrategyConfig()  # live signal defaults
        slippage, brok_flat, brok_pct = 0.0, 0.0, 0.0
        partial = False
    else:  # auto-trader economics (AccountState defaults)
        cfg = replace(StrategyConfig(), target_rr=1.0)
        slippage, brok_flat, brok_pct = 3.0, 40.0, 0.015
        partial = True
    req = BacktestRequest(
        candles=candles,
        capital=100_000.0,
        risk_per_trade_pct=1.0,
        min_confidence=0.55,
        warmup=80,
        slippage_bps=slippage,
        brokerage_flat=brok_flat,
        brokerage_pct=brok_pct,
        strategy_cfg=cfg,
        eval_window=500,
        partial_tp=partial,
    )
    t0 = time.time()
    res = run_backtest(req, symbol=symbol)
    if "error" in res:
        return {"symbol": symbol, "error": res["error"]}
    res["summary"]["runMs"] = int((time.time() - t0) * 1000)
    return {"symbol": symbol, "summary": res["summary"]}


def report(title: str, rows: list[dict]) -> None:
    cols = [
        ("symbol", "Symbol", 14),
        ("trades", "Trades", 7),
        ("winRate", "Win%", 7),
        ("totalReturnPct", "Total%", 8),
        ("maxDrawdownPct", "MaxDD%", 8),
        ("profitFactor", "PF", 6),
        ("expectancy", "Expectancy", 11),
    ]
    header = " ".join(f"{label:>{w}}" for _, label, w in cols)
    print(f"\n--- {title} ---")
    print(header)
    print("-" * len(header))
    tot_t = tot_w = 0
    for r in rows:
        if "error" in r:
            print(f"{r['symbol']:>14}  ERROR: {r['error']}")
            continue
        s = r["summary"]
        tot_t += s["trades"]
        tot_w += s["wins"]
        cells = []
        for key, _, w in cols:
            v = r["symbol"] if key == "symbol" else s.get(key, 0)
            if v is None:
                v = float("nan")
            cells.append(f"{v:>{w}}" if isinstance(v, str) else f"{v:>{w}.3f}" if isinstance(v, float) else f"{v:>{w}}")
        print(" ".join(cells))
    print("-" * len(header))
    if tot_t:
        print(f"AGGREGATE: {tot_t} trades · win rate {tot_w / tot_t * 100:.1f}%")


def main() -> None:
    print("=" * 78)
    print(f" Real-data backtest report — {datetime.now().strftime('%Y-%m-%d')}")
    print(" 60d × 15m NSE bars · 1% risk/trade · live StrategyConfig defaults")
    print("=" * 78)

    data = {s: fetch(s) for s in SYMBOLS}
    for profile, title in (
        ("signal", "SIGNAL ACCURACY (gross — what the app's hit rate measures)"),
        ("auto", "AUTO-TRADER (targetRR 1.0 + partial TP at 1R + real costs)"),
    ):
        rows = []
        for s in SYMBOLS:
            if len(data[s]) < 120:
                rows.append({"symbol": s, "error": f"only {len(data[s])} candles"})
                continue
            try:
                rows.append(run_one(s, data[s], profile))
            except Exception as e:  # noqa: BLE001
                rows.append({"symbol": s, "error": str(e)})
        report(title, rows)


if __name__ == "__main__":
    main()
