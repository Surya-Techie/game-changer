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

# Round-trip trading cost as a % of notional, deducted from EVERY trade's
# return so the reported edge is net, not gross. 2 bps slippage/side +
# ~0.03% brokerage/side + STT/charges ≈ 0.10% round-trip for NSE intraday.
# Win rate ignores this entirely — expectancy does not, which is the point.
ROUND_TRIP_COST_PCT = 0.10


def _expectancy_stats(pnl_pcts: list[float]) -> dict:
    """Turn a list of per-trade %-returns (net of cost) into the metrics
    that actually decide profitability — not just win rate.

    - expectancy  : average % gained per trade (the single number that
                    determines whether the edge compounds or bleeds).
    - profit_factor: gross wins / gross losses. >1 = profitable, and it
                    can be <1 even at an 80% win rate if the losers are big.
    - max_drawdown: worst peak-to-trough on the cumulative-return curve.
    - max_consec_losses: tail-risk / psychological survivability.
    """
    if not pnl_pcts:
        return {"expectancy_pct": 0.0, "profit_factor": 0.0,
                "max_drawdown_pct": 0.0, "max_consec_losses": 0}
    wins = [p for p in pnl_pcts if p > 0]
    losses = [p for p in pnl_pcts if p <= 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = (gross_win / gross_loss) if gross_loss > 1e-9 else (99.0 if gross_win > 0 else 0.0)
    expectancy = sum(pnl_pcts) / len(pnl_pcts)
    # Max drawdown on the cumulative (sum) equity curve, in % points.
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    consec = max_consec = 0
    for p in pnl_pcts:
        cum += p
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)
        if p <= 0:
            consec += 1
            max_consec = max(max_consec, consec)
        else:
            consec = 0
    return {
        "expectancy_pct": round(expectancy, 3),
        "profit_factor": round(profit_factor, 2),
        "max_drawdown_pct": round(max_dd, 2),
        "max_consec_losses": max_consec,
    }


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
            strict="--strict" in sys.argv,
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

    # `wins/losses` track the target-vs-stop outcome (the "win rate").
    # `pnl_pcts` are NET of round-trip cost — so expectancy/profit-factor
    # below reflect what the edge is actually worth after frictions. The
    # gap between the two is the whole reason win rate alone is misleading.
    wins = losses = 0
    pnl_pcts: list[float] = []
    for idx, r in deduped:
        outcome, ret = resolve(r, candles, idx)
        pnl_pcts.append(ret * 100 - ROUND_TRIP_COST_PCT)
        if outcome == "win":
            wins += 1
        else:
            losses += 1

    total = wins + losses
    win_rate = (wins / total * 100) if total else 0.0
    avg_ret = sum(pnl_pcts) / len(pnl_pcts) if pnl_pcts else 0.0
    avg_win = (sum(p for p in pnl_pcts if p > 0) / max(1, sum(1 for p in pnl_pcts if p > 0)))
    avg_loss = (sum(p for p in pnl_pcts if p <= 0) / max(1, sum(1 for p in pnl_pcts if p <= 0)))
    stats = _expectancy_stats(pnl_pcts)
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
        "pnl_pcts": pnl_pcts,
        **stats,
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
              f"win%={r['win_rate_pct']:>5.1f}  "
              f"exp={r['expectancy_pct']:+.2f}%  "
              f"PF={r['profit_factor']:>4.2f}  "
              f"maxDD={r['max_drawdown_pct']:>5.1f}%  "
              f"maxLossStreak={r['max_consec_losses']:>2}  "
              f"netSum={r['total_pct_if_all_taken']:+.1f}%")

    # Aggregate — pool every trade so expectancy/profit-factor are computed
    # on the full sample, net of cost.
    scored = [r for r in rows if "wins" in r]
    tot_wins = sum(r["wins"] for r in scored)
    tot_losses = sum(r["losses"] for r in scored)
    tot_closed = tot_wins + tot_losses
    overall_win = (tot_wins / tot_closed * 100) if tot_closed else 0.0
    all_pnl: list[float] = []
    for r in scored:
        all_pnl.extend(r.get("pnl_pcts", []))
    agg = _expectancy_stats(all_pnl)
    tot_pct = sum(all_pnl)
    print("-" * 90)
    print(f"AGGREGATE: {tot_closed} trades across {len(scored)} symbols "
          f"(net of {ROUND_TRIP_COST_PCT:.2f}% round-trip cost)")
    print(f"  win rate          : {overall_win:.1f}%  ({tot_wins}W / {tot_losses}L)")
    print(f"  expectancy/trade  : {agg['expectancy_pct']:+.3f}%   <- the number that actually compounds")
    print(f"  profit factor     : {agg['profit_factor']:.2f}      (>1 = profitable; can be <1 even at 80% win rate)")
    print(f"  max drawdown      : {agg['max_drawdown_pct']:.1f}%")
    print(f"  max loss streak   : {agg['max_consec_losses']}")
    print(f"  total net return  : {tot_pct:+.1f}%")
    verdict = (
        "POSITIVE expectancy — edge survives costs." if agg["expectancy_pct"] > 0
        else "NEGATIVE expectancy — win rate is a mirage; this bleeds after costs."
    )
    print(f"  VERDICT: {verdict}")
    print("  NOTE: a high win rate with profit_factor <= 1 means small wins / big "
          "losses — it loses money. Always read win rate WITH expectancy + PF.")


if __name__ == "__main__":
    main()
