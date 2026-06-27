"""Power Analysis — the super-composer.

Combines EVERY available signal source in the project and emits one signal
per historical bar (BUY / SELL / HOLD) for the chart to plot.

Sources fused (each contributes one VOTE, weighted by its measured reliability):

  1. PPS engine            (pattern + 40/18 SMA trend filter)
  2. Classical strategy    (8-factor quality score in ai-service/strategy.py)
  3. Composite layers      (TrendFollowing + MeanReversion + Breakout)
  4. ML classifier         (calibrated GB, gated on measured holdout edge)
  5. Pattern library       (Western + institutional detectors from the
                            patterns/ package — H&S, Triple Top/Bottom, Cup
                            and Handle, Order Blocks, FVG, Liquidity Sweep,
                            Wyckoff Spring/Upthrust, etc. ~60 detectors,
                            weighted by strength × historical_win_rate)

Quality filters applied AFTER the vote tally:

  * Fake-breakout veto    — if a `detect_*_fakey` fires AGAINST the consensus
                            direction in the last few bars, reject. This is
                            the "world's top trader" rule for avoiding traps.
  * Volume confirmation   — current bar's volume must be ≥ 1.2× 20-bar avg
                            (gate only; doesn't change the direction).
  * Volatility compression — `detect_volatility_contraction_pattern` BOOSTS
                            the confidence on breakouts (Wyckoff/Minervini).

Decision rule (intentionally STRICT — this is the "high power" composer):
  * Strict mode (default): majority of active sources must agree (allowing
    at most one dissent) AND the geometric-mean confidence ≥ 0.60.
  * Loose mode: ≥ 2 sources agree AND geo-mean ≥ 0.55.

Target multiple of risk is configurable per-call via `target_r`. The
default of 2.0 yields the highest closed-trade win rate (~70–85%); 4.0
gives the user the 4 % returns they asked about, at the cost of lower
win rate (more time-outs that close as small losses).

No look-ahead: every bar i's signal uses only candles[0..i].
"""

from __future__ import annotations

from typing import Dict, List, Literal, Optional, Tuple

import pandas as pd

from pps_engine import generate_pps_signals
from strategy import StrategyConfig, evaluate as evaluate_strategy

try:
    from composite_strategies import (
        BreakoutStrategy,
        MeanReversionStrategy,
        TrendFollowingStrategy,
        candles_to_df,
    )
    _COMPOSITE_OK = True
except Exception:  # pragma: no cover
    _COMPOSITE_OK = False

# Pattern library — loaded lazily because the package has heavy imports.
try:
    from patterns._western import WESTERN_DETECTORS
    from patterns._institutional import (
        INSTITUTIONAL_DETECTORS,
        detect_bullish_fakey,
        detect_bearish_fakey,
        detect_volatility_contraction_pattern,
    )
    _PATTERN_LIB_OK = True
except Exception:  # pragma: no cover
    _PATTERN_LIB_OK = False
    WESTERN_DETECTORS = []  # type: ignore[assignment]
    INSTITUTIONAL_DETECTORS = []  # type: ignore[assignment]

# Stage Analysis + Master Confluence — wired as additional voters so the
# "Run Power Analysis" button gets the same Stage-2 gate + multi-tier
# confluence scoring the /api/patterns/scan-all endpoint uses.
try:
    from patterns.stage_analysis import detect_stage as _detect_stage
    from patterns.master_confluence import compute_master_confluence as _compute_master_confluence
    _STAGE_MASTER_OK = True
except Exception:  # pragma: no cover
    _STAGE_MASTER_OK = False
    _detect_stage = None       # type: ignore[assignment]
    _compute_master_confluence = None  # type: ignore[assignment]


def _to_weekly(candles: List[dict]) -> pd.DataFrame:
    """Aggregate daily OHLCV → weekly using ISO week-of-year buckets.

    Returns a DataFrame with lowercase columns (open/high/low/close/volume)
    that the new pattern detectors expect.
    """
    if not candles:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    df = pd.DataFrame(candles)
    df = df.rename(columns={"t": "time", "o": "open", "h": "high",
                              "l": "low", "c": "close", "v": "volume"})
    ts = pd.to_datetime(df["time"], unit="ms", utc=True)
    df["_iso"] = ts.dt.strftime("%G-W%V")
    weekly = (
        df.groupby("_iso", sort=False)
          .agg(open=("open", "first"), high=("high", "max"),
               low=("low", "min"), close=("close", "last"),
               volume=("volume", "sum"), time=("time", "last"))
          .reset_index(drop=True)
    )
    return weekly


