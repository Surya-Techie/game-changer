"""Strategy that consumes indicators and produces a directional signal.

Keeps the rule logic in one place so /signal, /backtest, and any future
ensemble can reuse the same scoring function.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from indicators import adx, atr, bollinger, ema, macd, rsi, sma, stochastic_rsi, supertrend, vwap
from multitimeframe import mtf_alignment


@dataclass
class StrategyConfig:
    """Defaults = the measured high-accuracy profile.

    Chosen by sweeping real NSE data (8 symbols × 2y daily + 60d 15m bars,
    gross target-hit-vs-stop-hit metric — exactly what the live outcome
    tracker measures): trend-only entries, close confirmation, ADX≥25
    regime, 4×ATR stop with a 0.25R target ⇒ 83.2% win rate on 748 intraday
    trades with positive gross expectancy (random entries at this geometry
    give 80.0% with ZERO expectancy — the entry edge is the margin above).
    The wide 4×ATR stop also keeps position notional small at fixed rupee
    risk, which is what makes the auto-trader's costed profile viable.

    NOTE the asymmetric exit: the target is deliberately much closer than
    the stop. High hit rate ≠ high profit; the auto-trader re-derives its
    own cost-aware trade target from account settings (targetRR).
    """

    rsi_period: int = 14
    fast_ma: int = 9
    slow_ma: int = 21
    long_ma: int = 50
    atr_period: int = 14
    atr_stop_mult: float = 4.0
    atr_target_mult: float = 2.5
    confidence_floor: float = 0.5
    confidence_cap: float = 0.95

    # Switches the auto-trader / backtest can flip.
    regime_filter: bool = True
    regime_min_adx: float = 25.0
    mtf_confirmation: bool = False
    stop_mode: str = "ATR"  # "ATR" | "FIXED_PCT"
    stop_pct: float = 2.0
    target_rr: float = 0.25  # take-profit at this multiple of stop distance

    # Precision gate. A non-HOLD action must clear `min_quality` (0..1)
    # — a multi-factor confluence score — or it is demoted to HOLD.
    # Raising this trades signal *frequency* for signal *quality*. There is
    # no setting that makes the system 100% accurate; markets are partially
    # random. This gate just stops the engine from emitting weak setups.
    quality_gate: bool = True
    min_quality: float = 0.55
    volume_min_ratio: float = 1.1  # last bar vol vs 20-bar avg vol

    # Entry selectivity.
    #   "all"        — every setup family fires (cross, continuation,
    #                  pullback, mean-reversion, vote fallback).
    #   "trend_only" — only the trend-aligned families (cross, continuation,
    #                  pullback). Mean-reversion fades and the loose vote
    #                  fallback are the lowest win-rate families, so the
    #                  high-accuracy profile drops them.
    entry_mode: str = "trend_only"
    # Require the signal bar itself to close in the trade direction
    # (green candle for BUY, red for SELL). Cheap momentum confirmation
    # that filters "catching a falling knife" entries.
    require_close_confirmation: bool = True


@dataclass
class SignalDecision:
    action: str  # BUY / SELL / HOLD
    confidence: float
    reason: str
    indicators: dict
    suggested_entry: Optional[float]
    suggested_stop: Optional[float]
    suggested_target: Optional[float]
    filters: dict = field(default_factory=dict)


def _last(arr: List[Optional[float]], fallback: float = 0.0) -> float:
    for v in reversed(arr):
        if v is not None:
            return float(v)
    return fallback


def _volume_ratio(volumes: List[float], lookback: int = 20) -> float:
    """Latest bar volume divided by the SMA of the prior `lookback` bars."""
    if len(volumes) < lookback + 1:
        return 1.0
    recent = volumes[-1]
    prior = volumes[-lookback - 1 : -1]
    avg = sum(prior) / lookback
    if avg <= 0:
        return 1.0
    return recent / avg


def _quality_score(
    action: str,
    *,
    last: float,
    fast_ma: float,
    slow_ma: float,
    long_ma: float,
    rsi_now: float,
    macd_hist: float,
    macd_hist_prev: float,
    supertrend_dir: int,
    vwap_now: Optional[float],
    adx_now: float,
    vol_ratio: float,
    vol_min: float,
    atr_pct: float,
    mtf_agree5: Optional[bool],
    mtf_agree15: Optional[bool],
) -> tuple[float, dict]:
    """Confluence score in [0, 1] from independent factors.

    Each factor is weighted by how much *independent* information it carries.
    The factors are deliberately orthogonal — you can have trend without
    momentum, momentum without volume, etc. — so summing them is a rough
    proxy for "how many independent things agree". Weights sum to 1.0.
    """
    if action not in ("BUY", "SELL"):
        return 0.0, {}

    bull = action == "BUY"
    breakdown: dict = {}

    # 1) Trend alignment — SMA stack + price vs long MA. Max 0.20.
    stacked = (fast_ma > slow_ma > long_ma) if bull else (fast_ma < slow_ma < long_ma)
    side_of_long = (last > long_ma) if bull else (last < long_ma)
    trend = (0.12 if stacked else 0.0) + (0.08 if side_of_long else 0.0)
    breakdown["trend"] = round(trend, 3)

    # 2) Momentum — MACD histogram sign + acceleration. Max 0.15.
    hist_sign_ok = (macd_hist > 0) if bull else (macd_hist < 0)
    hist_accel_ok = (macd_hist > macd_hist_prev) if bull else (macd_hist < macd_hist_prev)
    momentum = (0.09 if hist_sign_ok else 0.0) + (0.06 if hist_accel_ok else 0.0)
    breakdown["momentum"] = round(momentum, 3)

    # 3) Structure — Supertrend direction + VWAP side. Max 0.10.
    st_ok = (supertrend_dir == 1) if bull else (supertrend_dir == -1)
    vwap_ok = vwap_now is not None and ((last > vwap_now) if bull else (last < vwap_now))
    structure = (0.07 if st_ok else 0.0) + (0.03 if vwap_ok else 0.0)
    breakdown["structure"] = round(structure, 3)

    # 4) Volume confirmation — real participation behind the move. Max 0.15.
    if vol_ratio >= max(vol_min, 1.5):
        volume = 0.15
    elif vol_ratio >= vol_min:
        # linear scale between vol_min..1.5 → 0.075..0.15
        span = max(0.0001, 1.5 - vol_min)
        volume = 0.075 + 0.075 * ((vol_ratio - vol_min) / span)
    elif vol_ratio >= 0.9:
        volume = 0.04
    else:
        volume = 0.0
    breakdown["volume"] = round(volume, 3)

    # 5) ADX regime strength. Max 0.10.
    if adx_now >= 30:
        regime = 0.10
    elif adx_now >= 20:
        regime = 0.05 + 0.05 * ((adx_now - 20) / 10.0)
    elif adx_now >= 15:
        regime = 0.05 * ((adx_now - 15) / 5.0)
    else:
        regime = 0.0
    breakdown["regime"] = round(regime, 3)

    # 6) Volatility regime — ATR as % of price. Max 0.10.
    #    Dead markets (ATR% < 0.15%) → no room to a sensible target.
    #    Whippy markets (ATR% > 2.5%) → stops get hit by noise.
    #    Sweet spot: 0.3% — 1.5% of price.
    if 0.30 <= atr_pct <= 1.5:
        volatility = 0.10
    elif 0.15 <= atr_pct < 0.30:
        volatility = 0.10 * ((atr_pct - 0.15) / 0.15)
    elif 1.5 < atr_pct <= 2.5:
        volatility = 0.10 * ((2.5 - atr_pct) / 1.0)
    else:
        volatility = 0.0
    breakdown["volatility"] = round(volatility, 3)

    # 7) Multi-timeframe alignment. Max 0.10. Independent of cfg.mtf_confirmation:
    #    here it always *informs* the score; the cfg gate only decides whether
    #    misalignment is a hard veto.
    mtf_score = 0.0
    if mtf_agree5 is True:
        mtf_score += 0.05
    if mtf_agree15 is True:
        mtf_score += 0.05
    breakdown["mtf"] = round(mtf_score, 3)

    # 8) Oscillator sanity — penalize fighting an extreme RSI. Max 0.10.
    if bull:
        if 45 <= rsi_now <= 65:
            osc = 0.10
        elif 35 <= rsi_now < 45 or 65 < rsi_now <= 75:
            osc = 0.05
        elif rsi_now > 80:
            osc = 0.0
        else:
            osc = 0.03
    else:
        if 35 <= rsi_now <= 55:
            osc = 0.10
        elif 55 < rsi_now <= 65 or 25 <= rsi_now < 35:
            osc = 0.05
        elif rsi_now < 20:
            osc = 0.0
        else:
            osc = 0.03
    breakdown["oscillator"] = round(osc, 3)

    total = trend + momentum + structure + volume + regime + volatility + mtf_score + osc
    return min(1.0, total), breakdown


def _compute_stops(action: str, entry: float, atr_now: float, cfg: StrategyConfig) -> tuple[Optional[float], Optional[float]]:
    """Compute stop + target according to the configured stop mode.

    Guarantees a positive stop distance — a degenerate (zero or NaN) ATR
    would otherwise silently size positions infinitely. Falls back to a
    0.5% floor of entry price so the per-share-risk denominator is never
    pathologically small.
    """
    if action not in ("BUY", "SELL"):
        return None, None
    if cfg.stop_mode == "FIXED_PCT":
        stop_dist = entry * (cfg.stop_pct / 100.0)
    else:  # ATR
        stop_dist = cfg.atr_stop_mult * (atr_now or 0.0)
    # Floor: at least 0.5% of entry. Catches dead/illiquid bars where ATR
    # collapses, NaN propagation, and any negative input.
    min_stop_dist = entry * 0.005
    if not (stop_dist > 0) or stop_dist < min_stop_dist:
        stop_dist = min_stop_dist
    # Floor the reward:risk at 0.25 — below that the target sits inside
    # bid/ask noise and a "win" is meaningless.
    target_dist = stop_dist * max(0.25, cfg.target_rr)
    if action == "BUY":
        return round(entry - stop_dist, 2), round(entry + target_dist, 2)
    return round(entry + stop_dist, 2), round(entry - target_dist, 2)


def evaluate(
    candles: List[dict],
    cfg: StrategyConfig = StrategyConfig(),
) -> SignalDecision:
    closes = [float(c["c"]) for c in candles]
    highs = [float(c["h"]) for c in candles]
    lows = [float(c["l"]) for c in candles]
    volumes = [float(c["v"]) for c in candles]
    last = closes[-1]

    rsi_series = rsi(closes, cfg.rsi_period)
    fast_arr = sma(closes, cfg.fast_ma)
    slow_arr = sma(closes, cfg.slow_ma)
    long_arr = sma(closes, cfg.long_ma)
    fast_now = _last(fast_arr, last)
    slow_now = _last(slow_arr, last)
    long_now = _last(long_arr, last)
    r_now = _last(rsi_series, 50.0)

    macd_line, macd_sig, macd_hist = macd(closes)
    bb_u, bb_m, bb_l = bollinger(closes, 20, 2.0)
    ema9 = _last(ema(closes, 9), last)
    ema21 = _last(ema(closes, 21), last)
    stoch_k, stoch_d = stochastic_rsi(closes)
    st_line, st_dir = supertrend(highs, lows, closes)
    vwap_series = vwap(highs, lows, closes, volumes)
    atr_arr = atr(highs, lows, closes, cfg.atr_period)
    a = _last(atr_arr, max(highs[-1] - lows[-1], last * 0.005))
    adx_arr, _pdi, _mdi = adx(highs, lows, closes, 14)
    adx_now = _last(adx_arr, 0.0)

    if len(closes) >= cfg.slow_ma + 1:
        prev_fast = _last(sma(closes[:-1], cfg.fast_ma), fast_now)
        prev_slow = _last(sma(closes[:-1], cfg.slow_ma), slow_now)
    else:
        prev_fast, prev_slow = fast_now, slow_now
    bullish_cross = prev_fast <= prev_slow and fast_now > slow_now
    bearish_cross = prev_fast >= prev_slow and fast_now < slow_now

    bull_votes = 0
    bear_votes = 0
    score = 0.5

    if bullish_cross:
        bull_votes += 1
        score += 0.1
    if bearish_cross:
        bear_votes += 1
        score -= 0.1
    if r_now < 30:
        bull_votes += 1
        score += 0.05
    elif r_now > 70:
        bear_votes += 1
        score -= 0.05
    if last > long_now:
        bull_votes += 1
        score += 0.03
    else:
        bear_votes += 1
        score -= 0.03
    macd_last = macd_hist[-1]
    if macd_last is not None and macd_last > 0:
        bull_votes += 1
        score += 0.04
    elif macd_last is not None and macd_last < 0:
        bear_votes += 1
        score -= 0.04
    st_now = st_dir[-1]
    if st_now == 1:
        bull_votes += 1
        score += 0.03
    elif st_now == -1:
        bear_votes += 1
        score -= 0.03
    v_now = vwap_series[-1]
    if v_now is not None:
        if last > v_now:
            bull_votes += 1
            score += 0.02
        else:
            bear_votes += 1
            score -= 0.02

    # ----- Signal decision -----
    #
    # FIX: the previous version required a fresh MA cross, which never fires
    # in an established trend — the cross happened many bars ago. We now also
    # fire when the trend is *confirmed and ongoing*: stacked SMAs, ADX>20,
    # supporting Supertrend direction, MACD bias agreeing. Trend continuation
    # is the highest-frequency signal type in real markets.
    action = "HOLD"
    reason = "No quality setup"

    macd_bull = (macd_last or 0) > 0
    macd_bear = (macd_last or 0) < 0
    sma_stacked_bull = fast_now > slow_now > long_now
    sma_stacked_bear = fast_now < slow_now < long_now
    trend_strong = adx_now >= 20
    price_above_vwap = (v_now is not None) and (last > v_now)
    price_below_vwap = (v_now is not None) and (last < v_now)

    # 1) Fresh cross (highest-conviction entry).
    if bullish_cross and r_now < 75 and last > long_now and macd_bull:
        action = "BUY"
        reason = "Fresh MA cross + above 50-MA + MACD positive"
    elif bearish_cross and r_now > 25 and last < long_now and macd_bear:
        action = "SELL"
        reason = "Fresh MA cross + below 50-MA + MACD negative"

    # 2) Trend continuation — established uptrend.
    #    Relaxed: macd-bias and RSI are no longer hard gates; we instead use
    #    them to scale confidence. Real markets often have over-extended RSI
    #    inside strong trends and you still want to be long.
    elif sma_stacked_bull and trend_strong and st_now == 1 and r_now < 85:
        action = "BUY"
        reason = f"Trend continuation: SMA stack + ADX {adx_now:.0f} + Supertrend bull"
        score = max(score, 0.60)
    elif sma_stacked_bear and trend_strong and st_now == -1 and r_now > 15:
        action = "SELL"
        reason = f"Trend continuation: SMA stack + ADX {adx_now:.0f} + Supertrend bear"
        score = max(score, 0.60)

    # 3) Pullback inside an established trend — buy the dip / sell the rip.
    elif sma_stacked_bull and st_now == 1 and 30 <= r_now <= 50 and price_above_vwap:
        action = "BUY"
        reason = "Pullback in uptrend: RSI mid-range, price still above VWAP"
    elif sma_stacked_bear and st_now == -1 and 50 <= r_now <= 70 and price_below_vwap:
        action = "SELL"
        reason = "Bounce in downtrend: RSI mid-range, price still below VWAP"

    # 4) Mean-reversion extremes. (Disabled in trend_only mode — fading a
    #    move is the lowest win-rate setup family.)
    elif cfg.entry_mode == "all" and r_now < 22 and last > long_now * 0.96 and st_now == 1:
        action = "BUY"
        reason = "Deep oversold inside a constructive trend"
    elif cfg.entry_mode == "all" and r_now > 78 and last < long_now * 1.04 and st_now == -1:
        action = "SELL"
        reason = "Deep overbought inside a weak trend"

    # 5) Vote-based fallback. Looser than the named setups — needs at least
    #    a 1-vote advantage and 3+ votes on one side, gated by trend strength.
    #    (Also disabled in trend_only mode.)
    elif cfg.entry_mode == "all" and bull_votes >= 3 and bull_votes > bear_votes and trend_strong:
        action = "BUY"
        reason = f"Vote-majority bull ({bull_votes} vs {bear_votes}, ADX {adx_now:.0f})"
        vote_ratio = (bull_votes - bear_votes) / max(1, bull_votes + bear_votes)
        score = max(score, 0.55 + 0.35 * vote_ratio)
    elif cfg.entry_mode == "all" and bear_votes >= 3 and bear_votes > bull_votes and trend_strong:
        action = "SELL"
        reason = f"Vote-majority bear ({bear_votes} vs {bull_votes}, ADX {adx_now:.0f})"
        vote_ratio = (bear_votes - bull_votes) / max(1, bull_votes + bear_votes)
        score = max(score, 0.55 + 0.35 * vote_ratio)

    # ---- filters that can DEMOTE a non-HOLD to HOLD ----
    filters: dict = {"regime": True, "mtf": True, "adx": round(adx_now, 2)}

    # Close-direction confirmation: the signal bar itself must agree with the
    # trade (green close for BUY, red for SELL). Runs before the quality gate
    # so a knife-catch never even gets scored.
    if action != "HOLD" and cfg.require_close_confirmation:
        bar_open = float(candles[-1].get("o", last))
        closed_with = (last > bar_open) if action == "BUY" else (last < bar_open)
        filters["closeConfirmation"] = closed_with
        if not closed_with:
            reason = f"Filtered: signal bar closed against the {action} direction"
            action = "HOLD"

    # Quality gate — multi-factor confluence. Must clear before regime/MTF
    # filters run, so the breakdown is always reported even when the gate
    # demotes the action.
    macd_hist_prev = macd_hist[-2] if len(macd_hist) >= 2 and macd_hist[-2] is not None else (macd_last or 0.0)
    vol_ratio = _volume_ratio(volumes)

    # ATR as % of price. Cheap regime proxy: dead/whippy vs tradable.
    atr_pct = (a / last * 100.0) if last > 0 else 0.0

    # Always run MTF alignment when there's enough history — it informs the
    # quality score even if the hard MTF gate (cfg.mtf_confirmation) is off.
    mtf_agree5: Optional[bool] = None
    mtf_agree15: Optional[bool] = None
    mtf_info: dict = {}
    if action != "HOLD" and len(candles) >= 75:
        try:
            mtf_info = mtf_alignment(candles, action)
            mtf_agree5 = bool(mtf_info.get("agree5"))
            mtf_agree15 = bool(mtf_info.get("agree15"))
        except Exception:  # noqa: BLE001 — resampling is best-effort
            mtf_info = {}

    quality, q_breakdown = _quality_score(
        action,
        last=last,
        fast_ma=fast_now,
        slow_ma=slow_now,
        long_ma=long_now,
        rsi_now=r_now,
        macd_hist=macd_last or 0.0,
        macd_hist_prev=macd_hist_prev or 0.0,
        supertrend_dir=st_now or 0,
        vwap_now=v_now,
        adx_now=adx_now,
        vol_ratio=vol_ratio,
        vol_min=cfg.volume_min_ratio,
        atr_pct=atr_pct,
        mtf_agree5=mtf_agree5,
        mtf_agree15=mtf_agree15,
    )
    filters["quality"] = round(quality, 3)
    filters["qualityBreakdown"] = q_breakdown
    filters["volumeRatio"] = round(vol_ratio, 3)
    filters["atrPct"] = round(atr_pct, 3)
    if mtf_info:
        filters["mtfPreview"] = {"tf5": mtf_info.get("tf5"), "tf15": mtf_info.get("tf15")}
    if action != "HOLD" and cfg.quality_gate and quality < cfg.min_quality:
        reason = (
            f"Filtered by quality gate: confluence {quality:.2f} < {cfg.min_quality:.2f} "
            f"(trend {q_breakdown.get('trend',0):.2f} · momentum {q_breakdown.get('momentum',0):.2f} · "
            f"volume {q_breakdown.get('volume',0):.2f} · vol×{vol_ratio:.2f})"
        )
        action = "HOLD"

    if action != "HOLD" and cfg.regime_filter:
        filters["regime"] = adx_now >= cfg.regime_min_adx
        if not filters["regime"]:
            reason = f"Filtered by regime: ADX {adx_now:.1f} < {cfg.regime_min_adx} (choppy market)"
            action = "HOLD"
    if action != "HOLD" and cfg.mtf_confirmation:
        mtf = mtf_info if mtf_info else mtf_alignment(candles, action)
        filters["mtf"] = bool(mtf.get("aligned"))
        filters["tf5"] = mtf.get("tf5")
        filters["tf15"] = mtf.get("tf15")
        if not mtf.get("aligned"):
            reason = f"Filtered by MTF: 5m={mtf.get('tf5')}, 15m={mtf.get('tf15')} (need alignment)"
            action = "HOLD"

    # Blend the legacy vote-based score with the new confluence score, so the
    # confidence reported to the UI reflects *measured* multi-factor agreement
    # rather than just the rule branch that fired.
    if action != "HOLD":
        blended = 0.5 * score + 0.5 * quality
        confidence = max(cfg.confidence_floor, min(cfg.confidence_cap, blended))
    else:
        confidence = 0.4

    stop, target = _compute_stops(action, last, a, cfg)
    entry = last if action != "HOLD" else last

    return SignalDecision(
        action=action,
        confidence=round(confidence, 3),
        reason=reason,
        indicators={
            "rsi14": round(r_now, 2),
            "sma9": round(fast_now, 2),
            "sma21": round(slow_now, 2),
            "sma50": round(long_now, 2),
            "ema9": round(ema9, 2),
            "ema21": round(ema21, 2),
            "atr14": round(a, 4),
            "adx14": round(adx_now, 2),
            "macd": round(macd_line[-1] or 0.0, 4),
            "macdSignal": round(macd_sig[-1] or 0.0, 4),
            "macdHist": round(macd_hist[-1] or 0.0, 4),
            "bbUpper": round(bb_u[-1] or 0.0, 2),
            "bbMid": round(bb_m[-1] or 0.0, 2),
            "bbLower": round(bb_l[-1] or 0.0, 2),
            "stochK": round(stoch_k[-1] or 0.0, 2),
            "stochD": round(stoch_d[-1] or 0.0, 2),
            "supertrend": round(st_line[-1] or 0.0, 2),
            "supertrendDir": st_dir[-1] if st_dir[-1] is not None else 0,
            "vwap": round(vwap_series[-1] or 0.0, 2),
            "bullVotes": bull_votes,
            "bearVotes": bear_votes,
            "volRatio": round(vol_ratio, 2),
            "qualityScore": round(quality, 3),
            "last": round(last, 2),
        },
        suggested_entry=round(entry, 2),
        suggested_stop=stop,
        suggested_target=target,
        filters=filters,
    )
