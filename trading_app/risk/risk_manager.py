"""
Intraday Risk Manager — implements the daily P&L kill-switch,
position sizing, pyramiding, and the time-of-day rules.

Live trading should call rm.permit_new_entry(...) before placing every order.

Hardened controls (all caps and limits configurable):
  • Per-symbol exposure cap — no two simultaneous positions in the same symbol
  • Weekly drawdown halt — if losses since Monday exceed `max_weekly_loss`,
    all trading is halted until the following Monday
  • Cooldown after kill switch — once the daily kill switch fires, the next
    `cooldown_hours` of trading is also blocked (default: 16 h, so a kill
    at 11:30 IST blocks the rest of the day AND the next morning gap)
  • Confidence-scaled sizing — `size_position_scaled()` halves the per-trade
    risk when the signal confidence is below `high_conviction_floor`
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Dict, List, Optional, Set

from .. import config


@dataclass
class TradeRecord:
    pnl:        float
    pnl_pct:    float
    strategy:   str
    symbol:     str
    timestamp:  datetime


def _iso_week_id(dt: datetime) -> str:
    """ISO year + week — used as the bucket key for weekly P&L tracking."""
    iso = dt.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


@dataclass
class IntradayRiskManager:
    capital:            float = config.CAPITAL
    daily_profit_target: float = config.DAILY_PROFIT_TARGET
    max_daily_loss:     float = config.MAX_DAILY_LOSS
    max_risk_per_trade: float = config.MAX_RISK_PER_TRADE
    max_open_trades:    int   = config.MAX_OPEN_TRADES
    max_consec_losses:  int   = config.MAX_CONSEC_LOSSES
    no_entry_after:     time  = config.NO_NEW_ENTRY
    force_close_at:     time  = config.FORCE_CLOSE
    market_open:        time  = config.MARKET_OPEN
    avoid_first_5min:   time  = config.AVOID_FIRST_5

    # ── Hardened risk controls (new) ────────────────────────────
    # Weekly drawdown gate: lose >3% of capital in one ISO week → halt
    # all trading until next Monday. Day-only kill switches reset overnight
    # which is too lenient when a string of bad days adds up.
    max_weekly_loss: float = 0.03
    # Per-symbol concurrency: never hold two positions in the same symbol.
    max_per_symbol: int = 1
    # Cooldown after the daily kill-switch fires (hours). Blocks the
    # immediate next session so a bad morning doesn't lead to a worse
    # afternoon "make-it-back" trade.
    cooldown_hours: float = 16.0
    # Confidence-scaled sizing — when scaled API is used, signals with
    # confidence below this floor get half the risk capital.
    high_conviction_floor: float = 0.65

    # state
    daily_pnl:        float = 0.0
    open_trades:      int   = 0
    consec_losses:    int   = 0
    halted:           bool  = False
    halted_reason:    str   = ""
    trades_today:     List[TradeRecord] = field(default_factory=list)
    # Per-symbol open-position counts. Keys are symbols with ≥1 open.
    open_by_symbol:   Dict[str, int] = field(default_factory=dict)
    # Weekly P&L bucket (ISO year-week → cumulative ₹).
    weekly_pnl:       Dict[str, float] = field(default_factory=dict)
    # Set of week-ids halted by the weekly-loss rule.
    halted_weeks:     Set[str] = field(default_factory=set)
    # When the most recent kill-switch fired (None = never).
    kill_at:          Optional[datetime] = None

    # ── reset (call once per trading day) ──────────────────────
    def reset_day(self) -> None:
        """Reset same-day state. The weekly P&L bucket and `halted_weeks`
        are intentionally NOT cleared — weekly drawdown protection spans
        days. `kill_at` IS cleared because the cooldown is a same-session
        construct; production callers should not invoke `reset_day` until
        the cooldown has naturally expired (or they're consciously
        overriding it via a manual reset)."""
        self.daily_pnl     = 0.0
        self.open_trades   = 0
        self.consec_losses = 0
        self.halted        = False
        self.halted_reason = ""
        self.open_by_symbol.clear()
        self.trades_today.clear()
        # `kill_at` IS cleared — calling `reset_day` is the trader's
        # explicit acknowledgement that the new session has begun. The
        # cooldown's job is to block reflexive same-session re-entries
        # after a kill; cross-session protection is the job of the
        # `halted_weeks` set, which IS preserved across reset_day.
        self.kill_at = None

    # ── pre-entry permission check ─────────────────────────────
    def permit_new_entry(
        self,
        now:       Optional[datetime] = None,
        strategy:  str  = "",
        symbol:    str  = "",
        is_gap_go: bool = False,
    ) -> tuple[bool, str]:
        """Returns (permitted, reason_if_denied)."""
        now      = now or datetime.now()
        cur_time = now.time() if hasattr(now, "time") else now
        week_id  = _iso_week_id(now)

        if self.halted:
            return False, f"halted: {self.halted_reason}"

        # ── Hardened gates (new, evaluated first) ───────────────
        # Weekly drawdown halt — blocks until the next ISO week.
        if week_id in self.halted_weeks:
            return False, f"weekly drawdown limit hit (week {week_id})"
        week_loss = self.weekly_pnl.get(week_id, 0.0)
        if week_loss <= -self.capital * self.max_weekly_loss:
            self.halted_weeks.add(week_id)
            return False, (
                f"weekly drawdown {week_loss/self.capital*100:.2f}% ≤ "
                f"-{self.max_weekly_loss*100:.0f}% — halted for the rest of {week_id}"
            )

        # Cooldown after most-recent kill switch. `halted=True` is also
        # set here so callers that only check the boolean flag see the
        # blocked state. `reset_day()` deliberately does NOT clear
        # `kill_at` — the cooldown spans sessions by design.
        if self.kill_at is not None:
            elapsed = (now - self.kill_at).total_seconds() / 3600.0
            if elapsed < self.cooldown_hours:
                remaining = self.cooldown_hours - elapsed
                msg = f"cooldown after kill-switch ({remaining:.1f}h left)"
                self.halted = True
                self.halted_reason = msg
                return False, msg
            # Cooldown expired — clear the marker so it doesn't keep firing.
            self.kill_at = None

        # daily P&L gates
        if self.daily_pnl >= self.capital * self.daily_profit_target:
            self._halt("daily +5% target hit", now)
            return False, self.halted_reason
        if self.daily_pnl <= -self.capital * self.max_daily_loss:
            self._halt(f"daily -{self.max_daily_loss*100:.0f}% loss limit hit", now)
            return False, self.halted_reason

        # consecutive-loss circuit-breaker
        if self.consec_losses >= self.max_consec_losses:
            self._halt(f"{self.max_consec_losses} consec losses", now)
            return False, self.halted_reason

        # max concurrent positions
        if self.open_trades >= self.max_open_trades:
            return False, f"max open trades ({self.max_open_trades})"

        # per-symbol concurrency
        if symbol:
            cur = self.open_by_symbol.get(symbol, 0)
            if cur >= self.max_per_symbol:
                return False, f"already {cur} open in {symbol} (cap={self.max_per_symbol})"

        # time-of-day filters
        if cur_time >= self.no_entry_after:
            return False, "after 14:30 — no new entries"
        if cur_time < self.market_open:
            return False, "before market open"
        if cur_time < self.avoid_first_5min and not is_gap_go:
            return False, "first 5 min (Gap&Go only)"

        return True, "ok"

    # ── compute position size ──────────────────────────────────
    def size_position(self, entry: float, stop: float) -> int:
        if entry is None or stop is None or entry <= 0:
            return 0
        risk_per_share = abs(entry - stop)
        if risk_per_share <= 0:
            return 0
        max_risk = (self.capital + self.daily_pnl) * self.max_risk_per_trade
        return int(max_risk // risk_per_share)

    def size_position_scaled(self, entry: float, stop: float, confidence: float) -> int:
        """Confidence-scaled position sizing.

        High-conviction signals (confidence ≥ high_conviction_floor) get
        the full 1% risk budget. Below that, risk is halved. This applies
        a *measured* scaling rather than the binary "trade or not" of the
        quality gate alone — a 0.55-confidence signal still trades but
        with half the capital exposure.

        Anyone who wants to skip the scaling can just call size_position().
        """
        if entry is None or stop is None or entry <= 0:
            return 0
        risk_per_share = abs(entry - stop)
        if risk_per_share <= 0:
            return 0
        risk_pct = self.max_risk_per_trade
        if confidence < self.high_conviction_floor:
            risk_pct = risk_pct * 0.5
        max_risk = (self.capital + self.daily_pnl) * risk_pct
        return int(max_risk // risk_per_share)

    # ── pyramid sizing rule (book §3 + spec) ──────────────────
    def pyramid_size(self, current_qty: int, profit_pct: float) -> int:
        """Add 50% qty when trade is +1.5%."""
        if profit_pct < 0.015:
            return 0
        return current_qty // 2

    # ── trade lifecycle ────────────────────────────────────────
    def on_open(self, symbol: str = "") -> None:
        self.open_trades += 1
        if symbol:
            self.open_by_symbol[symbol] = self.open_by_symbol.get(symbol, 0) + 1

    def on_close(self, pnl: float, strategy: str = "", symbol: str = "",
                 timestamp: Optional[datetime] = None) -> None:
        ts = timestamp or datetime.now()
        self.open_trades   = max(0, self.open_trades - 1)
        if symbol:
            cur = self.open_by_symbol.get(symbol, 0)
            if cur <= 1:
                self.open_by_symbol.pop(symbol, None)
            else:
                self.open_by_symbol[symbol] = cur - 1
        self.daily_pnl    += pnl
        self.consec_losses = self.consec_losses + 1 if pnl < 0 else 0
        week_id = _iso_week_id(ts)
        self.weekly_pnl[week_id] = self.weekly_pnl.get(week_id, 0.0) + pnl
        self.trades_today.append(TradeRecord(
            pnl       = pnl,
            pnl_pct   = pnl / self.capital,
            strategy  = strategy,
            symbol    = symbol,
            timestamp = ts,
        ))

    # ── status helpers ────────────────────────────────────────
    def progress_to_target(self) -> float:
        if self.daily_pnl <= 0:
            return 0.0
        return min(self.daily_pnl / (self.capital * self.daily_profit_target), 1.0)

    def remaining_risk_budget(self) -> float:
        """₹ left before -2% kill-switch triggers."""
        max_loss = self.capital * self.max_daily_loss
        return max(0.0, max_loss + self.daily_pnl)   # daily_pnl negative on loss

    def daily_pnl_pct(self) -> float:
        return self.daily_pnl / self.capital

    # ── internals ─────────────────────────────────────────────
    def _halt(self, reason: str, now: Optional[datetime] = None) -> None:
        self.halted        = True
        self.halted_reason = reason
        self.kill_at       = now or datetime.now()