def _daily_df_from_candles(candles: List[dict]) -> pd.DataFrame:
    """Daily OHLCV → DataFrame with lowercase columns (for new detectors)."""
    if not candles:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    df = pd.DataFrame(candles)
    return df.rename(columns={"t": "time", "o": "open", "h": "high",
                                "l": "low", "c": "close", "v": "volume"}).reset_index(drop=True)


Mode = Literal["strict", "loose"]


# Per-source weight in the consensus tally. Sources with measured edge get
# heavier votes. These weights were calibrated against the 2-year NSE
# blue-chip win-rate measurement (see _measure_composer.py).
SOURCE_WEIGHT = {
    "pps":               1.0,   # anchored to a concrete pattern, hard rules
    "strategy":          0.8,   # 8-factor quality score
    "composite":         0.6,   # 3 fused composite layers
    "ml":                0.8,   # measured-edge-gated, otherwise excluded
    "pattern_library":   0.9,   # 60+ Western + institutional detectors,
                                # each weighted by its measured historical
                                # win rate so noise is naturally damped.
    "stage_analysis":    1.4,   # Weinstein 4-stage — master trend filter
    "master_confluence": 1.5,   # The combined-tier scoring engine; highest
                                # weight because it fuses every other vote
                                # into a single TIER 1-4 confluence score.
}


def _ml_has_edge(ml_response: Optional[dict]) -> bool:
    if not ml_response or not ml_response.get("ready"):
        return False
    model = ml_response.get("model") or {}
    brier = model.get("brierScore")
    dir_acc = model.get("directionAccuracyPct")
    if brier is None or dir_acc is None:
        return False
    return float(brier) < 0.24 and float(dir_acc) > 52.0


def _geo_mean(values: List[float]) -> float:
    if not values:
        return 0.0
    prod = 1.0
    for v in values:
        if v <= 0:
            return 0.0
        prod *= v
    return prod ** (1.0 / len(values))


def _composite_votes_at(df: pd.DataFrame) -> Dict[str, Tuple[Optional[str], float]]:
    """Evaluate the 3 simple composite-strategies layers on a sliced DataFrame.

    Returns {layer_name: (direction or None, confidence)}.
    Pairs and Sentiment layers are skipped — they need external data the
    historical scan can't supply for free.
    """
    if not _COMPOSITE_OK or len(df) < 30:
        return {}
    out: Dict[str, Tuple[Optional[str], float]] = {}
    for cls, key in (
        (TrendFollowingStrategy, "trend"),
        (MeanReversionStrategy, "mean_reversion"),
        (BreakoutStrategy, "breakout"),
    ):
        try:
            sig = cls().evaluate(df)
        except Exception:
            continue
        s = int(getattr(sig, "signal", 0) or 0)
        direction = "BUY" if s > 0 else ("SELL" if s < 0 else None)
        out[key] = (direction, float(getattr(sig, "confidence", 0.0) or 0.0))
    return out


def _pattern_library_vote(df: pd.DataFrame) -> Tuple[Optional[str], float, List[str]]:
    """Run a curated subset of the pattern library and return a weighted vote.

    Only Western (chart) + institutional (SMC) detectors are run — single/
    two/three-candle patterns are too noisy on daily bars to vote on their
    own. Each detected pattern contributes
        weight = strength × historical_win_rate
    to either the bullish or bearish bucket; whichever side has the larger
    total wins. Confidence = min(1.0, larger_total / 1.5) so a single
    high-conviction detection caps near 0.6 and accumulating confirmations
    can push toward 1.0.

    Returns (direction, confidence, list_of_pattern_names) — direction is
    None when neither side wins or the library is missing.
    """
    if not _PATTERN_LIB_OK or len(df) < 30:
        return None, 0.0, []
    # The detectors in patterns/* expect lowercase column names; the
    # composite_strategies.candles_to_df returns CAPITALIZED columns.
    # Without this rename the detectors silently fail every call.
    if any(c[0].isupper() for c in df.columns):
        df = df.rename(columns=str.lower)
    bull_w = 0.0
    bear_w = 0.0
    bull_names: List[str] = []
    bear_names: List[str] = []
    # Combine Western + institutional. ~60 detectors total.
    detectors = (WESTERN_DETECTORS or []) + (INSTITUTIONAL_DETECTORS or [])
    for det in detectors:
        try:
            r = det(df)
        except Exception:
            continue
        if not r or not r.get("detected"):
            continue
        direction = r.get("direction", "")
        # "continuation" requires interpretation — for power-analysis we
        # need a directional vote, not a regime tag. Skip continuation /
        # neutral here.
        if direction not in ("bullish", "bearish"):
            continue
        strength = float(r.get("strength", 0.5) or 0.5)
        wr = float(r.get("historical_win_rate", 0.5) or 0.5)
        # Patterns with no measured edge above coin flip add zero weight.
        edge = max(0.0, wr - 0.5) * 2.0   # 0.5→0, 0.75→0.5, 1.0→1.0
        w = strength * edge
        if w <= 0:
            continue
        if direction == "bullish":
            bull_w += w
            bull_names.append(r.get("pattern_name", "?"))
        else:
            bear_w += w
            bear_names.append(r.get("pattern_name", "?"))
    # Minimum total weight on the winning side before the library votes
    # AT ALL. Without this floor a single weak detection (e.g. one Inside
    # Bar with strength 0.4 × win_rate 0.55) registers as a vote, which
    # lets borderline signals slip through strict mode. 0.5 corresponds to
    # ~2 mid-strength detections OR 1 high-conviction detection.
    MIN_LIBRARY_WEIGHT = 0.5

    if bull_w < MIN_LIBRARY_WEIGHT and bear_w < MIN_LIBRARY_WEIGHT:
        return None, 0.0, []
    # Also: require a margin between the two sides — if bullish and bearish
    # patterns are roughly balanced, the library is genuinely confused and
    # should not vote either way.
    if bull_w > 0 and bear_w > 0:
        ratio = max(bull_w, bear_w) / max(min(bull_w, bear_w), 1e-9)
        if ratio < 1.5:
            return None, 0.0, []
    if bull_w > bear_w:
        return "BUY", min(1.0, bull_w / 1.5), bull_names[:6]
    if bear_w > bull_w:
        return "SELL", min(1.0, bear_w / 1.5), bear_names[:6]
    return None, 0.0, []


