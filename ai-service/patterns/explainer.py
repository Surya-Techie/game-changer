"""Pattern explainer — Phase 9.

Deterministic, fully-local natural-language explanation for every detected
pattern. NO external LLM dependency.

Design
------
For each pattern name we keep a small `(mechanism, meaning)` template:

  • mechanism — one sentence describing what physically happened in the
    candles (e.g. "A large bearish candle was followed by a small bullish
    candle contained within it…")
  • meaning — one sentence describing the trading implication (e.g.
    "…signalling buyer absorption and a potential reversal.")

`generate_explanation()` plugs these into a wrapper that adds the symbol,
timeframe, price, confidence grade, the list of confirmation factors that
passed (volume / trend / MTF / S/R / win-rate), the trade plan
(entry / target / stop / RR), and the historical win rate.

The output is a multi-line string ready to surface on the chart, in the
PatternPanel sidebar, in the notification toast, or pasted into a journal.
"""

from __future__ import annotations

from typing import Optional, Tuple

import pandas as pd

from ._helpers import (
    adx as adx_series,
    baseline_win_rate,
    ema,
    ensure_df,
    trend_classify,
    volume_ratio,
)


# ─── Templates: (mechanism, meaning) per pattern name ─────────────────────
# Mechanism = "what happened" in one sentence. Meaning = "what it implies".
# Keep each <120 chars so the rendered explanation fits comfortably in the
# toast / sidebar / chart label without wrapping awkwardly.

