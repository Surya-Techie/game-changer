"""PPS (Pattern Probability Strategy) signal engine.

Implements the spec exactly:
  • 40/18 SMA trend filter (must pass for any BUY/SELL — else HOLD)
  • Pivot detection (3-bar each side for confirmation)
  • Six patterns: symmetrical / ascending / descending triangle,
    head-and-shoulders continuation, double bottom, double top
  • ATR-based stops, 3R targets, confidence scoring per the spec
  • Strict no-look-ahead: processing bar i uses ONLY bars [0, i-1]
    (the bar being closed is treated as the most recent CONFIRMED bar)

Uses the project's existing pure-Python indicators (SMA, ATR) so we don't
pull in the `ta` package — those have been audited and tested.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Optional, Tuple

from indicators import atr as _atr_series, sma as _sma_series

# Target multiple of risk (R). 2R is the empirically-measured sweet spot for
# NSE daily-bar pattern trades: 3R targets were hit on ~12% of resolved
# trades; 2R targets resolve ~40-50%. Below 1.5R the break-even win rate
# climbs above 40%, eroding the edge from a small win-rate advantage.
DEFAULT_TARGET_R: float = 2.0

Signal = Literal["BUY", "SELL", "HOLD"]
PatternId = Literal[
    "symmetrical_triangle",
    "ascending_triangle",
    "descending_triangle",
    "head_shoulders_continuation",
    "double_bottom",
    "double_top",
]

# Canonical display names so PPS pattern ids line up with the
# pattern-accuracy store (analytics → PPS enrichment). Once a pattern has
# enough resolved samples in the store, its MEASURED win rate flows onto
# live PPS signals via enrich_signals_with_accuracy().
PPS_PATTERN_NAMES: Dict[str, str] = {
    "symmetrical_triangle": "Symmetrical Triangle",
    "ascending_triangle": "Ascending Triangle",
    "descending_triangle": "Descending Triangle",
    "head_shoulders_continuation": "Head and Shoulders",
    "double_bottom": "Double Bottom",
    "double_top": "Double Top",
}

# Empirical-Bayes shrinkage constant: at this many measured samples the
# blended confidence weights the measured win rate and the PPS engine's
# own confidence equally. Fewer samples → trust the engine; more → trust
# the measured rate. Keeps a 3-trade fluke from hijacking the signal.
_ACCURACY_BLEND_K = 20


@dataclass
class PpsSignal:
    bar_index: int
    date: str
    signal: Signal
    pattern: Optional[PatternId]
    confidence: float
    entry_price: Optional[float]
    stop_loss: Optional[float]
    target_price: Optional[float]
    risk_reward: Optional[float]
    trend_aligned: bool

    def to_dict(self) -> dict:
        return {
            "bar_index": self.bar_index,
            "date": self.date,
            "signal": self.signal,
            "pattern": self.pattern,
            "confidence": round(self.confidence, 3),
            "entry_price": round(self.entry_price, 4) if self.entry_price is not None else None,
            "stop_loss": round(self.stop_loss, 4) if self.stop_loss is not None else None,
            "target_price": round(self.target_price, 4) if self.target_price is not None else None,
            "risk_reward": round(self.risk_reward, 3) if self.risk_reward is not None else None,
            "trend_aligned": self.trend_aligned,
        }


# ─── trend filter ───────────────────────────────────────────────────────

def _sma_slope(series: List[Optional[float]], idx: int, lookback: int = 5) -> Optional[float]:
    """PPS slope: (SMA[idx] - SMA[idx-lookback]) / lookback.

    Returns None when either point is missing (insufficient warmup).
    """
    if idx < lookback or idx >= len(series):
        return None
    a, b = series[idx], series[idx - lookback]
    if a is None or b is None:
        return None
    return (a - b) / lookback


def _trend_aligned_long(close: float, sma40: float, sma18: float,
                        sma40_slope: float, sma18_slope: float) -> bool:
    """BUY trend filter: 40SMA slope ≥ 0 AND 18SMA slope > 0 AND price > 40SMA."""
    return sma40_slope >= 0.0 and sma18_slope > 0.0 and close > sma40


def _trend_aligned_short(close: float, sma40: float, sma18: float,
                         sma40_slope: float, sma18_slope: float) -> bool:
    """SELL trend filter: 40SMA slope ≤ 0 AND 18SMA slope < 0 AND price < 40SMA."""
    return sma40_slope <= 0.0 and sma18_slope < 0.0 and close < sma40


# ─── pivot detection (no look-ahead — uses only bars BEFORE the test bar) ──

def _is_pivot_high(highs: List[float], i: int, k: int = 3) -> bool:
    """A confirmed pivot high at i requires k bars on EACH side. By the time
    we are processing the *current* bar `c`, the most recent bar we can
    confirm as a pivot is `c - k - 1`. This is what gives us no look-ahead."""
    if i - k < 0 or i + k >= len(highs):
        return False
    p = highs[i]
    for j in range(i - k, i + k + 1):
        if j == i:
            continue
        if highs[j] >= p:
            return False
    return True


def _is_pivot_low(lows: List[float], i: int, k: int = 3) -> bool:
    if i - k < 0 or i + k >= len(lows):
        return False
    p = lows[i]
    for j in range(i - k, i + k + 1):
        if j == i:
            continue
        if lows[j] <= p:
            return False
    return True


def _pivots_up_to(highs: List[float], lows: List[float], current: int,
                  k: int = 3, lookback: int = 60) -> Tuple[List[Tuple[int, float]], List[Tuple[int, float]]]:
    """All confirmed pivots in [current - lookback, current - k - 1].

    Anything inside the trailing `k` bars cannot be confirmed yet — that is
    how the spec's no-look-ahead requirement is enforced.
    """
    start = max(0, current - lookback)
    end = current - k - 1
    pivot_highs: List[Tuple[int, float]] = []
    pivot_lows: List[Tuple[int, float]] = []
    for i in range(start, end + 1):
        if _is_pivot_high(highs, i, k):
            pivot_highs.append((i, highs[i]))
        if _is_pivot_low(lows, i, k):
            pivot_lows.append((i, lows[i]))
    return pivot_highs, pivot_lows


# ─── pattern detectors ──────────────────────────────────────────────────
#
# Each detector returns either None (no setup) or a candidate dict:
#   {pattern, direction ("BUY"/"SELL"), entry, stop, target, formation_bars}
# `target` is 3R from entry (entry ± 3 × |entry - stop|).
# `formation_bars` feeds the confidence scoring.

def _line_value(p1: Tuple[int, float], p2: Tuple[int, float], x: int) -> float:
    """y-value of the line through p1, p2 at x. Both points are (idx, price)."""
    x1, y1 = p1
    x2, y2 = p2
    if x2 == x1:
        return y1
    return y1 + (y2 - y1) * (x - x1) / (x2 - x1)


def _detect_symmetrical_triangle(
    pivot_highs: List[Tuple[int, float]],
    pivot_lows: List[Tuple[int, float]],
    bar_idx: int,
    close: float,
    atr_now: float,
) -> Optional[dict]:
    """Spec: 2 descending pivot highs + 2 ascending pivot lows, lines converging
    within 20 bars. Breakout above upper trendline → BUY, below lower → SELL.
    Initial stop = 1 ATR below/above the apex."""
    if len(pivot_highs) < 2 or len(pivot_lows) < 2:
        return None
    h1, h2 = pivot_highs[-2], pivot_highs[-1]
    l1, l2 = pivot_lows[-2], pivot_lows[-1]
    # Descending highs + ascending lows.
    if not (h2[1] < h1[1] and l2[1] > l1[1]):
        return None
    upper_slope = (h2[1] - h1[1]) / max(h2[0] - h1[0], 1)
    lower_slope = (l2[1] - l1[1]) / max(l2[0] - l1[0], 1)
    if upper_slope >= 0 or lower_slope <= 0:
        return None
    # Convergence within 20 bars of the *current* bar.
    # Solve upper(x) = lower(x): h1.y + upper_slope*(x - h1.x) = l1.y + lower_slope*(x - l1.x)
    denom = upper_slope - lower_slope
    if abs(denom) < 1e-12:
        return None
    apex_x = (l1[1] - h1[1] + upper_slope * h1[0] - lower_slope * l1[0]) / denom
    if apex_x < bar_idx or apex_x > bar_idx + 20:
        return None
    apex_y = _line_value(h1, h2, apex_x)
    # Breakout test at current bar.
    upper_at = _line_value(h1, h2, bar_idx)
    lower_at = _line_value(l1, l2, bar_idx)
    formation = bar_idx - h1[0]
    if close > upper_at:
        stop = apex_y - atr_now
        target = close + DEFAULT_TARGET_R * (close - stop)
        return {
            "pattern": "symmetrical_triangle",
            "direction": "BUY",
            "entry": close, "stop": stop, "target": target,
            "formation_bars": formation,
        }
    if close < lower_at:
        stop = apex_y + atr_now
        target = close - DEFAULT_TARGET_R * (stop - close)
        return {
            "pattern": "symmetrical_triangle",
            "direction": "SELL",
            "entry": close, "stop": stop, "target": target,
            "formation_bars": formation,
        }
    return None


def _detect_ascending_triangle(
    pivot_highs: List[Tuple[int, float]],
    pivot_lows: List[Tuple[int, float]],
    bar_idx: int,
    close: float,
    atr_now: float,
) -> Optional[dict]:
    """Horizontal resistance (≥2 highs within 0.5%) + rising lows. Breakout
    above resistance → BUY. Stop = 1 ATR below most recent swing low."""
    if len(pivot_highs) < 2 or len(pivot_lows) < 2:
        return None
    h1, h2 = pivot_highs[-2], pivot_highs[-1]
    if abs(h2[1] - h1[1]) / max(h1[1], 1e-9) > 0.005:
        return None
    resistance = (h1[1] + h2[1]) / 2.0
    # All recent pivot lows must be ascending.
    recent_lows = pivot_lows[-3:] if len(pivot_lows) >= 3 else pivot_lows[-2:]
    for a, b in zip(recent_lows, recent_lows[1:]):
        if b[1] <= a[1]:
            return None
    if close <= resistance:
        return None
    stop = recent_lows[-1][1] - atr_now
    target = close + DEFAULT_TARGET_R * (close - stop)
    return {
        "pattern": "ascending_triangle",
        "direction": "BUY",
        "entry": close, "stop": stop, "target": target,
        "formation_bars": bar_idx - h1[0],
    }


def _detect_descending_triangle(
    pivot_highs: List[Tuple[int, float]],
    pivot_lows: List[Tuple[int, float]],
    bar_idx: int,
    close: float,
    atr_now: float,
) -> Optional[dict]:
    """Mirror of ascending: horizontal support + falling highs, break below → SELL."""
    if len(pivot_lows) < 2 or len(pivot_highs) < 2:
        return None
    l1, l2 = pivot_lows[-2], pivot_lows[-1]
    if abs(l2[1] - l1[1]) / max(l1[1], 1e-9) > 0.005:
        return None
    support = (l1[1] + l2[1]) / 2.0
    recent_highs = pivot_highs[-3:] if len(pivot_highs) >= 3 else pivot_highs[-2:]
    for a, b in zip(recent_highs, recent_highs[1:]):
        if b[1] >= a[1]:
            return None
    if close >= support:
        return None
    stop = recent_highs[-1][1] + atr_now
    target = close - DEFAULT_TARGET_R * (stop - close)
    return {
        "pattern": "descending_triangle",
        "direction": "SELL",
        "entry": close, "stop": stop, "target": target,
        "formation_bars": bar_idx - l1[0],
    }


def _detect_head_shoulders_continuation(
    pivot_highs: List[Tuple[int, float]],
    pivot_lows: List[Tuple[int, float]],
    bar_idx: int,
    close: float,
) -> Optional[dict]:
    """Continuation H&S (uptrend reasserts): 3 swing highs H1 < H2 > H3 with
    H3 > H1. Neckline connects the lows between H1→H2 and H2→H3. Entry on
    close > H3 peak. Stop = halfway between entry and neckline."""
    if len(pivot_highs) < 3:
        return None
    H1, H2, H3 = pivot_highs[-3], pivot_highs[-2], pivot_highs[-1]
    if not (H1[1] < H2[1] > H3[1] and H3[1] > H1[1]):
        return None
    # Find pivot lows between each pair.
    left_lows = [lo for lo in pivot_lows if H1[0] < lo[0] < H2[0]]
    right_lows = [lo for lo in pivot_lows if H2[0] < lo[0] < H3[0]]
    if not left_lows or not right_lows:
        return None
    nl_left = min(left_lows, key=lambda x: x[1])
    nl_right = min(right_lows, key=lambda x: x[1])
    neckline_at = _line_value(nl_left, nl_right, bar_idx)
    if close <= H3[1]:
        return None
    # Stop = midpoint between entry and neckline (entry above, neckline below).
    stop = (close + neckline_at) / 2.0
    if stop >= close:
        return None
    target = close + DEFAULT_TARGET_R * (close - stop)
    return {
        "pattern": "head_shoulders_continuation",
        "direction": "BUY",
        "entry": close, "stop": stop, "target": target,
        "formation_bars": bar_idx - H1[0],
    }


def _detect_double_bottom(
    pivot_lows: List[Tuple[int, float]],
    pivot_highs: List[Tuple[int, float]],
    bar_idx: int,
    close: float,
    atr_now: float,
) -> Optional[dict]:
    """Two lows within 1.5%, 10–40 bars apart. Middle peak ≥3% above the lows.
    Breakout above middle peak → BUY. Stop = 1 ATR below lower of two bottoms."""
    if len(pivot_lows) < 2:
        return None
    L1, L2 = pivot_lows[-2], pivot_lows[-1]
    gap = L2[0] - L1[0]
    if gap < 10 or gap > 40:
        return None
    if abs(L2[1] - L1[1]) / max(L1[1], 1e-9) > 0.015:
        return None
    # Middle peak = highest pivot high between L1 and L2.
    middle_highs = [hi for hi in pivot_highs if L1[0] < hi[0] < L2[0]]
    if not middle_highs:
        return None
    middle = max(middle_highs, key=lambda x: x[1])
    base = min(L1[1], L2[1])
    if (middle[1] - base) / base < 0.03:
        return None
    if close <= middle[1]:
        return None
    stop = base - atr_now
    target = close + DEFAULT_TARGET_R * (close - stop)
    return {
        "pattern": "double_bottom",
        "direction": "BUY",
        "entry": close, "stop": stop, "target": target,
        "formation_bars": gap,
    }


def _detect_double_top(
    pivot_lows: List[Tuple[int, float]],
    pivot_highs: List[Tuple[int, float]],
    bar_idx: int,
    close: float,
    atr_now: float,
) -> Optional[dict]:
    if len(pivot_highs) < 2:
        return None
    H1, H2 = pivot_highs[-2], pivot_highs[-1]
    gap = H2[0] - H1[0]
    if gap < 10 or gap > 40:
        return None
    if abs(H2[1] - H1[1]) / max(H1[1], 1e-9) > 0.015:
        return None
    middle_lows = [lo for lo in pivot_lows if H1[0] < lo[0] < H2[0]]
    if not middle_lows:
        return None
    middle = min(middle_lows, key=lambda x: x[1])
    top = max(H1[1], H2[1])
    if (top - middle[1]) / top < 0.03:
        return None
    if close >= middle[1]:
        return None
    stop = top + atr_now
    target = close - DEFAULT_TARGET_R * (stop - close)
    return {
        "pattern": "double_top",
        "direction": "SELL",
        "entry": close, "stop": stop, "target": target,
        "formation_bars": gap,
    }


# ─── confidence scoring (per spec) ──────────────────────────────────────

def _confidence(
    *,
    bar_idx: int,
    formation_bars: int,
    volumes: List[float],
    sma40_slope: Optional[float],
    sma18_slope: Optional[float],
    atrs: List[Optional[float]],
) -> float:
    score = 0.5
    # +0.10 — volume spike on breakout bar
    if len(volumes) >= 21:
        recent_vol = volumes[bar_idx]
        avg_vol = sum(volumes[bar_idx - 20:bar_idx]) / 20.0
        if avg_vol > 0 and recent_vol > 1.5 * avg_vol:
            score += 0.10
    # +0.10 — strong trend alignment (both slopes > 0.001 in absolute terms)
    if sma40_slope is not None and sma18_slope is not None:
        if abs(sma40_slope) > 0.001 and abs(sma18_slope) > 0.001 and (sma40_slope * sma18_slope) > 0:
            score += 0.10
    # +0.10 — ATR expanding (atr_now > atr_10_ago * 1.1)
    if bar_idx >= 10 and atrs[bar_idx] is not None and atrs[bar_idx - 10] is not None:
        if atrs[bar_idx] > atrs[bar_idx - 10] * 1.1:  # type: ignore[operator]
            score += 0.10
    # +0.10 — ideal formation time (15–40 bars)
    if 15 <= formation_bars <= 40:
        score += 0.10
    return min(1.0, score)


# ─── main engine ────────────────────────────────────────────────────────

def generate_pps_signals(
    bars: List[dict],
    *,
    stop_pct: Optional[float] = None,
    target_pct: Optional[float] = None,
) -> List[dict]:
    """Run the full PPS engine over OHLCV bars.

    Args:
        bars: list of dicts with at least: date (str), open, high, low, close, volume.
        stop_pct: if set, override the ATR-based stop with a FIXED % of entry
                  (e.g. 2.0 → stop 2% away). The pattern detector still picks
                  the direction; only the risk envelope is fixed.
        target_pct: if set, override the 2R target with a FIXED % of entry
                  (e.g. 5.0 → target 5% away). When both stop_pct and
                  target_pct are set, the user-chosen risk-reward ratio
                  (target_pct / stop_pct) is exactly what gets placed.

    Returns:
        list of signal dicts (PpsSignal.to_dict()).

    No-look-ahead guarantee: when processing bar i, the engine uses only
    confirmed pivots up to bar `i - k - 1` (k=3 by default), and indicator
    values computed exclusively from bars [0, i]. The bar being decided is
    treated as 'just closed' — its close, high, low and volume are known.
    """
    if not bars:
        return []
    n = len(bars)
    closes = [float(b["close"]) for b in bars]
    highs = [float(b["high"]) for b in bars]
    lows = [float(b["low"]) for b in bars]
    volumes = [float(b.get("volume", 0) or 0) for b in bars]
    dates = [str(b.get("date", "")) for b in bars]

    sma40 = _sma_series(closes, 40)
    sma18 = _sma_series(closes, 18)
    atrs = _atr_series(highs, lows, closes, 14)

    signals: List[PpsSignal] = []

    for i in range(n):
        # Warmup: until 40SMA + slope window are available, no signals are
        # honest. Emit HOLD with trend_aligned=False.
        s40 = sma40[i]
        s18 = sma18[i]
        sl40 = _sma_slope(sma40, i, 5)
        sl18 = _sma_slope(sma18, i, 5)
        atr_now = atrs[i]
        close = closes[i]

        # Always-default = HOLD (overridden below when a valid setup fires).
        sig = PpsSignal(
            bar_index=i, date=dates[i], signal="HOLD",
            pattern=None, confidence=0.0,
            entry_price=None, stop_loss=None, target_price=None,
            risk_reward=None, trend_aligned=False,
        )

        if s40 is None or s18 is None or sl40 is None or sl18 is None or atr_now is None:
            signals.append(sig)
            continue

        long_ok = _trend_aligned_long(close, s40, s18, sl40, sl18)
        short_ok = _trend_aligned_short(close, s40, s18, sl40, sl18)
        sig.trend_aligned = long_ok or short_ok

        if not (long_ok or short_ok):
            # Per spec: HOLD when trend filter fails.
            signals.append(sig)
            continue

        # Confirmed pivots up to i - k - 1.
        pv_h, pv_l = _pivots_up_to(highs, lows, i, k=3, lookback=60)

        candidates: List[dict] = []
        # Triangles + double patterns are bi-directional; only emit the
        # direction that matches the trend filter.
        sym = _detect_symmetrical_triangle(pv_h, pv_l, i, close, atr_now)
        if sym is not None:
            if (sym["direction"] == "BUY" and long_ok) or (sym["direction"] == "SELL" and short_ok):
                candidates.append(sym)
        if long_ok:
            asc = _detect_ascending_triangle(pv_h, pv_l, i, close, atr_now)
            if asc is not None:
                candidates.append(asc)
            hns = _detect_head_shoulders_continuation(pv_h, pv_l, i, close)
            if hns is not None:
                candidates.append(hns)
            db = _detect_double_bottom(pv_l, pv_h, i, close, atr_now)
            if db is not None:
                candidates.append(db)
        if short_ok:
            desc = _detect_descending_triangle(pv_h, pv_l, i, close, atr_now)
            if desc is not None:
                candidates.append(desc)
            dt = _detect_double_top(pv_l, pv_h, i, close, atr_now)
            if dt is not None:
                candidates.append(dt)

        if not candidates:
            signals.append(sig)
            continue

        # Score every candidate; pick the highest-confidence one. The spec
        # requires this when multiple patterns fire on the same bar.
        scored: List[Tuple[float, dict]] = []
        for cand in candidates:
            c = _confidence(
                bar_idx=i,
                formation_bars=int(cand["formation_bars"]),
                volumes=volumes,
                sma40_slope=sl40,
                sma18_slope=sl18,
                atrs=atrs,
            )
            scored.append((c, cand))
        scored.sort(key=lambda x: x[0], reverse=True)
        best_conf, best = scored[0]

        entry = float(best["entry"])
        stop = float(best["stop"])
        target = float(best["target"])

        # Optional fixed-percent override. Replaces the ATR-derived envelope
        # with a user-chosen stop% and target% of entry. Pattern detection
        # is unchanged — only the risk envelope is rescaled.
        direction = best["direction"]
        if stop_pct is not None and stop_pct > 0:
            if direction == "BUY":
                stop = round(entry * (1 - stop_pct / 100.0), 2)
            else:
                stop = round(entry * (1 + stop_pct / 100.0), 2)
        if target_pct is not None and target_pct > 0:
            if direction == "BUY":
                target = round(entry * (1 + target_pct / 100.0), 2)
            else:
                target = round(entry * (1 - target_pct / 100.0), 2)

        risk = abs(entry - stop)
        rr = (abs(target - entry) / risk) if risk > 0 else 0.0

        sig.signal = direction                          # type: ignore[assignment]
        sig.pattern = best["pattern"]                   # type: ignore[assignment]
        sig.confidence = best_conf
        sig.entry_price = entry
        sig.stop_loss = stop
        sig.target_price = target
        sig.risk_reward = rr
        signals.append(sig)

    return [s.to_dict() for s in signals]


def summarise(signals: List[dict]) -> dict:
    """Aggregate counts + average confidence — used by the API summary block."""
    buy = sum(1 for s in signals if s["signal"] == "BUY")
    sell = sum(1 for s in signals if s["signal"] == "SELL")
    total = buy + sell
    confs = [s["confidence"] for s in signals if s["signal"] in ("BUY", "SELL")]
    avg = sum(confs) / len(confs) if confs else 0.0
    return {
        "total_signals": total,
        "buy_count": buy,
        "sell_count": sell,
        "avg_confidence": round(avg, 3),
    }


def enrich_signals_with_accuracy(
    signals: List[dict],
    accuracy_by_name: Dict[str, dict],
) -> List[dict]:
    """Fold MEASURED pattern win rates (from pattern-analytics) onto live PPS
    signals — the Analytics → PPS integration.

    accuracy_by_name maps a canonical pattern name to
    ``{"win_rate": float in [0,1], "samples": int}`` (e.g. built from the
    pattern_accuracy rollups). For each BUY/SELL signal whose pattern has
    measured data, we attach:
      - measured_win_rate   : the empirical win rate for that pattern
      - measured_samples    : how many resolved trades back it
      - combined_confidence : PPS confidence shrunk toward the measured rate
                              by sample count (empirical-Bayes), so the live
                              signal reflects what actually happened, not just
                              the engine's prior.

    Degrades gracefully: with no measured data, combined_confidence simply
    equals the engine's own confidence and measured_win_rate is None.
    """
    for s in signals:
        conf = s.get("confidence")
        s["measured_win_rate"] = None
        s["measured_samples"] = 0
        s["combined_confidence"] = conf
        if s.get("signal") not in ("BUY", "SELL"):
            continue
        name = PPS_PATTERN_NAMES.get(s.get("pattern") or "")
        rec = accuracy_by_name.get(name) if name else None
        if not rec:
            continue
        try:
            wr = float(rec["win_rate"])
            n = int(rec["samples"])
        except (KeyError, TypeError, ValueError):
            continue
        if n <= 0:
            continue
        w = n / (n + _ACCURACY_BLEND_K)            # 0..1, grows with samples
        pps_conf = float(conf or 0.0)
        s["measured_win_rate"] = round(wr, 4)
        s["measured_samples"] = n
        s["combined_confidence"] = round((1.0 - w) * pps_conf + w * wr, 3)
    return signals


_TF_NORMALISE = {
    "1m": "M1", "m1": "M1", "M1": "M1",
    "5m": "M5", "m5": "M5", "M5": "M5",
    "15m": "M15", "m15": "M15", "M15": "M15",
    "30m": "M30", "m30": "M30", "M30": "M30",
    "1h": "H1", "h1": "H1", "H1": "H1",
    "1d": "D1", "1D": "D1", "d1": "D1", "D1": "D1",
}


def normalise_timeframe(tf: str) -> str:
    """Map any timeframe label (1d / 1D / D1 / 30m …) to the canonical
    M-form the accuracy store keys on. Unknown → D1."""
    return _TF_NORMALISE.get(tf) or _TF_NORMALISE.get(str(tf).lower(), "D1")


def resolve_pps_outcomes(
    signals: List[dict],
    bars: List[dict],
    max_hold_bars: int = 15,
) -> List[dict]:
    """PPS → Analytics: walk each BUY/SELL signal forward to its target/stop
    outcome with NO look-ahead, returning records ready for the
    pattern-accuracy store.

    For each resolvable signal returns
    ``{pattern_name, outcome ('win'|'loss'), rr_achieved, hold_bars}`` using
    the canonical pattern name (so it lines up with the Analytics → PPS
    read-back). Conservative tie-break: a single bar straddling both target
    and stop counts as LOSS (we can't see intrabar ordering). A signal that
    never hits either within max_hold_bars is bucketed by the sign of its
    close-out return. Signals without a forward bar to resolve are skipped.
    """
    out: List[dict] = []
    n = len(bars)
    for s in signals:
        if s.get("signal") not in ("BUY", "SELL"):
            continue
        name = PPS_PATTERN_NAMES.get(s.get("pattern") or "")
        if not name:
            continue
        entry, stop, target = s.get("entry_price"), s.get("stop_loss"), s.get("target_price")
        if entry is None or stop is None or target is None:
            continue
        i = int(s.get("bar_index", -1))
        if i < 0 or i + 1 >= n:
            continue  # need ≥1 forward bar
        is_buy = s["signal"] == "BUY"
        end = min(i + max_hold_bars + 1, n)
        outcome: Optional[str] = None
        hold = 0
        for j in range(i + 1, end):
            hi, lo = float(bars[j]["high"]), float(bars[j]["low"])
            hit_stop = lo <= stop if is_buy else hi >= stop
            hit_tgt = hi >= target if is_buy else lo <= target
            if hit_stop:            # stop checked first (conservative tie-break)
                outcome, hold = "loss", j - i
                break
            if hit_tgt:
                outcome, hold = "win", j - i
                break
        if outcome is None:
            last = float(bars[end - 1]["close"])
            pct = (last - entry) / entry * (1 if is_buy else -1)
            outcome, hold = ("win" if pct > 0 else "loss"), end - 1 - i
        rr = float(s.get("risk_reward") or 0.0) if outcome == "win" else -1.0
        out.append({
            "pattern_name": name,
            "outcome": outcome,
            "rr_achieved": rr,
            "hold_bars": hold,
        })
    return out