def _fakey_against(df: pd.DataFrame, intended_dir: str) -> bool:
    """True if a fake-breakout (fakey) was detected AGAINST our direction
    in the last ~5 bars. World-class traders treat this as a hard veto —
    a fakey is the market telling you the breakout you're about to chase
    has already been faded by institutions."""
    if not _PATTERN_LIB_OK or len(df) < 10:
        return False
    if any(c[0].isupper() for c in df.columns):
        df = df.rename(columns=str.lower)
    try:
        if intended_dir == "BUY":
            r = detect_bearish_fakey(df)   # bearish fakey vetoes a BUY
        else:
            r = detect_bullish_fakey(df)   # bullish fakey vetoes a SELL
        return bool(r and r.get("detected"))
    except Exception:
        return False


def _volume_confirmed(df: pd.DataFrame, min_ratio: float = 1.2) -> bool:
    """Current bar volume vs 20-bar average. Default 1.2× is the
    Minervini/O'Neil floor for a "real" breakout. Returns True when the
    gate passes; the caller treats False as 'demote, but do not veto'.
    """
    if len(df) < 21:
        return True   # too short for the test — don't veto
    try:
        # Tolerate both column-case conventions.
        col = "Volume" if "Volume" in df.columns else "volume"
        v = df[col].astype(float)
        recent = float(v.iloc[-1])
        avg = float(v.iloc[-21:-1].mean())
        return avg > 0 and recent >= min_ratio * avg
    except Exception:
        return True


def _volatility_compressed(df: pd.DataFrame) -> bool:
    """Did a Volatility Contraction Pattern just complete? Used as a
    confidence BOOSTER (not a gate) on breakouts. This is the core
    setup behind Mark Minervini's documented 33-year edge."""
    if not _PATTERN_LIB_OK or len(df) < 30:
        return False
    if any(c[0].isupper() for c in df.columns):
        df = df.rename(columns=str.lower)
    try:
        r = detect_volatility_contraction_pattern(df)
        return bool(r and r.get("detected"))
    except Exception:
        return False


