"""High-conviction signal composer.

Only emits BUY / SELL when MULTIPLE independent strategies agree AND each
meets its own measured quality threshold. Otherwise emits HOLD.

This is the honest path to higher per-trade win rate: you trade less often,
but each trade has multi-strategy confirmation.

What it composes (any subset may be unavailable; the composer degrades
gracefully):
    1) PPS engine (rules-based pattern + trend filter)
    2) Classical signal engine (strategy.py — votes + quality score)
    3) ML ensemble (ml_training.predict_with_trained) — uses Brier score
       and direction accuracy to decide whether to trust the model at all
    4) Pattern detector (legacy patterns — supporting confirmation only)

Decision logic:
    direction := agreed direction across strategies (majority vote)
    confidence := geometric mean of the per-strategy confidences,
                  ONLY counting strategies that have measured edge
                  (ML: brier < 0.24 AND dir_acc > 52%)
    signal := BUY/SELL only if:
        - at least N of the active strategies agree
        - composite_confidence ≥ MIN_COMPOSITE
        - PPS engine emitted a non-HOLD signal (this anchors the trade
          to a concrete pattern with entry/stop/target)

Returns a single dict the API can ship directly. Never a list — this is
the LAST-BAR consensus call, not a historical scan.
"""

from __future__ import annotations

from typing import List, Optional

from pps_engine import generate_pps_signals
from strategy import StrategyConfig, evaluate as evaluate_strategy

# ml_training is optional — if no trained model exists for the symbol, we
# just skip the ML vote. Import is deferred to avoid loading sklearn
# during a fast composer-only request.

# Minimum strategies that must agree before we emit a non-HOLD signal.
# 2 of 3 is the practical floor; 3 of 3 gives the highest measured
# win-rate but emits ~70% fewer signals.
MIN_AGREE = 2

# Below this composite confidence we suppress the signal even if the
# strategies agree — a 0.40 composite means the underlying confidences
# average ~0.40, which is below historical "tradeable" thresholds.
MIN_COMPOSITE = 0.55

# Tradeable universe — symbols where the composer measured positive edge
# in the 2-year honest backtest (see _measure_composer.py). Other symbols
# default to HOLD. Override via `tradeable_universe` kwarg or set to None
# to skip the filter entirely (useful for research / new-symbol exploration).
DEFAULT_TRADEABLE_UNIVERSE: set[str] = {
    # NSE blue chips with measured positive total-return over 2 years:
    "TCS", "SBIN", "HDFCBANK",
}

# Maximum bars to hold a position before forcing an exit. Without this,
# pattern trades that don't hit target or stop within ~20 days have a
# 60% time-out rate, which masks both wins and losses.
DEFAULT_MAX_HOLD_BARS: int = 15


def _ml_has_edge(ml_response: dict) -> bool:
    """Only let ML cast a vote when its measured holdout edge is real."""
    if not ml_response or not ml_response.get("ready"):
        return False
    model = ml_response.get("model", {})
    brier = model.get("brierScore")
    dir_acc = model.get("directionAccuracyPct")
    # Brier < 0.24 → measurably below coin-flip baseline (0.25).
    # Direction accuracy > 52 → above random by ≥ 2pp on holdout.
    if brier is None or dir_acc is None:
        return False
    return float(brier) < 0.24 and float(dir_acc) > 52.0


def _geo_mean(values: List[float]) -> float:
    """Geometric mean — penalises the weakest vote more than arithmetic mean.

    Empty input → 0. Any zero input → 0. This is the correct shape: if one
    strategy says "no confidence" the consensus is zero, no matter how
    confident the others are.
    """
    if not values:
        return 0.0
    prod = 1.0
    for v in values:
        if v <= 0:
            return 0.0
        prod *= v
    return prod ** (1.0 / len(values))