PATTERN_TEMPLATES: dict[str, Tuple[str, str]] = {
    # ── Single-candle ──
    "Hammer": (
        "A small body sits at the top of the range with a long lower wick after a downtrend",
        "buyers absorbed the selloff and reclaimed the open — early reversal signal.",
    ),
    "Inverted Hammer": (
        "A small body sits at the low with a long upper wick after a downtrend",
        "first bullish attempt; needs the next bar's confirmation.",
    ),
    "Shooting Star": (
        "A small body sits at the low with a long upper wick after an uptrend",
        "buyers exhausted at the high and sellers reclaimed control by close.",
    ),
    "Hanging Man": (
        "A hammer-shaped bar prints after an uptrend",
        "the long lower wick reveals selling tests under the surface — bearish warning.",
    ),
    "Doji": (
        "Open and close nearly equal with shadows on both sides",
        "supply and demand are balanced — indecision; await the next bar's direction.",
    ),
    "Long-Legged Doji": (
        "A doji body with long shadows on both ends",
        "sharp two-sided volatility; the market is searching for direction.",
    ),
    "Gravestone Doji": (
        "Open ≈ close ≈ low with a long upper shadow",
        "buyers pushed up but were rejected — bearish reversal at tops.",
    ),
    "Dragonfly Doji": (
        "Open ≈ close ≈ high with a long lower shadow",
        "sellers tried and failed; buyers reclaimed the bar — bullish reversal at bottoms.",
    ),
    "Spinning Top": (
        "A small body with shadows on both sides",
        "momentum has stalled — indecision after a directional move.",
    ),
    "Bullish Marubozu": (
        "A bull bar fills the entire range, opening at the low and closing at the high",
        "buyers are in unilateral control — strong directional conviction.",
    ),
    "Bearish Marubozu": (
        "A bear bar fills the entire range, opening at the high and closing at the low",
        "sellers are in unilateral control — strong directional conviction.",
    ),
    "Bullish Belt Hold": (
        "A bull bar opens at the session low with no lower wick after a downtrend",
        "instant buying pressure from the open — momentum reversal candidate.",
    ),
    "Bearish Belt Hold": (
        "A bear bar opens at the session high with no upper wick after an uptrend",
        "instant selling pressure from the open — momentum reversal candidate.",
    ),
    "High Wave": (
        "A tiny body with extremely long shadows on both ends",
        "violent two-way auction; participants disagree sharply on fair value.",
    ),

    # ── Two-candle ──
    "Bullish Engulfing": (
        "A large bull body fully engulfs the prior bear body",
        "buyers overwhelmed yesterday's sellers and seized control of the range.",
    ),
    "Bearish Engulfing": (
        "A large bear body fully engulfs the prior bull body",
        "sellers overwhelmed yesterday's buyers and seized control of the range.",
    ),
    "Bullish Harami": (
        "A small bull body sits inside the prior large bear body",
        "selling pressure has paused — reversal often follows.",
    ),
    "Bearish Harami": (
        "A small bear body sits inside the prior large bull body",
        "buying pressure has paused — reversal often follows.",
    ),
    "Bullish Harami Cross": (
        "An inside-bar doji follows a large bear candle",
        "extreme contraction after a decline — high-probability reversal cue.",
    ),
    "Bearish Harami Cross": (
        "An inside-bar doji follows a large bull candle",
        "extreme contraction after a rally — high-probability reversal cue.",
    ),
    "Piercing Line": (
        "A bull bar opens below the prior low and closes above the bear's midpoint",
        "buyers reclaimed more than half the prior decline — bullish reversal.",
    ),
    "Dark Cloud Cover": (
        "A bear bar opens above the prior high and closes below the bull's midpoint",
        "sellers gave back more than half the prior rally — bearish reversal.",
    ),
    "Tweezer Bottom": (
        "Two consecutive bars share the same low after a downtrend",
        "support held twice in a row — clear demand zone.",
    ),
    "Tweezer Top": (
        "Two consecutive bars share the same high after an uptrend",
        "resistance held twice in a row — clear supply zone.",
    ),
    "On-Neck Pattern": (
        "A bull bar barely recovers to the prior bar's low",
        "bears still in command — downtrend likely resumes.",
    ),
    "In-Neck Pattern": (
        "A bull bar closes just inside the prior bear body below its midpoint",
        "weak bounce; bears retain control of the broader move.",
    ),
    "Thrusting Pattern": (
        "A bull bar penetrates the bear body but stops below midpoint",
        "the bullish attempt failed — continuation likely.",
    ),
    "Bullish Kicker": (
        "A strong bull bar gaps above the prior bear bar's open",
        "sentiment shock — one of the most reliable single-pair reversals.",
    ),
    "Bearish Kicker": (
        "A strong bear bar gaps below the prior bull bar's open",
        "sentiment shock — one of the most reliable single-pair reversals.",
    ),
    "Bullish Meeting Lines": (
        "A bear and a bull bar close at the same price after a downtrend",
        "first sign of seller exhaustion — needs confirmation.",
    ),
    "Bearish Meeting Lines": (
        "A bull and a bear bar close at the same price after an uptrend",
        "first sign of buyer exhaustion — needs confirmation.",
    ),

    # ── Three-candle ──
    "Morning Star": (
        "Large bear, then a small-bodied middle, then a large bull closing above the bear's midpoint",
        "classic three-bar bottom reversal with internal indecision phase.",
    ),
    "Evening Star": (
        "Large bull, then a small-bodied middle, then a large bear closing below the bull's midpoint",
        "classic three-bar top reversal with internal indecision phase.",
    ),
    "Morning Doji Star": (
        "A doji isolates the middle bar in a 3-bar reversal at a bottom",
        "the doji marks maximum indecision before bulls take over.",
    ),
    "Evening Doji Star": (
        "A doji isolates the middle bar in a 3-bar reversal at a top",
        "the doji marks maximum indecision before bears take over.",
    ),
    "Three White Soldiers": (
        "Three consecutive large bull bars with higher closes",
        "sustained, broad-based buying — strong uptrend confirmation.",
    ),
    "Three Black Crows": (
        "Three consecutive large bear bars with lower closes",
        "sustained, broad-based selling — strong downtrend confirmation.",
    ),
    "Three Inside Up": (
        "A bullish harami confirmed by a third bar closing above the prior bear's open",
        "the harami's reversal cue is confirmed by follow-through.",
    ),
    "Three Inside Down": (
        "A bearish harami confirmed by a third bar closing below the prior bull's open",
        "the harami's reversal cue is confirmed by follow-through.",
    ),
    "Three Outside Up": (
        "A bullish engulfing confirmed by a third bar closing higher",
        "the engulfing's reversal cue is confirmed by follow-through.",
    ),
    "Three Outside Down": (
        "A bearish engulfing confirmed by a third bar closing lower",
        "the engulfing's reversal cue is confirmed by follow-through.",
    ),
    "Bullish Abandoned Baby": (
        "A doji isolated by gaps on both sides at a low",
        "extremely rare; a very strong reversal signal when it occurs.",
    ),
    "Bearish Abandoned Baby": (
        "A doji isolated by gaps on both sides at a high",
        "extremely rare; a very strong reversal signal when it occurs.",
    ),
    "Advance Block": (
        "Three rising bull bars with shrinking bodies and growing upper wicks",
        "the uptrend is losing steam — distribution likely beginning.",
    ),
    "Deliberation": (
        "Two large bull bars followed by a small one near the second close",
        "trend stalling at the highs — exhaustion warning.",
    ),
    "Stick Sandwich": (
        "Two bear bars sandwich a bull bar with matching outer closes",
        "the bottom is holding — bullish reversal candidate.",
    ),
    "Ladder Bottom": (
        "Three falling bears, then a bear with an upper wick, then a bull that gaps up",
        "the bottoming sequence completes — strong reversal.",
    ),
    "Ladder Top": (
        "Three rising bulls, then a bull with a lower wick, then a bear that gaps down",
        "the topping sequence completes — strong reversal.",
    ),
    "Unique Three River Bottom": (
        "Two bears (the second printing a new low but closing higher), then a small bull",
        "selling pressure exhausted at a fresh low.",
    ),
    "Two Crows": (
        "A bull bar followed by two bears, the second closing inside the bull",
        "uptrend losing grip; bears reclaiming territory.",
    ),
    "Upside Gap Two Crows": (
        "A long bull then two bears that gap above it",
        "sellers regaining control above the bull's range — reversal candidate.",
    ),
    "Bullish Mat Hold": (
        "A big bull, brief 3-bar pullback inside its range, then a strong bull breakout",
        "high-probability uptrend continuation after a controlled rest.",
    ),
    "Bearish Mat Hold": (
        "A big bear, brief 3-bar rally inside its range, then a strong bear breakdown",
        "high-probability downtrend continuation after a controlled bounce.",
    ),

    # ── Multi-candle complex ──
    "Rising Three Methods": (
        "Long bull, 3-bar bearish pause inside its range, then another long bull",
        "uptrend resumes after a textbook rest.",
    ),
    "Falling Three Methods": (
        "Long bear, 3-bar bullish pause inside its range, then another long bear",
        "downtrend resumes after a textbook bounce.",
    ),
    "Three Stars in the South": (
        "Three progressively smaller bears with rising lows",
        "selling pressure is draining — reversal imminent.",
    ),
    "Concealing Baby Swallow": (
        "Two marubozu bears, a gap-down bear that rallies into prior body, then an engulfing bear",
        "rare 4-bar selling climax — bullish reversal candidate.",
    ),
    "Bullish Breakaway": (
        "A bear gap then continued selling, capped by a long bull closing back inside the gap",
        "capitulation reversal — bulls reclaim the gap.",
    ),
    "Bearish Breakaway": (
        "A bull gap then continued buying, capped by a long bear closing back inside the gap",
        "euphoria reversal — bears reclaim the gap.",
    ),
    "Bullish Eight New Price Lines": (
        "Eight consecutive higher highs",
        "overextension warning — profit-taking historically follows.",
    ),
    "Bearish Eight New Price Lines": (
        "Eight consecutive lower lows",
        "overextension warning — bounce historically follows.",
    ),

    # ── Western chart ──
    "Bull Flag": (
        "A strong impulse up followed by a tight downward-channel pullback",
        "the consolidation is a flagpole pause; breakout targets the prior impulse length.",
    ),
    "Bear Flag": (
        "A strong impulse down followed by a tight upward-channel pullback",
        "the consolidation is a flagpole pause; breakdown targets the prior impulse length.",
    ),
    "Bull Pennant": (
        "A strong impulse up followed by a small symmetrical triangle",
        "compressed continuation pattern — breakout targets the impulse length.",
    ),
    "Bear Pennant": (
        "A strong impulse down followed by a small symmetrical triangle",
        "compressed continuation pattern — breakdown targets the impulse length.",
    ),
    "Ascending Triangle": (
        "Flat resistance with rising lows compresses price into the corner",
        "bullish accumulation; breakout above resistance targets the pattern height.",
    ),
    "Descending Triangle": (
        "Flat support with lower highs compresses price into the corner",
        "bearish distribution; breakdown below support targets the pattern height.",
    ),
    "Symmetrical Triangle": (
        "Lower highs and higher lows compress into converging trendlines",
        "continuation in the direction of the prior swing once one side breaks.",
    ),
    "Rising Wedge": (
        "Both trendlines rise but lows rise faster than highs",
        "exhaustion pattern; breakdown is the expected resolution.",
    ),
    "Falling Wedge": (
        "Both trendlines fall but highs fall faster than lows",
        "selling exhausting; breakout is the expected resolution.",
    ),
    "Ascending Channel": (
        "Parallel rising trendlines contain a steady uptrend",
        "trade the boundaries — buy near support, sell near resistance.",
    ),
    "Descending Channel": (
        "Parallel falling trendlines contain a steady downtrend",
        "trade the boundaries — sell near resistance, cover near support.",
    ),
    "Horizontal Channel": (
        "Parallel flat trendlines contain a range",
        "trade the boundaries — break in either direction signals a new trend.",
    ),
    "Cup and Handle": (
        "A U-shaped basing with a small downward handle pullback",
        "breakout above the cup rim targets the cup's full depth.",
    ),
    "Inverse Cup and Handle": (
        "An inverted-U distribution with a small upward rebound handle",
        "breakdown below the cup rim targets the cup's full height.",
    ),
    "Head and Shoulders": (
        "Three peaks with the middle highest, plus a neckline through the troughs",
        "the most reliable bearish reversal; breakdown targets the head height.",
    ),
    "Inverse Head and Shoulders": (
        "Three troughs with the middle lowest, plus a neckline through the peaks",
        "the most reliable bullish reversal; breakout targets the head depth.",
    ),
    "Double Top": (
        "Two peaks at the same level with a trough between them",
        "second-test failure at resistance — breakdown below trough confirms.",
    ),
    "Double Bottom": (
        "Two troughs at the same level with a peak between them",
        "second-test failure at support — breakout above peak confirms.",
    ),
    "Triple Top": (
        "Three peaks at the same level with shared support",
        "exhaustion at resistance; breakdown is the high-probability outcome.",
    ),
    "Triple Bottom": (
        "Three troughs at the same level with shared resistance",
        "exhaustion at support; breakout is the high-probability outcome.",
    ),
    "Rounding Bottom": (
        "Price traces a smooth U-shape over many bars",
        "patient accumulation; breakout above the rim targets the pattern depth.",
    ),
    "Rounding Top": (
        "Price traces a smooth inverted-U over many bars",
        "patient distribution; breakdown below the rim targets the pattern height.",
    ),
    "Rectangle": (
        "Price oscillates inside a horizontal range with clear top and bottom",
        "trade the breakout direction; target the full range height.",
    ),
    "Bullish Island Reversal": (
        "A cluster of bars isolated by a gap-down then a gap-up",
        "sharp sentiment flip — rare and powerful bullish reversal.",
    ),
    "Bearish Island Reversal": (
        "A cluster of bars isolated by a gap-up then a gap-down",
        "sharp sentiment flip — rare and powerful bearish reversal.",
    ),
    "Bump and Run Reversal": (
        "Three phases: gentle uptrend, steep 'bump', then break of the lead-in trendline",
        "distribution complete; the rally was unsustainable.",
    ),
    "Diamond Top": (
        "Volatility first expands then contracts into a diamond at a high",
        "topping pattern; breakdown targets the apex height.",
    ),
    "Diamond Bottom": (
        "Volatility first expands then contracts into a diamond at a low",
        "bottoming pattern; breakout targets the apex height.",
    ),

    # ── Institutional ──
    "Inside Bar": (
        "The current bar's range fits entirely inside the prior bar's range",
        "compression before continuation — direction follows the prior bar's bias.",
    ),
    "Outside Bar": (
        "The current bar's range extends beyond the prior bar on both sides",
        "expansion phase — direction follows the close of the outside bar.",
    ),
    "Bullish Pin Bar": (
        "A strong rejection of lows: long lower wick, close in the top 35% of the range",
        "smart money defended this level — a high-RR bullish entry.",
    ),
    "Bearish Pin Bar": (
        "A strong rejection of highs: long upper wick, close in the bottom 35% of the range",
        "smart money defended this level — a high-RR bearish entry.",
    ),
    "Bullish Fakey": (
        "Inside bar then a false break below it, followed by a strong reversal back up",
        "classic stop-hunt fakeout; smart money loaded up at the trapped retail lows.",
    ),
    "Bearish Fakey": (
        "Inside bar then a false break above it, followed by a strong reversal back down",
        "classic stop-hunt fakeout; smart money sold into trapped retail highs.",
    ),
    "Wyckoff Spring": (
        "Price spikes below the 20-bar range support then closes back inside",
        "institutional accumulation; the spike was a stop-hunt before the markup.",
    ),
    "Wyckoff Upthrust": (
        "Price spikes above the 20-bar range resistance then closes back inside",
        "institutional distribution; the spike was a stop-hunt before the markdown.",
    ),
    "Bullish Consolidation Breakout": (
        "Close breaks above the 20-bar resistance on volume ≥ 1.5× average",
        "genuine momentum breakout — measure the breakout's range to project the target.",
    ),
    "Bearish Consolidation Breakout": (
        "Close breaks below the 20-bar support on volume ≥ 1.5× average",
        "genuine momentum breakdown — measure the breakout's range to project the target.",
    ),
    "Volatility Contraction Pattern": (
        "Three or more progressively tighter pullbacks with drying volume",
        "Minervini VCP setup — the spring is loaded for the next leg.",
    ),
    "NR7": (
        "Today's range is the narrowest of the last 7 bars",
        "extreme volatility compression — explosive move usually follows the breakout direction.",
    ),
    "NR4": (
        "Today's range is the narrowest of the last 4 bars",
        "volatility compression — directional move often follows the breakout direction.",
    ),
    "Bullish Wide Range Bar": (
        "A bull bar with body ≥ 2× average and volume confirmation",
        "a large institutional print — strong directional intent.",
    ),
    "Bearish Wide Range Bar": (
        "A bear bar with body ≥ 2× average and volume confirmation",
        "a large institutional print — strong directional intent.",
    ),
    "Bullish Power of 3": (
        "Accumulation range → manipulation sweep of the low → strong distribution rally",
        "ICT three-phase model: a textbook bullish session structure.",
    ),
    "Bearish Power of 3": (
        "Accumulation range → manipulation sweep of the high → strong distribution decline",
        "ICT three-phase model: a textbook bearish session structure.",
    ),
    "Bullish Liquidity Sweep": (
        "Price swept the prior swing low by a meaningful margin then reversed strongly",
        "stop-hunt completion at the lows — high-RR reversal entry.",
    ),
    "Bearish Liquidity Sweep": (
        "Price swept the prior swing high by a meaningful margin then reversed strongly",
        "stop-hunt completion at the highs — high-RR reversal entry.",
    ),
    "Bullish Fair Value Gap": (
        "Candle 1's high sits below candle 3's low (3-bar bullish imbalance)",
        "an inefficient up-move; price often returns to fill the gap before continuing.",
    ),
    "Bearish Fair Value Gap": (
        "Candle 1's low sits above candle 3's high (3-bar bearish imbalance)",
        "an inefficient down-move; price often returns to fill the gap before continuing.",
    ),
    "Bullish Order Block": (
        "Last bearish candle before a strong bullish impulse",
        "institutional bid zone — high-RR demand entry on retest.",
    ),
    "Bearish Order Block": (
        "Last bullish candle before a strong bearish impulse",
        "institutional offer zone — high-RR supply entry on retest.",
    ),
    "Bullish Breaker Block": (
        "A failed bearish order block that price has reclaimed from above",
        "old supply flips to demand — a polarity-shift entry.",
    ),
    "Bearish Breaker Block": (
        "A failed bullish order block that price has reclaimed from below",
        "old demand flips to supply — a polarity-shift entry.",
    ),
    "Bullish Mitigation Block": (
        "Price returned to mitigate the origin candle of the prior bullish move",
        "institutional re-entry zone — the move was created here, the move continues from here.",
    ),
    "Bearish Mitigation Block": (
        "Price returned to mitigate the origin candle of the prior bearish move",
        "institutional re-entry zone — the move was created here, the move continues from here.",
    ),
    "Bullish Inducement": (
        "A minor swing low was engineered, swept, and immediately reversed",
        "stop-trap at the lows — true direction reveals itself after the sweep.",
    ),
    "Bearish Inducement": (
        "A minor swing high was engineered, swept, and immediately reversed",
        "stop-trap at the highs — true direction reveals itself after the sweep.",
    ),
    "Bullish OTE": (
        "Pullback into the 62-79% Fibonacci retrace of the recent impulse",
        "Optimal Trade Entry zone — high-RR continuation entry with confluence.",
    ),
    "Bearish OTE": (
        "Rally into the 62-79% Fibonacci retrace of the recent decline",
        "Optimal Trade Entry zone — high-RR continuation entry with confluence.",
    ),
}