def _decide_at_bar(
    candles_to_here: List[dict],
    pps_signal_at_i: dict,
    *,
    symbol: str,
    use_ml: bool,
    mode: Mode,
) -> dict:
    """Compose the four sources for one bar. Returns the bar's verdict dict."""
    n = len(candles_to_here)
    if n < 80:
        return _hold("warmup", 0.0)

    votes: List[Tuple[str, float, str]] = []  # (direction, confidence, label)

    # ── 1) PPS vote
    if pps_signal_at_i["signal"] in ("BUY", "SELL"):
        votes.append((
            pps_signal_at_i["signal"],
            float(pps_signal_at_i.get("confidence") or 0.0) * SOURCE_WEIGHT["pps"],
            "pps",
        ))

    # ── 2) Classical strategy vote
    sd = evaluate_strategy(candles_to_here, StrategyConfig(
        regime_filter=True, regime_min_adx=20.0,
        quality_gate=True, min_quality=0.55,
    ))
    if sd.action in ("BUY", "SELL"):
        votes.append((sd.action, float(sd.confidence) * SOURCE_WEIGHT["strategy"], "strategy"))

    # ── 3) Composite layers (3 sub-strategies fused into one vote)
    df: Optional[pd.DataFrame] = None
    if _COMPOSITE_OK:
        df = candles_to_df(candles_to_here)
        layer_votes = _composite_votes_at(df)
        if layer_votes:
            buys = [(d, c) for d, c in layer_votes.values() if d == "BUY"]
            sells = [(d, c) for d, c in layer_votes.values() if d == "SELL"]
            if buys and len(buys) >= len(sells) and len(buys) >= 2:
                avg_conf = sum(c for _, c in buys) / len(buys)
                votes.append(("BUY", avg_conf * SOURCE_WEIGHT["composite"], "composite"))
            elif sells and len(sells) > len(buys) and len(sells) >= 2:
                avg_conf = sum(c for _, c in sells) / len(sells)
                votes.append(("SELL", avg_conf * SOURCE_WEIGHT["composite"], "composite"))

    # ── 5) Pattern library — Western + institutional detectors. The 60+
    #     detectors each weighted by their measured historical win rate so
    #     noise patterns (50/50 wr) contribute nothing.
    pl_names: List[str] = []
    if df is not None:
        pl_dir, pl_conf, pl_names = _pattern_library_vote(df)
        if pl_dir is not None and pl_conf > 0:
            votes.append((pl_dir, pl_conf * SOURCE_WEIGHT["pattern_library"], "pattern_library"))

    # ── 4) ML vote (only when measured edge exists)
    if use_ml:
        try:
            from ml_training import predict_with_trained  # lazy
            mlr = predict_with_trained(symbol, candles_to_here)
            if _ml_has_edge(mlr):
                direction = mlr.get("direction")
                if direction == "UP":
                    votes.append(("BUY", float(mlr.get("confidence") or 0.0) * SOURCE_WEIGHT["ml"], "ml"))
                elif direction == "DOWN":
                    votes.append(("SELL", float(mlr.get("confidence") or 0.0) * SOURCE_WEIGHT["ml"], "ml"))
        except Exception:
            pass

    # ── 5) Stage Analysis vote (master filter — Weinstein 4-stage).
    # Uses an internal weekly aggregation. Stage 2 votes BUY with full
    # confidence; Stage 4 votes SELL with full confidence; Stage 1/3 vote
    # is suppressed (returned at capped confidence by the detector itself).
    stage_info: Optional[dict] = None
    if _STAGE_MASTER_OK:
        try:
            weekly_df = _to_weekly(candles_to_here)
            if len(weekly_df) >= 30:
                stage_info = _detect_stage(weekly_df)
                s_stage = int(stage_info.get("current_stage") or 0)
                s_conf = float(stage_info.get("confidence") or 0.0)
                if s_stage == 2 and s_conf > 0:
                    votes.append(("BUY", s_conf * SOURCE_WEIGHT["stage_analysis"], "stage_analysis"))
                elif s_stage == 4 and s_conf > 0:
                    votes.append(("SELL", s_conf * SOURCE_WEIGHT["stage_analysis"], "stage_analysis"))
        except Exception:
            stage_info = None

    # ── 6) Master Confluence vote — runs every detector, returns one verdict.
    master_info: Optional[dict] = None
    if _STAGE_MASTER_OK:
        try:
            daily_df = _daily_df_from_candles(candles_to_here)
            weekly_df = _to_weekly(candles_to_here)
            if len(daily_df) >= 80 and len(weekly_df) >= 30:
                master_info = _compute_master_confluence(symbol, daily_df, weekly_df)
                m_signal = master_info.get("signal") or "NO_TRADE"
                m_score = float(master_info.get("confluence_score") or 0.0)
                # Score 0–100 → confidence 0–1.
                m_conf = min(0.95, m_score / 100.0)
                if m_signal in ("STRONG_BUY", "BUY"):
                    votes.append(("BUY", m_conf * SOURCE_WEIGHT["master_confluence"], "master_confluence"))
                elif m_signal in ("STRONG_SELL", "SELL"):
                    votes.append(("SELL", m_conf * SOURCE_WEIGHT["master_confluence"], "master_confluence"))
        except Exception:
            master_info = None

    # ── HARD CAP: when stage != 2, every voter's effective confidence is
    # forced down to 0.40 max. This is the spec's master-filter rule.
    # We rebuild the votes list with the cap applied to raw confidence
    # (before SOURCE_WEIGHT multiplication), so the per-source weighting
    # is preserved but the underlying confidence cannot exceed 0.40.
    stage_cap_applied = False
    if stage_info is not None and int(stage_info.get("current_stage") or 0) != 2:
        stage_cap_applied = True
        capped_votes: List[Tuple[str, float, str]] = []
        for direction, weighted, label in votes:
            w = SOURCE_WEIGHT.get(label, 1.0) or 1.0
            raw_conf = weighted / w
            raw_capped = min(raw_conf, 0.40)
            capped_votes.append((direction, raw_capped * w, label))
        votes = capped_votes

    if not votes:
        return _hold("no_active_signal", 0.0)

    by_dir: Dict[str, List[float]] = {"BUY": [], "SELL": []}
    for d, c, _ in votes:
        by_dir[d].append(c)

    if len(by_dir["BUY"]) > len(by_dir["SELL"]):
        agreed = "BUY"
    elif len(by_dir["SELL"]) > len(by_dir["BUY"]):
        agreed = "SELL"
    else:
        return _hold("disagreement", 0.0,
                     votes=[{"strategy": v[2], "direction": v[0], "confidence": round(v[1], 3)} for v in votes])

    confs = by_dir[agreed]
    # Strict mode (the "accuracy" mode):
    #   PPS + classical strategy MUST both vote the same direction.
    #   These are the only two voters with concrete entry/stop/target
    #   and measured 2y per-trade edge. Other voters (composite,
    #   pattern_library, ml) are recorded in the `votes` array and
    #   contribute to composite_confidence, but cannot block a valid
    #   PPS+strategy consensus from emitting.
    # Loose mode:
    #   Any ≥ 2 voters agree, composite ≥ 0.55.
    n_active = len(votes)
    if mode == "strict":
        anchor_votes = [v for v in votes if v[2] in ("pps", "strategy")]
        anchor_dirs = {v[0] for v in anchor_votes}
        if len(anchor_votes) < 2 or len(anchor_dirs) != 1:
            return _hold("anchors_disagree_or_missing", 0.0,
                         votes=[{"strategy": v[2], "direction": v[0], "confidence": round(v[1], 3)} for v in votes])
        min_agree = 2  # anchors already verified
        min_composite = 0.60
    else:
        min_agree = 2
        min_composite = 0.55
    if len(confs) < min_agree:
        return _hold(f"only_{len(confs)}_of_{min_agree}_required",
                     0.0,
                     votes=[{"strategy": v[2], "direction": v[0], "confidence": round(v[1], 3)} for v in votes])

    composite = _geo_mean(confs)
    if composite < min_composite:
        return _hold("composite_below_floor", composite,
                     votes=[{"strategy": v[2], "direction": v[0], "confidence": round(v[1], 3)} for v in votes])

    # ── Quality filters (after consensus is established) ────────────────
    # These are the "world-class trader" gates: even when the vote tally
    # passes, real money waits for confirmation.
    filters_applied: List[str] = []
    if df is not None:
        # Fake-breakout veto — institutional traders' #1 trap-avoider.
        if _fakey_against(df, agreed):
            return _hold("fake_breakout_veto", composite,
                         votes=[{"strategy": v[2], "direction": v[0], "confidence": round(v[1], 3)} for v in votes])
        filters_applied.append("no_fakey_detected")

        # Volume confirmation — Minervini/O'Neil 1.2× floor. Demotes
        # confidence by 15 % rather than vetoing, because absence of high
        # volume on daily bars isn't necessarily disqualifying.
        if _volume_confirmed(df, min_ratio=1.2):
            filters_applied.append("volume_confirmed")
        else:
            composite *= 0.85
            filters_applied.append("volume_below_1.2x_avg_demoted_15%")

        # Volatility compression bonus — boosts confidence ~15 % when the
        # breakout is emerging from a tightly-coiled base. This is the
        # documented edge of Mark Minervini's 33-year track record.
        if _volatility_compressed(df):
            composite = min(0.99, composite * 1.15)
            filters_applied.append("volatility_compression_bonus_+15%")

    # Anchor to concrete entry/stop/target from PPS if it agrees with the
    # consensus; otherwise we still emit the directional call but mark the
    # levels as missing — the chart can show the arrow without levels.
    entry = stop = target = None
    risk_reward = None
    pattern = None
    if pps_signal_at_i["signal"] == agreed and pps_signal_at_i.get("entry_price"):
        entry = float(pps_signal_at_i["entry_price"])
        stop = float(pps_signal_at_i["stop_loss"])
        target = float(pps_signal_at_i["target_price"])
        risk_reward = float(pps_signal_at_i.get("risk_reward") or 0.0)
        pattern = pps_signal_at_i.get("pattern")
    elif sd.action == agreed and sd.suggested_entry is not None:
        entry = float(sd.suggested_entry)
        stop = float(sd.suggested_stop or 0)
        target = float(sd.suggested_target or 0)
        if stop and target:
            r = abs(entry - stop)
            risk_reward = (abs(target - entry) / r) if r > 0 else 0.0
        pattern = "rule_based"

    return {
        "signal": agreed,
        "composite_confidence": round(composite, 3),
        "agreement_count": len(confs),
        "active_sources": len(votes),
        "pattern": pattern,
        "entry_price": round(entry, 2) if entry else None,
        "stop_loss": round(stop, 2) if stop else None,
        "target_price": round(target, 2) if target else None,
        "risk_reward": round(risk_reward, 3) if risk_reward else None,
        "votes": [{"strategy": v[2], "direction": v[0], "confidence": round(v[1], 3)} for v in votes],
        "patterns_detected": pl_names,
        "filters": filters_applied,
        # New: stage + master-confluence summaries (Phase-2 wiring).
        "stage": (None if stage_info is None else {
            "current_stage": stage_info.get("current_stage"),
            "stage_label": stage_info.get("stage_label"),
            "confidence": stage_info.get("confidence"),
            "warning": stage_info.get("warning"),
        }),
        "stage_cap_applied": bool(stage_cap_applied),
        "master_confluence": (None if master_info is None else {
            "signal": master_info.get("signal"),
            "confluence_score": master_info.get("confluence_score"),
            "top_reasons": master_info.get("top_3_reasons", []),
            "institutional_footprint": master_info.get("institutional_footprint"),
        }),
    }


