"""Pattern-specific backtesting engine — Phase 7.

Walks an OHLCV history bar-by-bar. At each bar, runs the rule engine on
the lookback window ending at that bar. Any detected pattern whose
confidence ≥ min_confidence and whose name is in the requested filter
gets simulated:

  • Entry — open of the *next* bar (no lookahead).
  • Exit  — whichever of target_price / stop_price hits first, at the
            extreme of the first bar to touch it. If neither hits within
            `max_hold_bars`, exit at that bar's close ("expired").
  • Size  — risk_per_trade_pct of current equity ÷ |entry − stop|, floored
            to whole shares.

Only one open position at a time per backtest run; signals while a trade
is open are skipped (mirrors how the live patternEngine behaves).

Output schema (matches the spec):
  total_trades, win_rate, profit_factor, total_return_pct,
  max_drawdown, sharpe, avg_rr_achieved,
  by_pattern: { name: {trades, wins, win_rate, avg_pnl, best_trade, worst_trade} },
  equity_curve: [{date, equity}],
  trade_log: [...]

This module is *deliberately* independent of `backtest.py` (the full
strategy backtester). Patterns are a discrete primitive — different
sizing model, different exit logic — and merging the two would muddy
each.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from math import sqrt
from typing import Dict, Iterable, List, Optional

import pandas as pd

from patterns.confidence_engine import score_many
from patterns.ml_classifier import EnsembleProbabilities
from patterns.pattern_definitions import ALL_DETECTORS, run_detector_safely
from patterns.rule_engine import RuleEngineConfig, run_all_patterns

# Force rule-only ML probabilities throughout the backtest, per spec
# ("no ML — rule-based only for speed"). Avoids touching the model
# registry on every bar.
_RULE_ONLY_ML = EnsembleProbabilities(
    no_move=1.0 / 3, bullish_move=1.0 / 3, bearish_move=1.0 / 3, source="rule_only",
)


# ─── Config ────────────────────────────────────────────────────────────────

@dataclass
class PatternBacktestRequest:
    symbol: str
    capital: float = 100_000.0
    risk_per_trade_pct: float = 1.0
    min_confidence: int = 60
    timeframe: str = "D1"
    pattern_names: Optional[List[str]] = None  # None = all patterns
    lookback: int = 100
    warmup: int = 100          # bars before the first eligible entry
    max_hold_bars: int = 30    # cap holding period (avoid infinite stalls)
    slippage_bps: float = 2.0  # cost model — per side
    brokerage_pct: float = 0.0  # per side
    periods_per_year: int = 252  # daily; caller can override (M5 ≈ 75 * 252)


@dataclass
class _BTrade:
    """Internal trade record. Serialised through to the API in `trade_log`."""
    pattern_name: str
    direction: str
    entry_idx: int
    exit_idx: int
    entry_t: int
    exit_t: int
    entry: float
    exit: float
    qty: int
    pnl: float
    pnl_pct: float
    rr_planned: float
    rr_achieved: float
    outcome: str  # "win" | "loss" | "breakeven" | "expired"
    hold_bars: int
    confidence: int
    grade: str

    def to_dict(self) -> dict:
        return {
            "pattern_name": self.pattern_name,
            "direction": self.direction,
            "entry_idx": self.entry_idx,
            "exit_idx": self.exit_idx,
            "entry_t": self.entry_t,
            "exit_t": self.exit_t,
            "entry": round(self.entry, 4),
            "exit": round(self.exit, 4),
            "qty": self.qty,
            "pnl": round(self.pnl, 2),
            "pnl_pct": round(self.pnl_pct, 4),
            "rr_planned": round(self.rr_planned, 3),
            "rr_achieved": round(self.rr_achieved, 3),
            "outcome": self.outcome,
            "hold_bars": self.hold_bars,
            "confidence": self.confidence,
            "grade": self.grade,
        }


# ─── Metric helpers ────────────────────────────────────────────────────────

def _sharpe(returns: List[float], ppy: int) -> float:
    if not returns:
        return 0.0
    mean = sum(returns) / len(returns)
    var = sum((r - mean) ** 2 for r in returns) / len(returns)
    sd = sqrt(var)
    return (mean / sd) * sqrt(ppy) if sd > 0 else 0.0


def _max_drawdown(curve: List[float]) -> float:
    if not curve:
        return 0.0
    peak = curve[0]
    mdd = 0.0
    for v in curve:
        peak = max(peak, v)
        if peak > 0:
            mdd = min(mdd, (v - peak) / peak)
    return round(mdd * 100, 3)


def _profit_factor(trades: List[_BTrade]) -> float:
    wins = sum(t.pnl for t in trades if t.pnl > 0)
    losses = -sum(t.pnl for t in trades if t.pnl < 0)
    if losses <= 0:
        return float("inf") if wins > 0 else 0.0
    return round(wins / losses, 3)


def _timestamp_iso(ms: int) -> str:
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat()
    except Exception:  # noqa: BLE001
        return ""


# ─── Backtester ───────────────────────────────────────────────────────────

def run_pattern_backtest(df: pd.DataFrame, req: PatternBacktestRequest) -> dict:
    """Run the pattern backtest. `df` must already be normalized
    (open/high/low/close/volume/time columns) — callers should pass it
    through `ensure_df` first."""
    n = len(df)
    if n < req.warmup + 5:
        return {"error": f"need at least {req.warmup + 5} bars, got {n}"}

    name_filter = (set(req.pattern_names) if req.pattern_names else None)
    cfg = RuleEngineConfig(lookback=req.lookback)

    equity = req.capital
    peak_equity = equity
    equity_curve: List[dict] = []
    bar_returns: List[float] = []
    last_equity = equity

    open_pos: Optional[dict] = None
    completed: List[_BTrade] = []
    skipped_due_to_open = 0
    skipped_due_to_filter = 0

    # The detector list is fixed; if a filter is in play we still call all
    # detectors but filter by name on the result. The rule engine handles
    # the full machinery (volume/ATR/trend filters).
    for i in range(req.warmup, n):
        bar = df.iloc[i]
        bar_time = int(bar["time"])
        bar_high = float(bar["high"])
        bar_low = float(bar["low"])
        bar_close = float(bar["close"])

        # ── Exit logic for an existing position ─────────────────────────
        if open_pos is not None:
            side = open_pos["direction"]
            exit_price: Optional[float] = None
            outcome: Optional[str] = None
            if side == "bullish":
                if bar_low <= open_pos["stop"]:
                    exit_price = open_pos["stop"]; outcome = "loss"
                elif bar_high >= open_pos["target"]:
                    exit_price = open_pos["target"]; outcome = "win"
            elif side == "bearish":
                if bar_high >= open_pos["stop"]:
                    exit_price = open_pos["stop"]; outcome = "loss"
                elif bar_low <= open_pos["target"]:
                    exit_price = open_pos["target"]; outcome = "win"
            else:  # continuation / neutral — direction-agnostic; closer barrier wins.
                d_t = abs(bar_close - open_pos["target"])
                d_s = abs(bar_close - open_pos["stop"])
                if d_t < 1e-6 or d_s < 1e-6:
                    exit_price = bar_close
                    outcome = "win" if d_t <= d_s else "loss"

            hold_bars = i - int(open_pos["entry_idx"])
            if exit_price is None and hold_bars >= req.max_hold_bars:
                exit_price = bar_close
                outcome = "expired"

            if exit_price is not None and outcome is not None:
                qty = int(open_pos["qty"])
                slip_per_share = exit_price * (req.slippage_bps / 10_000)
                fill = exit_price - slip_per_share if side == "bullish" else exit_price + slip_per_share
                if side == "bullish":
                    pnl_gross = (fill - open_pos["entry"]) * qty
                else:
                    pnl_gross = (open_pos["entry"] - fill) * qty
                brok = req.brokerage_pct / 100.0 * ((open_pos["entry"] + fill) / 2.0) * qty * 2.0
                pnl_net = pnl_gross - brok
                equity += pnl_net
                rr_planned = open_pos["rr_planned"]
                risk = open_pos["risk_per_share"] * qty
                rr_achieved = (pnl_net / risk) if risk > 1e-9 else 0.0
                if outcome == "win" and abs(rr_achieved) < 0.05:
                    outcome = "breakeven"

                completed.append(_BTrade(
                    pattern_name=open_pos["pattern_name"],
                    direction=side,
                    entry_idx=int(open_pos["entry_idx"]),
                    exit_idx=i,
                    entry_t=int(open_pos["entry_t"]),
                    exit_t=bar_time,
                    entry=open_pos["entry"],
                    exit=fill,
                    qty=qty,
                    pnl=pnl_net,
                    pnl_pct=(pnl_net / max(open_pos["entry"] * qty, 1e-9)) * 100,
                    rr_planned=rr_planned,
                    rr_achieved=rr_achieved,
                    outcome=outcome,
                    hold_bars=hold_bars,
                    confidence=open_pos["confidence"],
                    grade=open_pos["grade"],
                ))
                open_pos = None

        # Equity curve tick.
        peak_equity = max(peak_equity, equity)
        equity_curve.append({"t": bar_time, "date": _timestamp_iso(bar_time), "equity": round(equity, 2)})
        if last_equity > 0:
            bar_returns.append((equity - last_equity) / last_equity)
        last_equity = equity

        # ── Entry logic ─────────────────────────────────────────────────
        if open_pos is not None:
            skipped_due_to_open += 1
            continue
        if i + 1 >= n:  # need a next bar for entry-on-next-open
            continue
        window = df.iloc[: i + 1].reset_index(drop=True)
        detections = run_all_patterns(window, config=cfg)
        if not detections:
            continue

        # Confidence-engine pass (rule-only ML, per spec). score_many
        # attaches `confidence_score` + `grade` + breakdowns to each row.
        scored = score_many(detections, window, timeframe=req.timeframe, ml_probs=_RULE_ONLY_ML)

        # Pick the highest-confidence detection in the filter, that has a
        # full trade plan (entry/target/stop). Skip otherwise.
        candidates: List[dict] = []
        for d in scored:
            name = d.get("pattern_name") or ""
            if name_filter is not None and name not in name_filter:
                skipped_due_to_filter += 1
                continue
            if int(d.get("confidence_score", 0)) < req.min_confidence:
                continue
            if d.get("entry_price") is None or d.get("target_price") is None or d.get("stop_price") is None:
                continue
            candidates.append(d)
        if not candidates:
            continue

        d = max(candidates, key=lambda x: int(x.get("confidence_score", 0)))
        next_bar = df.iloc[i + 1]
        entry_price = float(next_bar["open"])
        stop_price = float(d["stop_price"])
        target_price = float(d["target_price"])
        # Skip degenerate plans (entry on the wrong side of stop/target).
        if d["direction"] == "bullish" and not (stop_price < entry_price < target_price):
            continue
        if d["direction"] == "bearish" and not (target_price < entry_price < stop_price):
            continue

        risk_per_share = abs(entry_price - stop_price)
        if risk_per_share < 1e-6:
            continue
        risk_budget = equity * (req.risk_per_trade_pct / 100.0)
        qty = int(risk_budget // risk_per_share)
        if qty <= 0:
            continue
        # Slippage on entry too — adverse-side fill.
        slip = entry_price * (req.slippage_bps / 10_000)
        fill = entry_price + slip if d["direction"] == "bullish" else entry_price - slip
        rr_planned = abs(target_price - entry_price) / risk_per_share

        open_pos = {
            "pattern_name": d.get("pattern_name") or "Unknown",
            "direction": d["direction"],
            "entry": fill,
            "stop": stop_price,
            "target": target_price,
            "qty": qty,
            "entry_idx": i + 1,
            "entry_t": int(df.iloc[i + 1]["time"]),
            "risk_per_share": risk_per_share,
            "rr_planned": rr_planned,
            "confidence": int(d.get("confidence_score") or 0),
            "grade": str(d.get("grade") or "C"),
        }

    # Final close-out if still open at the last bar — count as expired.
    if open_pos is not None and len(df) > open_pos["entry_idx"] + 1:
        last = df.iloc[-1]
        exit_price = float(last["close"])
        qty = int(open_pos["qty"])
        side = open_pos["direction"]
        if side == "bullish":
            pnl_gross = (exit_price - open_pos["entry"]) * qty
        else:
            pnl_gross = (open_pos["entry"] - exit_price) * qty
        brok = req.brokerage_pct / 100.0 * ((open_pos["entry"] + exit_price) / 2.0) * qty * 2.0
        pnl_net = pnl_gross - brok
        equity += pnl_net
        risk = open_pos["risk_per_share"] * qty
        rr_achieved = (pnl_net / risk) if risk > 1e-9 else 0.0
        outcome = "expired"
        if pnl_net > 0 and rr_achieved >= 0.5:
            outcome = "win"
        elif pnl_net < 0 and rr_achieved <= -0.5:
            outcome = "loss"
        completed.append(_BTrade(
            pattern_name=open_pos["pattern_name"],
            direction=side,
            entry_idx=int(open_pos["entry_idx"]),
            exit_idx=len(df) - 1,
            entry_t=int(open_pos["entry_t"]),
            exit_t=int(last["time"]),
            entry=open_pos["entry"],
            exit=exit_price,
            qty=qty,
            pnl=pnl_net,
            pnl_pct=(pnl_net / max(open_pos["entry"] * qty, 1e-9)) * 100,
            rr_planned=open_pos["rr_planned"],
            rr_achieved=rr_achieved,
            outcome=outcome,
            hold_bars=len(df) - 1 - int(open_pos["entry_idx"]),
            confidence=open_pos["confidence"],
            grade=open_pos["grade"],
        ))
        open_pos = None

    # ── Aggregate metrics ──────────────────────────────────────────────
    total_trades = len(completed)
    wins = sum(1 for t in completed if t.outcome == "win")
    losses = sum(1 for t in completed if t.outcome == "loss")
    win_rate = wins / total_trades if total_trades else 0.0

    total_return_pct = ((equity - req.capital) / req.capital) * 100 if req.capital else 0.0
    equity_values = [c["equity"] for c in equity_curve]
    max_dd_pct = _max_drawdown(equity_values)
    sharpe = _sharpe(bar_returns, req.periods_per_year)
    avg_rr_achieved = (sum(t.rr_achieved for t in completed) / total_trades) if total_trades else 0.0

    # Per-pattern breakdown.
    by_pattern: Dict[str, dict] = {}
    for t in completed:
        b = by_pattern.setdefault(t.pattern_name, {
            "trades": 0, "wins": 0, "losses": 0, "breakevens": 0, "expired": 0,
            "pnl_total": 0.0, "best_trade": None, "worst_trade": None,
        })
        b["trades"] += 1
        if t.outcome == "win":
            b["wins"] += 1
        elif t.outcome == "loss":
            b["losses"] += 1
        elif t.outcome == "breakeven":
            b["breakevens"] += 1
        else:
            b["expired"] += 1
        b["pnl_total"] += t.pnl
        if b["best_trade"] is None or t.pnl > b["best_trade"]:
            b["best_trade"] = round(t.pnl, 2)
        if b["worst_trade"] is None or t.pnl < b["worst_trade"]:
            b["worst_trade"] = round(t.pnl, 2)
    for name, rollup in by_pattern.items():
        trades = max(rollup["trades"], 1)
        rollup["win_rate"] = round(rollup["wins"] / trades, 4)
        rollup["avg_pnl"] = round(rollup["pnl_total"] / trades, 2)
        rollup["pnl_total"] = round(rollup["pnl_total"], 2)

    return {
        "symbol": req.symbol,
        "timeframe": req.timeframe,
        "config": {
            "capital": req.capital,
            "risk_per_trade_pct": req.risk_per_trade_pct,
            "min_confidence": req.min_confidence,
            "pattern_names": sorted(name_filter) if name_filter else None,
            "warmup": req.warmup,
            "lookback": req.lookback,
            "max_hold_bars": req.max_hold_bars,
            "slippage_bps": req.slippage_bps,
            "brokerage_pct": req.brokerage_pct,
            "periods_per_year": req.periods_per_year,
        },
        "total_trades": total_trades,
        "wins": wins,
        "losses": losses,
        "win_rate": round(win_rate, 4),
        "profit_factor": _profit_factor(completed),
        "total_return_pct": round(total_return_pct, 3),
        "max_drawdown": max_dd_pct,
        "sharpe": round(sharpe, 3),
        "avg_rr_achieved": round(avg_rr_achieved, 3),
        "final_equity": round(equity, 2),
        "skipped_due_to_open": skipped_due_to_open,
        "skipped_due_to_filter": skipped_due_to_filter,
        "by_pattern": by_pattern,
        "equity_curve": equity_curve,
        "trade_log": [t.to_dict() for t in completed],
    }


def list_all_pattern_names() -> List[str]:
    """Helper for the frontend multi-select: every detector name in load order."""
    names = []
    for det in ALL_DETECTORS:
        # detector function name → display name. e.g. detect_bullish_engulfing → "Bullish Engulfing".
        raw = det.__name__.replace("detect_", "")
        names.append(raw.replace("_", " ").title())
    # Deduplicate while preserving order.
    seen: set[str] = set()
    out: List[str] = []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out