def _confidence_grade_phrase(score: int) -> str:
    if score >= 85:
        return "VERY HIGH"
    if score >= 70:
        return "HIGH"
    if score >= 55:
        return "MEDIUM"
    return "LOW"


def _format_inr(x: Optional[float]) -> str:
    if x is None:
        return "—"
    return f"₹{x:,.2f}"


def _rsi_now(df: pd.DataFrame, period: int = 14) -> Optional[float]:
    if len(df) < period + 1:
        return None
    closes = df["close"]
    delta = closes.diff()
    gain = delta.clip(lower=0).ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1.0 / period, adjust=False, min_periods=1).mean()
    rs = gain / loss.replace(0, float("nan"))
    val = (100 - 100 / (1 + rs)).iloc[-1]
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _nearest_ema_within(df: pd.DataFrame, periods=(50, 200), tol_pct: float = 0.012) -> Optional[Tuple[int, float, float]]:
    """Return (period, ema_value, distance_pct) if the latest close is within
    tol_pct of an EMA from `periods`."""
    if len(df) < 50:
        return None
    last = float(df["close"].iloc[-1])
    candidates: list[Tuple[int, float, float]] = []
    for p in periods:
        if len(df) < p:
            continue
        v = float(ema(df["close"], int(p)).iloc[-1])
        dist = abs(last - v) / max(last, 1e-9)
        if dist <= tol_pct:
            candidates.append((p, v, dist))
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[2])
    return candidates[0]