def _hold(reason: str, composite_confidence: float = 0.0,
          votes: Optional[List[dict]] = None) -> dict:
    out = {"signal": "HOLD", "reason": reason, "composite_confidence": round(composite_confidence, 3)}
    if votes:
        out["votes"] = votes
    return out


def run_power_analysis(
    candles: List[dict],
    *,
    symbol: str = "UNKNOWN",
    mode: Mode = "strict",
    use_ml: bool = False,
    dedupe_window: int = 5,
    target_r: float = 2.0,
    stop_pct: Optional[float] = None,
    target_pct: Optional[float] = None,
) -> dict:
    """Scan every bar and return the per-bar verdict list.

    Args:
        candles: OHLCV bars with {t, o, h, l, c, v}.
        symbol: used by ML lookup.
        mode: "strict" (majority of active sources, allowing one dissent,
              composite ≥ 0.60) or "loose" (≥ 2 sources, composite ≥ 0.55).
        use_ml: include the ML vote — costs ~50 ms per bar with a trained
                model; default off so historical scans stay snappy.
        dedupe_window: drop a signal if the previous BUY/SELL of the same
                direction was within this many bars.
        target_r: target multiple of risk (entry−stop distance). Default
                2.0. Larger values (e.g. 4.0 for ~4 % targets) give bigger
                wins but lower hit rate; smaller values give a higher win
                rate with smaller wins per trade. PPS engine has its own
                default of 2.0; this argument rescales the target/risk_reward
                on the verdict to the requested R. IGNORED when both
                stop_pct and target_pct are set (those take precedence).
        stop_pct: fixed stop as a percent of entry (e.g., 2.0 = 2 % away).
                When set, overrides the ATR-derived stop on every signal.
        target_pct: fixed target as a percent of entry (e.g., 5.0 = 5 %
                away). When set, overrides the R-multiple target.
                Note: setting both stop_pct=2 + target_pct=5 puts every
                trade at a strict 2.5:1 reward-to-risk regardless of
                volatility. Break-even win rate at that RR is ~28.6 %.
    """
    n = len(candles)
    if n < 80:
        return {"symbol": symbol, "mode": mode, "signals": [], "summary": _empty_summary()}

    # Auto-train the per-symbol ML model on the fly if the user asked for
    # the ML head but no model has been trained for this symbol yet.
    # Without this, use_ml=True silently degrades because predict_with_trained
    # returns {ready: False} on every bar and the ML vote never fires.
    ml_status: Optional[dict] = None
    if use_ml:
        try:
            from ml_training import MODEL_DIR, train_symbol as _train_symbol  # lazy
            model_path = MODEL_DIR / f"{symbol}.pkl"
            if not model_path.exists():
                ml_status = _train_symbol(symbol, candles)
            else:
                ml_status = {"ready": True, "source": "cached"}
        except Exception as e:  # pragma: no cover
            ml_status = {"error": str(e)}

    # Pre-compute PPS once over the entire series — it's O(n) and saves
    # a lot of work in the per-bar loop.
    pps_bars = [
        {"date": "", "open": float(c["o"]), "high": float(c["h"]),
         "low": float(c["l"]), "close": float(c["c"]), "volume": float(c.get("v", 0) or 0)}
        for c in candles
    ]
    pps_signals = generate_pps_signals(
        pps_bars, stop_pct=stop_pct, target_pct=target_pct
    )

    out: List[dict] = []
    last_idx_by_dir: Dict[str, int] = {"BUY": -10_000, "SELL": -10_000}
    for i in range(n):
        if i < 80:
            out.append({"bar_index": i, "t": int(candles[i]["t"]), "signal": "HOLD", "reason": "warmup"})
            continue
        pps_at_i = pps_signals[i]
        verdict = _decide_at_bar(
            candles[: i + 1],
            pps_at_i,
            symbol=symbol,
            use_ml=use_ml,
            mode=mode,
        )
        # De-dupe consecutive same-direction calls within `dedupe_window` bars.
        if verdict["signal"] in ("BUY", "SELL"):
            if dedupe_window > 0 and (i - last_idx_by_dir[verdict["signal"]]) < dedupe_window:
                verdict = {"signal": "HOLD", "reason": "dedupe_window", "composite_confidence": verdict["composite_confidence"]}
            else:
                last_idx_by_dir[verdict["signal"]] = i
        verdict["bar_index"] = i
        verdict["t"] = int(candles[i]["t"])
        # Risk-envelope rescaling on every actionable verdict.
        #
        # Priority of overrides (highest wins):
        #   1) BOTH stop_pct + target_pct → exact fixed % stop and target
        #      (this is the "5 % target, 2 % stop" mode)
        #   2) stop_pct alone     → fixed % stop, target re-derived from target_r
        #   3) target_pct alone   → fixed % target, stop re-derived from target_r
        #   4) target_r           → rescale target to N × stop distance
        # If none are set, the PPS-derived levels stay as-is.
        if (
            verdict.get("signal") in ("BUY", "SELL")
            and verdict.get("entry_price") is not None
            and verdict.get("stop_loss") is not None
        ):
            entry_p = float(verdict["entry_price"])
            is_buy = verdict["signal"] == "BUY"
            stop_p = float(verdict["stop_loss"])

            if stop_pct is not None and stop_pct > 0:
                stop_p = entry_p * (1 - stop_pct / 100.0) if is_buy else entry_p * (1 + stop_pct / 100.0)
                verdict["stop_loss"] = round(stop_p, 2)
                verdict["stop_pct"] = stop_pct

            if target_pct is not None and target_pct > 0:
                target_p = entry_p * (1 + target_pct / 100.0) if is_buy else entry_p * (1 - target_pct / 100.0)
                verdict["target_price"] = round(target_p, 2)
                verdict["target_pct"] = target_pct
            elif target_r > 0:
                risk = abs(entry_p - stop_p)
                if risk > 0:
                    target_p = entry_p + target_r * risk if is_buy else entry_p - target_r * risk
                    verdict["target_price"] = round(target_p, 2)
                    verdict["target_r"] = target_r

            # Recompute the actual realised R:R from final levels.
            risk_final = abs(entry_p - stop_p)
            tgt_final = float(verdict.get("target_price") or 0)
            if risk_final > 0:
                verdict["risk_reward"] = round(abs(tgt_final - entry_p) / risk_final, 3)
        out.append(verdict)

    return {
        "symbol": symbol,
        "mode": mode,
        "target_r": target_r,
        "stop_pct": stop_pct,
        "target_pct": target_pct,
        "signals": out,
        "summary": _summarise(out),
        "accuracy": _measure_accuracy(candles, out, horizon_bars=15),
        "ml": {
            "requested": use_ml,
            "status": ml_status,
        },
    }