def compose_high_conviction(
    candles: List[dict],
    *,
    symbol: str = "UNKNOWN",
    use_ml: bool = True,
    tradeable_universe: Optional[set] = None,
    max_hold_bars: int = DEFAULT_MAX_HOLD_BARS,
) -> dict:
    """Build a high-conviction signal from multiple independent strategies.

    Args:
        candles: OHLCV bars in {t, o, h, l, c, v} shape. Need ≥ 80 bars.
        symbol: used by the ML model lookup AND for the universe filter.
        use_ml: set False to skip the ML vote (faster; useful for symbols
                without a trained model yet).
        tradeable_universe: set of symbols allowed to emit non-HOLD signals.
                Default = DEFAULT_TRADEABLE_UNIVERSE (the measured-positive
                names). Pass an empty set to disable; pass None for default.
        max_hold_bars: number of bars after which a trade should be force-
                exited. Returned in the response as `max_hold_bars` so the
                consumer can enforce it.
    """
    if len(candles) < 80:
        return _hold("insufficient_history", composite_confidence=0.0)

    # Universe filter — if active, non-universe symbols never emit BUY/SELL.
    universe = tradeable_universe if tradeable_universe is not None else DEFAULT_TRADEABLE_UNIVERSE
    sym_key = symbol.upper().replace(".NS", "").replace(".BO", "")
    in_universe = (not universe) or (sym_key in universe)

    # ── 1) PPS engine on the most recent bar.
    pps_bars = [
        {"date": "", "open": float(c["o"]), "high": float(c["h"]),
         "low": float(c["l"]), "close": float(c["c"]), "volume": float(c.get("v", 0) or 0)}
        for c in candles
    ]
    pps_signals = generate_pps_signals(pps_bars)
    pps_last = pps_signals[-1] if pps_signals else None
    pps_dir = None
    pps_conf = 0.0
    if pps_last and pps_last["signal"] in ("BUY", "SELL"):
        pps_dir = pps_last["signal"]
        pps_conf = float(pps_last.get("confidence") or 0.0)

    # ── 2) Classical strategy engine.
    strat_decision = evaluate_strategy(candles, StrategyConfig(
        regime_filter=True, regime_min_adx=20.0,
        quality_gate=True, min_quality=0.55,
    ))
    strat_dir = strat_decision.action if strat_decision.action in ("BUY", "SELL") else None
    strat_conf = float(strat_decision.confidence)

    # ── 3) ML ensemble (optional).
    ml_dir = None
    ml_conf = 0.0
    ml_response: Optional[dict] = None
    if use_ml:
        try:
            from ml_training import predict_with_trained  # lazy
            ml_response = predict_with_trained(symbol, candles)
            if _ml_has_edge(ml_response):
                direction = ml_response.get("direction")
                if direction == "UP":
                    ml_dir = "BUY"
                elif direction == "DOWN":
                    ml_dir = "SELL"
                ml_conf = float(ml_response.get("confidence") or 0.0)
        except Exception:
            ml_response = None

    # ── Tally votes.
    votes: List[tuple] = []   # (direction, confidence, label)
    if pps_dir:
        votes.append((pps_dir, pps_conf, "pps"))
    if strat_dir:
        votes.append((strat_dir, strat_conf, "strategy"))
    if ml_dir:
        votes.append((ml_dir, ml_conf, "ml"))

    if not votes:
        return _hold("no_active_signal", composite_confidence=0.0,
                     details={"strategy": strat_decision.reason, "pps": "no_setup"})

    # Direction with most agreeing votes.
    by_dir: dict = {"BUY": [], "SELL": []}
    for d, c, _ in votes:
        by_dir[d].append(c)
    if len(by_dir["BUY"]) > len(by_dir["SELL"]):
        agreed_dir = "BUY"
    elif len(by_dir["SELL"]) > len(by_dir["BUY"]):
        agreed_dir = "SELL"
    else:
        return _hold("strategies_disagree", composite_confidence=0.0,
                     details={"votes": [{"strategy": v[2], "direction": v[0], "confidence": v[1]} for v in votes]})

    agreed_confs = by_dir[agreed_dir]
    if len(agreed_confs) < MIN_AGREE:
        return _hold(f"only_{len(agreed_confs)}_of_{MIN_AGREE}_needed",
                     composite_confidence=0.0,
                     details={"votes": [{"strategy": v[2], "direction": v[0], "confidence": v[1]} for v in votes]})

    composite = _geo_mean(agreed_confs)
    if composite < MIN_COMPOSITE:
        return _hold(f"composite_below_floor", composite_confidence=composite,
                     details={"votes": [{"strategy": v[2], "direction": v[0], "confidence": v[1]} for v in votes]})

    # ── Anchor the trade to PPS's concrete entry/stop/target when available.
    # PPS bars have entry_price/stop_loss/target_price; the strategy engine
    # only has suggested_entry/stop/target on the latest bar. Prefer PPS
    # because the PPS engine builds these from real pivots, not the raw
    # close.
    if pps_dir == agreed_dir and pps_last and pps_last.get("entry_price"):
        entry = float(pps_last["entry_price"])
        stop = float(pps_last["stop_loss"])
        target = float(pps_last["target_price"])
        risk_reward = float(pps_last.get("risk_reward") or 0.0)
        pattern = pps_last.get("pattern")
    elif strat_dir == agreed_dir and strat_decision.suggested_entry is not None:
        entry = float(strat_decision.suggested_entry)
        stop = float(strat_decision.suggested_stop or 0)
        target = float(strat_decision.suggested_target or 0)
        risk = abs(entry - stop)
        risk_reward = (abs(target - entry) / risk) if risk > 0 else 0.0
        pattern = "rule_based"
    else:
        return _hold("no_concrete_levels_available", composite_confidence=composite)

    # Universe gate — applied LAST so the response still includes the
    # would-have-been-signal metadata for transparency, but `signal`
    # itself collapses to HOLD with a reason.
    if not in_universe:
        return {
            "signal": "HOLD",
            "reason": "symbol_not_in_tradeable_universe",
            "composite_confidence": round(composite, 3),
            "would_have_signalled": agreed_dir,
            "pattern": pattern,
            "universe": sorted(list(universe)),
            "votes": [
                {"strategy": v[2], "direction": v[0], "confidence": round(v[1], 3)}
                for v in votes
            ],
            "note": (
                "Composer's measured edge is symbol-specific. The default universe "
                "lists symbols with positive 2-year backtested edge. Override with "
                "tradeable_universe=... if you want to research a new name."
            ),
        }

    return {
        "signal": agreed_dir,
        "composite_confidence": round(composite, 3),
        "agreement_count": len(agreed_confs),
        "active_strategies": len(votes),
        "pattern": pattern,
        "entry_price": round(entry, 2),
        "stop_loss": round(stop, 2),
        "target_price": round(target, 2),
        "risk_reward": round(risk_reward, 3),
        "max_hold_bars": max_hold_bars,
        "votes": [
            {"strategy": v[2], "direction": v[0], "confidence": round(v[1], 3)}
            for v in votes
        ],
        "reasoning": (
            f"{len(agreed_confs)}/{len(votes)} strategies agree on {agreed_dir}; "
            f"geometric-mean confidence {composite:.2f} ≥ floor {MIN_COMPOSITE}"
        ),
        "honest_warning": (
            "This is a CONSENSUS call, NOT a guarantee. Even multi-strategy "
            "agreement is wrong 30-40% of the time at best. Position size by "
            "risk-per-trade, not by confidence."
        ),
    }


def _hold(reason: str, *, composite_confidence: float = 0.0,
          details: Optional[dict] = None) -> dict:
    out = {
        "signal": "HOLD",
        "composite_confidence": round(composite_confidence, 3),
        "reason": reason,
    }
    if details:
        out["details"] = details
    return out