def _reasoning_bullets(
    pattern: dict,
    df: pd.DataFrame,
    win_rate: float,
) -> list[str]:
    """Build a small list of human reason bullets — what *passed* in the
    confidence check, why the score is what it is."""
    breakdown = pattern.get("score_breakdown") or {}
    bullets: list[str] = []

    # Volume.
    vr = volume_ratio(df, window=20, idx=len(df) - 1)
    if vr >= 1.5:
        bullets.append(f"Volume spiked {vr:.1f}× above the 20-bar average (strong participation)")
    elif vr >= 1.1:
        bullets.append(f"Volume is {vr:.2f}× the 20-bar average (modest participation)")
    elif vr > 0:
        bullets.append(f"Volume is light at {vr:.2f}× the 20-bar average — caution")

    # RSI.
    rsi = _rsi_now(df)
    direction = pattern.get("direction", "neutral")
    if rsi is not None:
        if direction == "bullish" and rsi <= 35:
            bullets.append(f"RSI is at {rsi:.0f} (oversold — buyers stepping in)")
        elif direction == "bearish" and rsi >= 65:
            bullets.append(f"RSI is at {rsi:.0f} (overbought — sellers stepping in)")
        elif 40 <= rsi <= 60:
            bullets.append(f"RSI is mid-range ({rsi:.0f}) — no oscillator extreme distorting the read")

    # Trend alignment.
    trend = trend_classify(df)
    if direction == "bullish" and trend == "uptrend":
        bullets.append("Higher-EMA structure is bullish — pattern aligns with the trend")
    elif direction == "bearish" and trend == "downtrend":
        bullets.append("Higher-EMA structure is bearish — pattern aligns with the trend")
    elif direction in ("bullish", "bearish") and trend == "sideways":
        bullets.append("Background trend is sideways — pattern is a directional bet inside a range")
    elif direction == "bullish" and trend == "downtrend":
        bullets.append("Background trend is bearish — bullish pattern is counter-trend; size accordingly")
    elif direction == "bearish" and trend == "uptrend":
        bullets.append("Background trend is bullish — bearish pattern is counter-trend; size accordingly")

    # MTF agreement (only known if score_breakdown.mtf > 0).
    mtf_pts = float(breakdown.get("mtf") or 0)
    if mtf_pts >= 10:
        bullets.append("Higher timeframe trend agrees with the pattern direction")
    elif mtf_pts >= 5:
        bullets.append("Higher timeframe is consolidating — no fight, no help")

    # S/R proximity.
    nearest = _nearest_ema_within(df)
    if nearest is not None:
        period, lvl, dist = nearest
        bullets.append(f"Price is within {dist * 100:.2f}% of the {period}-EMA at {_format_inr(lvl)} — confluence")

    # ML.
    ml_pts = float(breakdown.get("ml") or 0)
    if ml_pts >= 18:
        bullets.append("ML ensemble strongly agrees with the direction")
    elif ml_pts >= 10:
        bullets.append("ML ensemble leans in the same direction")
    elif breakdown.get("ml_source") == "rule_only":
        bullets.append("ML model not yet trained — confidence is rule-based only")

    # Historical track-record line.
    bullets.append(
        f"Historical baseline win rate for this pattern: {win_rate * 100:.0f}%"
    )
    return bullets