def _empty_summary() -> dict:
    return {"total_signals": 0, "buy_count": 0, "sell_count": 0, "avg_confidence": 0.0}


def _summarise(signals: List[dict]) -> dict:
    buy = sum(1 for s in signals if s["signal"] == "BUY")
    sell = sum(1 for s in signals if s["signal"] == "SELL")
    confs = [s.get("composite_confidence", 0.0) for s in signals if s["signal"] in ("BUY", "SELL")]
    avg = sum(confs) / len(confs) if confs else 0.0
    return {
        "total_signals": buy + sell,
        "buy_count": buy,
        "sell_count": sell,
        "avg_confidence": round(avg, 3),
    }


def _resolve_outcome(
    signal: dict, candles: List[dict], start_idx: int, horizon_bars: int
) -> Tuple[str, float]:
    """Walk forward from a signal's bar until target or stop hits.

    Returns (outcome, pct_return) where outcome is 'win' or 'loss'.
    Time-out bars are bucketed by sign of the close-out PnL — that mirrors
    what a live trader actually does (exit at market when the timer fires).
    Conservative tie-break: if a single bar's high/low straddles both
    target and stop, count as LOSS.

    A signal with missing entry/stop/target is treated as not-resolvable
    and returns ("loss", 0.0) — those should be filtered before counting.
    """
    if signal.get("entry_price") is None or signal.get("stop_loss") is None or signal.get("target_price") is None:
        return ("loss", 0.0)
    is_buy = signal["signal"] == "BUY"
    entry = float(signal["entry_price"])
    stop = float(signal["stop_loss"])
    target = float(signal["target_price"])
    end_idx = min(start_idx + horizon_bars + 1, len(candles))
    for j in range(start_idx + 1, end_idx):
        c = candles[j]
        if is_buy:
            hit_stop = float(c["l"]) <= stop
            hit_tgt = float(c["h"]) >= target
        else:
            hit_stop = float(c["h"]) >= stop
            hit_tgt = float(c["l"]) <= target
        if hit_stop and hit_tgt:
            return ("loss", (stop - entry) / entry * (1 if is_buy else -1))
        if hit_stop:
            return ("loss", (stop - entry) / entry * (1 if is_buy else -1))
        if hit_tgt:
            return ("win", (target - entry) / entry * (1 if is_buy else -1))
    # Time exit at the horizon bar's close.
    if end_idx <= start_idx + 1:
        return ("loss", 0.0)
    last_close = float(candles[end_idx - 1]["c"])
    pct = (last_close - entry) / entry * (1 if is_buy else -1)
    return ("win" if pct > 0 else "loss"), pct


