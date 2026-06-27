"""Measure the high-conviction composer's REAL hit rate.

Walks each bar from index 80 → end, runs the composer using ONLY bars
[0, i] (so the composer sees the same history a live trader would), then
for every BUY/SELL it emits, walks forward bar-by-bar to see whether the
target or the stop hit first. Conservative tie-break: if both are inside
the same bar, count as a LOSS (we can't tell ordering inside a bar).
"""

from __future__ import annotations

import sys
import time
from typing import List, Tuple

import yfinance as yf

from high_conviction import compose_high_conviction


SYMBOLS = [
    "RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS",
    "ICICIBANK.NS", "ITC.NS", "SBIN.NS", "LT.NS",
]


def fetch(symbol: str, period: str = "2y") -> list[dict]:
    df = yf.Ticker(symbol).history(period=period, interval="1d")
    if df.empty:
        return []
    out = []
    for ts, r in df.iterrows():
        out.append({
            "t": int(ts.timestamp() * 1000),
            "o": float(r["Open"]), "h": float(r["High"]),
            "l": float(r["Low"]), "c": float(r["Close"]),
            "v": float(r.get("Volume", 0) or 0),
        })
    return out


def resolve(signal: dict, candles: list[dict], start_idx: int,
            horizon: int | None = None) -> Tuple[str, float]:
    """Returns (outcome, pct_return). Outcome ∈ {win, loss, time}.

    `horizon` defaults to the composer's max_hold_bars (15). After that
    many bars, any open position closes at the bar's close — time-out
    bars are now classified as WIN or LOSS based on the closed-out PnL,
    NOT as a separate ambiguous bucket. This matches what a live trader
    actually does (exit at market when the timer fires).

    Conservative tie-break: if a single bar's high/low straddles both
    target and stop, count as LOSS (assume the stop hits first).
    """
    direction = signal["signal"]
    entry = signal["entry_price"]
    stop = signal["stop_loss"]
    target = signal["target_price"]
    is_buy = direction == "BUY"
    if horizon is None:
        horizon = int(signal.get("max_hold_bars", 15))
    end_idx = min(start_idx + horizon + 1, len(candles))
    for j in range(start_idx + 1, end_idx):
        c = candles[j]
        if is_buy:
            hit_stop = c["l"] <= stop
            hit_tgt = c["h"] >= target
        else:
            hit_stop = c["h"] >= stop
            hit_tgt = c["l"] <= target
        if hit_stop and hit_tgt:
            return "loss", (stop - entry) / entry * (1 if is_buy else -1)
        if hit_stop:
            return "loss", (stop - entry) / entry * (1 if is_buy else -1)
        if hit_tgt:
            return "win", (target - entry) / entry * (1 if is_buy else -1)
    # Time exit: close at last bar's close. Bucket as WIN or LOSS by sign.
    last_c = candles[end_idx - 1]["c"]
    pct = (last_c - entry) / entry * (1 if is_buy else -1)
    return ("win" if pct > 0 else "loss"), pct


def measure_symbol(symbol: str) -> dict:
    candles = fetch(symbol)
    if len(candles) < 100:
        return {"symbol": symbol, "error": f"only {len(candles)} candles"}

    signals_emitted = []
    # Disable universe filter for measurement — we want to see the composer's
    # decision on EVERY symbol, not just the universe.
    for i in range(80, len(candles) - 20):  # leave 20 bars for the time-exit horizon
        sub = candles[: i + 1]
        res = compose_high_conviction(
            sub, symbol=symbol.replace(".NS", ""), use_ml=False,
            tradeable_universe=set(),  # disable universe gate for measurement
        )
        if res["signal"] in ("BUY", "SELL"):
            signals_emitted.append((i, res))

    if not signals_emitted:
        return {"symbol": symbol, "n_signals": 0, "note": "composer emitted no actionable signals"}

    # De-duplicate: composer often re-fires the same setup for 2-5 bars
    # as the pattern stays active. Only count the first signal of each
    # "streak" (≥ 5-bar gap between groups).
    deduped = []
    last_idx = -100
    for idx, r in signals_emitted:
        if idx - last_idx >= 5:
            deduped.append((idx, r))
            last_idx = idx

    wins = losses = 0
    pnl_pcts: list[float] = []
    for idx, r in deduped:
        outcome, ret = resolve(r, candles, idx)
        pnl_pcts.append(ret * 100)
        if outcome == "win":
            wins += 1
        else:
            losses += 1

    total = wins + losses
    win_rate = (wins / total * 100) if total else 0.0
    avg_ret = sum(pnl_pcts) / len(pnl_pcts) if pnl_pcts else 0.0
    avg_win = (sum(p for p in pnl_pcts if p > 0) / wins) if wins else 0.0
    avg_loss = (sum(p for p in pnl_pcts if p <= 0) / losses) if losses else 0.0
    return {
        "symbol": symbol,
        "candles": len(candles),
        "raw_signals": len(signals_emitted),
        "deduped_signals": len(deduped),
        "wins": wins,
        "losses": losses,
        "win_rate_pct": round(win_rate, 1),
        "avg_win_pct": round(avg_win, 2),
        "avg_loss_pct": round(avg_loss, 2),
        "avg_pct_per_trade": round(avg_ret, 3),
        "total_pct_if_all_taken": round(sum(pnl_pcts), 2),
    }


def main() -> None:
    print("=" * 90)
    print(" High-conviction composer — REAL win-rate measurement")
    print(" 2y daily NSE bars, no look-ahead, conservative tie-break (ambiguous bar = LOSS)")
    print("=" * 90)
    rows = []
    for sym in SYMBOLS:
        t0 = time.time()
        r = measure_symbol(sym)
        elapsed = time.time() - t0
        r["sec"] = round(elapsed, 1)
        rows.append(r)
        if "error" in r:
            print(f"{sym:<14} ERR {r['error']}")
            continue
        if r.get("n_signals") == 0 or r.get("deduped_signals", 0) == 0:
            print(f"{sym:<14} no signals")
            continue
        print(f"{sym:<14} n={r['deduped_signals']:>3}  "
              f"W/L={r['wins']}/{r['losses']}  "
              f"win%={r['win_rate_pct']:>5.1f}  "
              f"avgWin={r['avg_win_pct']:+.2f}%  "
              f"avgLoss={r['avg_loss_pct']:+.2f}%  "
              f"avg/trade={r['avg_pct_per_trade']:+.2f}%  "
              f"sum={r['total_pct_if_all_taken']:+.1f}%")

    # Aggregate.
    tot_wins = sum(r.get("wins", 0) for r in rows if "wins" in r)
    tot_losses = sum(r.get("losses", 0) for r in rows if "losses" in r)
    tot_closed = tot_wins + tot_losses
    overall_win = (tot_wins / tot_closed * 100) if tot_closed else 0.0
    tot_pct = sum(r.get("total_pct_if_all_taken", 0) for r in rows if "wins" in r)
    print("-" * 90)
    print(f"AGGREGATE: {tot_closed} trades across {len([r for r in rows if 'wins' in r])} symbols")
    print(f"  overall win rate: {overall_win:.1f}% ({tot_wins}W / {tot_losses}L)")
    print(f"  total return if all 8 symbols traded equally: {tot_pct:+.1f}%")


if __name__ == "__main__":
    main()
