"""Backtest engine: replays candles through the strategy and simulates the
same auto-trader / paper-broker logic that runs in production.

Supports the same toggles the live engine does (regime, MTF, fixed/ATR stop,
trailing stop, partial TP) plus brokerage modeling and an expanded metric
suite (Sharpe / Sortino / Calmar / Expectancy / monthly returns).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from math import sqrt
from typing import Dict, List, Optional

from strategy import StrategyConfig, evaluate


@dataclass
class BacktestRequest:
    candles: List[dict]
    capital: float = 100_000.0
    risk_per_trade_pct: float = 1.0
    max_open: int = 3
    min_confidence: float = 0.55
    warmup: int = 60
    slippage_bps: float = 2.0
    strategy_cfg: StrategyConfig = field(default_factory=StrategyConfig)
    trailing_stop_pct: Optional[float] = None
    partial_tp: bool = False
    # Cost model (round-trip = entry + exit, applied per trade).
    brokerage_flat: float = 0.0       # e.g. ₹40 (₹20 each side)
    brokerage_pct: float = 0.0        # e.g. 0.0003 = 0.03% per side, charged round-trip
    periods_per_year: int = 94500     # ~1m bars in an NSE year
    # Max candles handed to evaluate() per decision. The live signal engine
    # sends the most recent 500 candles, so 500 both matches production and
    # keeps long backtests O(n) instead of O(n²). None = full history.
    eval_window: Optional[int] = 500


@dataclass
class CompletedTrade:
    symbol: str
    side: str
    qty: int
    entry_price: float
    exit_price: float
    entry_idx: int
    exit_idx: int
    entry_t: int       # epoch ms
    exit_t: int        # epoch ms
    gross_pnl: float
    brokerage: float
    pnl: float         # net of brokerage
    pnl_pct: float     # gross % return relative to entry notional
    reason: str
    duration_ms: int


# ----------------------------------------------------------------------- metrics

def _sharpe(returns: List[float], ppy: int) -> float:
    if not returns:
        return 0.0
    mean_r = sum(returns) / len(returns)
    var_r = sum((r - mean_r) ** 2 for r in returns) / len(returns)
    std_r = sqrt(var_r)
    return (mean_r / std_r) * sqrt(ppy) if std_r > 0 else 0.0


def _sortino(returns: List[float], ppy: int) -> float:
    if not returns:
        return 0.0
    mean_r = sum(returns) / len(returns)
    downside = [r for r in returns if r < 0]
    if not downside:
        return float("inf") if mean_r > 0 else 0.0
    dvar = sum(r * r for r in downside) / len(downside)
    dstd = sqrt(dvar)
    return (mean_r / dstd) * sqrt(ppy) if dstd > 0 else 0.0


def _aggregate_daily_returns(equity_curve: List[dict]) -> List[float]:
    """Collapse bar-level equity to one return per trading day.

    Bar-level Sharpe is meaningless on intraday backtests because most bars
    show near-zero equity change (open positions held flat), which crushes the
    return standard deviation and inflates Sharpe by 10×–100×. The industry
    convention is daily returns. We group equity points by calendar day and
    take the close-to-close return.
    """
    if len(equity_curve) < 2:
        return []
    by_day: Dict[str, List[dict]] = {}
    for p in equity_curve:
        try:
            dt = datetime.fromtimestamp(p["t"] / 1000.0, tz=timezone.utc)
            key = dt.strftime("%Y-%m-%d")
        except Exception:
            continue
        by_day.setdefault(key, []).append(p)
    daily_closes = []
    for key in sorted(by_day.keys()):
        pts = by_day[key]
        daily_closes.append(pts[-1]["equity"])
    if len(daily_closes) < 2:
        return []
    rets: List[float] = []
    for i in range(1, len(daily_closes)):
        prev = daily_closes[i - 1]
        if prev > 0:
            rets.append((daily_closes[i] - prev) / prev)
    return rets


def _calmar(total_return_pct: float, max_dd_pct: float, bars: int, ppy: int) -> float:
    if max_dd_pct <= 0 or bars <= 0:
        return 0.0
    years = bars / ppy if ppy > 0 else 1.0
    if years <= 0:
        return 0.0
    annualized_return_pct = (((1 + total_return_pct / 100) ** (1 / years)) - 1) * 100
    return annualized_return_pct / max_dd_pct


def _monthly_returns(equity_curve: List[dict]) -> Dict[str, float]:
    """Group equity_curve by calendar month, return {YYYY-MM: pct_return}."""
    if len(equity_curve) < 2:
        return {}
    buckets: Dict[str, List[dict]] = {}
    for p in equity_curve:
        try:
            dt = datetime.fromtimestamp(p["t"] / 1000.0, tz=timezone.utc)
            key = dt.strftime("%Y-%m")
        except Exception:
            continue
        buckets.setdefault(key, []).append(p)
    out: Dict[str, float] = {}
    for key, points in buckets.items():
        if len(points) < 2:
            continue
        start_eq = points[0]["equity"]
        end_eq = points[-1]["equity"]
        if start_eq > 0:
            out[key] = round((end_eq - start_eq) / start_eq * 100.0, 3)
    return out


def _brokerage_for(notional: float, req: BacktestRequest) -> float:
    """Round-trip brokerage = flat + pct of entry+exit notional."""
    return req.brokerage_flat + (req.brokerage_pct / 100.0) * notional * 2.0


# ----------------------------------------------------------------------- engine

def run_backtest(req: BacktestRequest, symbol: str = "TEST") -> dict:
    candles = req.candles
    if len(candles) < req.warmup + 10:
        return {"error": f"Need at least {req.warmup + 10} candles"}

    equity = req.capital
    realised = 0.0
    peak = equity
    max_dd = 0.0
    open_pos: Optional[dict] = None
    trades: List[CompletedTrade] = []
    equity_curve: List[dict] = []
    bar_returns: List[float] = []
    last_equity_for_return = equity

    filters_blocked = 0
    partial_exits = 0

    for i in range(req.warmup, len(candles)):
        window = candles[: i + 1]
        bar = candles[i]
        close = float(bar["c"])
        high = float(bar["h"])
        low = float(bar["l"])

        if open_pos is not None:
            # Trailing stop adjustment.
            if req.trailing_stop_pct is not None and req.trailing_stop_pct > 0:
                if open_pos["side"] == "LONG":
                    open_pos["high_watermark"] = max(open_pos["high_watermark"], high)
                    candidate = open_pos["high_watermark"] * (1 - req.trailing_stop_pct / 100)
                    if candidate > open_pos["stop"]:
                        open_pos["stop"] = candidate
                else:
                    open_pos["low_watermark"] = min(open_pos["low_watermark"], low)
                    candidate = open_pos["low_watermark"] * (1 + req.trailing_stop_pct / 100)
                    if candidate < open_pos["stop"]:
                        open_pos["stop"] = candidate

            # Partial TP at 1R.
            if req.partial_tp and not open_pos["partial_done"]:
                r = abs(open_pos["entry"] - open_pos["initial_stop"])
                if open_pos["side"] == "LONG" and high >= open_pos["entry"] + r:
                    half_qty = open_pos["qty"] // 2
                    if half_qty > 0:
                        exit_p = open_pos["entry"] + r
                        slip = exit_p * req.slippage_bps / 10_000
                        fill = exit_p - slip
                        gross_pnl = (fill - open_pos["entry"]) * half_qty
                        notional = (open_pos["entry"] + fill) / 2 * half_qty
                        brok = _brokerage_for(notional, req)
                        net = gross_pnl - brok
                        realised += net
                        trades.append(_make_trade(symbol, "LONG", half_qty, open_pos, fill, i,
                                                  candles[open_pos["entry_idx"]]["t"], bar["t"],
                                                  gross_pnl, brok, net, "PARTIAL_TP"))
                        open_pos["qty"] -= half_qty
                        open_pos["stop"] = open_pos["entry"]
                        open_pos["partial_done"] = True
                        partial_exits += 1
                elif open_pos["side"] == "SHORT" and low <= open_pos["entry"] - r:
                    half_qty = open_pos["qty"] // 2
                    if half_qty > 0:
                        exit_p = open_pos["entry"] - r
                        slip = exit_p * req.slippage_bps / 10_000
                        fill = exit_p + slip
                        gross_pnl = (open_pos["entry"] - fill) * half_qty
                        notional = (open_pos["entry"] + fill) / 2 * half_qty
                        brok = _brokerage_for(notional, req)
                        net = gross_pnl - brok
                        realised += net
                        trades.append(_make_trade(symbol, "SHORT", half_qty, open_pos, fill, i,
                                                  candles[open_pos["entry_idx"]]["t"], bar["t"],
                                                  gross_pnl, brok, net, "PARTIAL_TP"))
                        open_pos["qty"] -= half_qty
                        open_pos["stop"] = open_pos["entry"]
                        open_pos["partial_done"] = True
                        partial_exits += 1

            # Final exit check. Gap-open handling: if the bar's open is already
            # past the stop, fill at the open (worse) — not at the stop level.
            # Real markets do not let you exit at a price the market never
            # actually traded through cleanly; gaps are the most common source
            # of inflated backtest results.
            exit_price: Optional[float] = None
            reason = ""
            bar_open = float(bar["o"])
            if open_pos["side"] == "LONG":
                if bar_open <= open_pos["stop"]:
                    exit_price = bar_open  # gap-down past stop → fill at open
                    reason = "SL_GAP" if not open_pos["partial_done"] else "TRAIL_GAP"
                elif low <= open_pos["stop"]:
                    exit_price = open_pos["stop"]
                    reason = "SL" if not open_pos["partial_done"] else "TRAIL"
                elif bar_open >= open_pos["target"]:
                    exit_price = bar_open  # gap-up past target → fill at open (better)
                    reason = "TP_GAP"
                elif high >= open_pos["target"]:
                    exit_price = open_pos["target"]
                    reason = "TP"
            else:
                if bar_open >= open_pos["stop"]:
                    exit_price = bar_open  # gap-up past short stop → fill at open
                    reason = "SL_GAP" if not open_pos["partial_done"] else "TRAIL_GAP"
                elif high >= open_pos["stop"]:
                    exit_price = open_pos["stop"]
                    reason = "SL" if not open_pos["partial_done"] else "TRAIL"
                elif bar_open <= open_pos["target"]:
                    exit_price = bar_open
                    reason = "TP_GAP"
                elif low <= open_pos["target"]:
                    exit_price = open_pos["target"]
                    reason = "TP"
            if exit_price is not None and open_pos["qty"] > 0:
                slip = exit_price * req.slippage_bps / 10_000
                fill = exit_price - slip if open_pos["side"] == "LONG" else exit_price + slip
                gross_pnl = (fill - open_pos["entry"]) * open_pos["qty"]
                if open_pos["side"] == "SHORT":
                    gross_pnl = (open_pos["entry"] - fill) * open_pos["qty"]
                notional = (open_pos["entry"] + fill) / 2 * open_pos["qty"]
                brok = _brokerage_for(notional, req)
                net = gross_pnl - brok
                realised += net
                trades.append(_make_trade(symbol, open_pos["side"], open_pos["qty"], open_pos, fill, i,
                                          candles[open_pos["entry_idx"]]["t"], bar["t"],
                                          gross_pnl, brok, net, reason))
                open_pos = None

        # Open new position.
        #
        # No same-bar look-ahead: the decision is made on bars STRICTLY BEFORE
        # bar `i` (i.e. on candles[:i]) and the order fills at bar `i`'s OPEN.
        # The previous logic decided on candles[:i+1] and filled at the close
        # of the same bar — that injected up to 1 bar of forward-looking
        # information and inflated paper-profit results.
        if open_pos is None:
            win_start = max(0, i - req.eval_window) if req.eval_window else 0
            decision = evaluate(candles[win_start:i], req.strategy_cfg)
            if (
                decision.action in ("BUY", "SELL")
                and decision.confidence >= req.min_confidence
                and decision.suggested_stop is not None
                and decision.suggested_target is not None
            ):
                # Fill at the OPEN of bar i (the next bar after the decision).
                bar_open = float(bar["o"])
                # Re-anchor stop/target distances to the actual fill price so
                # the R:R stays as the strategy intended even when the open
                # gaps away from the close that produced the signal.
                ref_entry = decision.suggested_entry or float(candles[i - 1]["c"])
                stop_dist = abs(ref_entry - decision.suggested_stop)
                target_dist = abs(decision.suggested_target - ref_entry)
                if decision.action == "BUY":
                    stop = bar_open - stop_dist
                    target = bar_open + target_dist
                else:
                    stop = bar_open + stop_dist
                    target = bar_open - target_dist
                per_share_risk = abs(bar_open - stop)
                if per_share_risk > 0:
                    risk_amount = (req.capital * req.risk_per_trade_pct) / 100
                    qty = int(risk_amount // per_share_risk)
                    if qty > 0:
                        slip = bar_open * req.slippage_bps / 10_000
                        fill = bar_open + slip if decision.action == "BUY" else bar_open - slip
                        open_pos = {
                            "side": "LONG" if decision.action == "BUY" else "SHORT",
                            "qty": qty,
                            "entry": fill,
                            "initial_stop": stop,
                            "stop": stop,
                            "target": target,
                            "entry_idx": i,
                            "high_watermark": fill,
                            "low_watermark": fill,
                            "partial_done": False,
                        }
            elif decision.action == "HOLD" and not decision.filters.get("regime", True):
                filters_blocked += 1
            elif decision.action == "HOLD" and not decision.filters.get("mtf", True):
                filters_blocked += 1

        # Mark-to-market.
        unrealised = 0.0
        if open_pos is not None:
            if open_pos["side"] == "LONG":
                unrealised = (close - open_pos["entry"]) * open_pos["qty"]
            else:
                unrealised = (open_pos["entry"] - close) * open_pos["qty"]
        equity = req.capital + realised + unrealised
        peak = max(peak, equity)
        dd = (peak - equity) / peak * 100 if peak > 0 else 0.0
        max_dd = max(max_dd, dd)
        equity_curve.append({
            "t": int(bar["t"]),
            "equity": round(equity, 2),
            "drawdownPct": round(dd, 3),
        })
        bar_returns.append((equity - last_equity_for_return) / last_equity_for_return if last_equity_for_return > 0 else 0.0)
        last_equity_for_return = equity

    # Metrics.
    wins = [t for t in trades if t.pnl > 0]
    losses = [t for t in trades if t.pnl <= 0]
    gross_profit = sum(t.pnl for t in wins)
    gross_loss = -sum(t.pnl for t in losses)
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (float("inf") if gross_profit > 0 else 0.0)
    avg_win = (gross_profit / len(wins)) if wins else 0.0
    avg_loss = (-gross_loss / len(losses)) if losses else 0.0
    win_rate = len(wins) / len(trades) if trades else 0.0
    loss_rate = len(losses) / len(trades) if trades else 0.0
    expectancy = (win_rate * avg_win) - (loss_rate * abs(avg_loss)) if trades else 0.0

    total_return_pct = (equity - req.capital) / req.capital * 100
    bars_evaluated = len(equity_curve)
    # Compute Sharpe/Sortino on DAILY returns, not per-bar returns. NSE has
    # ~252 trading days/year. Reporting bar-level Sharpe on intraday data
    # produces values of 30+ which look impressive but are not comparable to
    # any standard benchmark.
    daily_returns = _aggregate_daily_returns(equity_curve)
    trading_days_per_year = 252
    sharpe = _sharpe(daily_returns, trading_days_per_year) if daily_returns else 0.0
    sortino = _sortino(daily_returns, trading_days_per_year) if daily_returns else 0.0
    calmar = _calmar(total_return_pct, max_dd, bars_evaluated, req.periods_per_year)
    monthly = _monthly_returns(equity_curve)
    total_brokerage = sum(t.brokerage for t in trades)

    return {
        "summary": {
            "startEquity": req.capital,
            "endEquity": round(equity, 2),
            "totalReturnPct": round(total_return_pct, 3),
            "netPnl": round(equity - req.capital, 2),
            "maxDrawdownPct": round(max_dd, 3),
            "trades": len(trades),
            "wins": len(wins),
            "losses": len(losses),
            "winRate": round(win_rate, 4),
            "lossRate": round(loss_rate, 4),
            "profitFactor": round(profit_factor, 3) if profit_factor != float("inf") else None,
            "avgWin": round(avg_win, 2),
            "avgLoss": round(avg_loss, 2),
            "expectancy": round(expectancy, 4),
            "sharpe": round(sharpe, 3),
            "sortino": round(sortino, 3) if sortino != float("inf") else None,
            "calmar": round(calmar, 3),
            "partialExits": partial_exits,
            "filterBlocked": filters_blocked,
            "totalBrokerage": round(total_brokerage, 2),
            "barsEvaluated": bars_evaluated,
        },
        "equityCurve": equity_curve,
        "monthlyReturns": monthly,
        "trades": [t.__dict__ for t in trades],
    }


def _make_trade(symbol, side, qty, open_pos, fill, exit_idx, entry_t, exit_t,
                gross_pnl, brokerage, net_pnl, reason) -> CompletedTrade:
    notional = open_pos["entry"] * qty
    pnl_pct = (gross_pnl / notional * 100) if notional > 0 else 0.0
    return CompletedTrade(
        symbol=symbol,
        side=side,
        qty=qty,
        entry_price=round(open_pos["entry"], 2),
        exit_price=round(fill, 2),
        entry_idx=open_pos["entry_idx"],
        exit_idx=exit_idx,
        entry_t=int(entry_t),
        exit_t=int(exit_t),
        gross_pnl=round(gross_pnl, 2),
        brokerage=round(brokerage, 2),
        pnl=round(net_pnl, 2),
        pnl_pct=round(pnl_pct, 3),
        reason=reason,
        duration_ms=int(exit_t) - int(entry_t),
    )