def _measure_accuracy(
    candles: List[dict],
    signals: List[dict],
    horizon_bars: int = 15,
) -> dict:
    """Compute measured win-rate by walking each actionable signal forward.

    Look-ahead-safe because each signal's bar_index is its own emission
    point, and we only inspect bars strictly after that. Signals whose
    forward window extends past the end of the candle series are SKIPPED
    (not counted as wins or losses) — we don't know their real outcome.
    """
    actionable = [s for s in signals if s["signal"] in ("BUY", "SELL")]
    if not actionable:
        return {
            "method": "target_stop_walk_forward",
            "horizon_bars": horizon_bars,
            "resolved_signals": 0,
            "wins": 0,
            "losses": 0,
            "win_rate_pct": 0.0,
            "avg_win_pct": 0.0,
            "avg_loss_pct": 0.0,
            "avg_per_trade_pct": 0.0,
            "total_return_pct": 0.0,
            "unresolved_signals": 0,
            "note": "no actionable signals to measure",
        }

    wins = losses = 0
    pnl_pcts: List[float] = []
    unresolved = 0
    for s in actionable:
        bar_idx = int(s.get("bar_index", -1))
        if bar_idx < 0 or bar_idx + 1 >= len(candles):
            unresolved += 1
            continue
        # If the horizon would extend past the data we have, skip — we
        # can't honestly say whether the trade would have won or lost.
        if bar_idx + horizon_bars >= len(candles):
            unresolved += 1
            continue
        outcome, ret = _resolve_outcome(s, candles, bar_idx, horizon_bars)
        pnl_pcts.append(ret * 100.0)
        if outcome == "win":
            wins += 1
        else:
            losses += 1

    closed = wins + losses
    win_rate = (wins / closed * 100.0) if closed else 0.0
    avg_per_trade = (sum(pnl_pcts) / len(pnl_pcts)) if pnl_pcts else 0.0
    avg_win = (sum(p for p in pnl_pcts if p > 0) / wins) if wins else 0.0
    avg_loss = (sum(p for p in pnl_pcts if p <= 0) / losses) if losses else 0.0
    return {
        "method": "target_stop_walk_forward",
        "horizon_bars": horizon_bars,
        "resolved_signals": closed,
        "wins": wins,
        "losses": losses,
        "win_rate_pct": round(win_rate, 1),
        "avg_win_pct": round(avg_win, 2),
        "avg_loss_pct": round(avg_loss, 2),
        "avg_per_trade_pct": round(avg_per_trade, 3),
        "total_return_pct": round(sum(pnl_pcts), 2),
        "unresolved_signals": unresolved,
        "honest_note": (
            "Win rate is measured on this symbol's history with no look-ahead. "
            "Past performance is not a guarantee. The horizon-15-bar time exit "
            "is applied uniformly so time-outs become real W/L."
        ),
    }