# ─── Public entry point ───────────────────────────────────────────────────

def generate_explanation(
    pattern: dict,
    df: pd.DataFrame,
    *,
    symbol: str,
    timeframe: str,
    win_rate_override: Optional[float] = None,
) -> str:
    """Produce a multi-line natural-language explanation for one detected
    pattern. The `df` is the OHLCV window the pattern was detected from
    (the same one passed to the rule engine), so indicator context is
    consistent with the detector's view.

    Output shape:
        Line 1: "A {Pattern Name} formed on {SYMBOL} {TF} at ₹{price}."
        Line 2-3: mechanism + meaning (template-driven).
        Line 4: "Confidence is {GRADE} ({score}%) because:"
        • bullets …
        Line: "Suggested entry: … | Target: … ({RR}R) | Stop: …"
        Line: "Historical baseline win rate: … (raise to live PatternAccuracy when ≥10 samples)"
    """
    df = ensure_df(df)
    if len(df) == 0:
        return ""
    name = str(pattern.get("pattern_name") or "Pattern")
    direction = str(pattern.get("direction") or "neutral")
    confidence = int(pattern.get("confidence_score") or 0)
    grade_word = _confidence_grade_phrase(confidence)
    price = float(df["close"].iloc[-1])

    mechanism, meaning = PATTERN_TEMPLATES.get(name, (
        f"A {name} structure formed across the most recent bars",
        "the formation suggests a directional bias is taking shape; monitor the next bars for confirmation.",
    ))

    entry = pattern.get("entry_price")
    target = pattern.get("target_price")
    stop = pattern.get("stop_price")
    rr = pattern.get("risk_reward")
    win_rate = (
        win_rate_override
        if win_rate_override is not None
        else float(pattern.get("historical_win_rate") or baseline_win_rate(name))
    )

    bullets = _reasoning_bullets(pattern, df, win_rate)

    lines: list[str] = []
    lines.append(f"A {name} formed on {symbol.upper()} {timeframe} at {_format_inr(price)}.")
    lines.append(f"{mechanism}, {meaning}")
    lines.append(f"Confidence is {grade_word} ({confidence}%) because:")
    for b in bullets:
        lines.append(f"  • {b}")
    if entry is not None and target is not None and stop is not None:
        rr_str = f" ({float(rr):.1f}R)" if rr is not None else ""
        lines.append(
            f"Suggested entry: {_format_inr(entry)} | "
            f"Target: {_format_inr(target)}{rr_str} | "
            f"Stop: {_format_inr(stop)}"
        )
    elif direction in ("bullish", "bearish"):
        lines.append("Trade plan: this pattern type doesn't ship its own target/stop — use ATR-based stops and your own RR target.")

    return "\n".join(lines)


def explain_many(
    patterns: list[dict],
    df: pd.DataFrame,
    *,
    symbol: str,
    timeframe: str,
    win_rate_overrides: Optional[dict[str, float]] = None,
) -> list[dict]:
    """Convenience: attach `ai_explanation` to each pattern dict in place
    and return the list (so callers can chain after score_many)."""
    win_rate_overrides = win_rate_overrides or {}
    for p in patterns:
        if not p.get("detected", True):
            continue
        wr = win_rate_overrides.get(str(p.get("pattern_name") or ""))
        try:
            p["ai_explanation"] = generate_explanation(
                p, df, symbol=symbol, timeframe=timeframe, win_rate_override=wr,
            )
        except Exception:  # noqa: BLE001 — never let an explainer error break detection
            p["ai_explanation"] = ""
    return patterns
