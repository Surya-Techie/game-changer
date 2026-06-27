"""Premium indicators — math for the 5-chip premium toolbar.

Functions return dicts shaped for direct JSON response. Each takes a list
of OHLCV dicts (1m candles from the mock feed) and produces:
  • indicator series aligned to candles (suitable for chart overlay)
  • a compact "signal" object the frontend renders in the right panel

No external deps beyond numpy/pandas (already installed for sklearn).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


def _df(candles: List[dict]) -> pd.DataFrame:
    df = pd.DataFrame(candles)
    df["t"] = pd.to_datetime(df["t"], unit="ms", utc=True)
    df = df.set_index("t").rename(columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})
    return df[["open", "high", "low", "close", "volume"]].astype(float).sort_index()


def _ms(idx: pd.DatetimeIndex) -> List[int]:
    return [int(t.value // 1_000_000) for t in idx]


def _none_for_nan(arr) -> List[Optional[float]]:
    out: List[Optional[float]] = []
    for v in arr:
        if v is None or (isinstance(v, float) and (np.isnan(v) or np.isinf(v))):
            out.append(None)
        else:
            out.append(float(v))
    return out


# =============================================================================
# 1. VWAP + Bands + Anchored
# =============================================================================

def calculate_vwap_full(candles: List[dict], anchor_bars: Optional[List[int]] = None) -> dict:
    df = _df(candles)
    if df.empty:
        return {"error": "no candles"}

    df["typical"] = (df["high"] + df["low"] + df["close"]) / 3
    df["tp_vol"] = df["typical"] * df["volume"]
    df["session"] = df.index.date

    # Per-session running VWAP and bands.
    vwap = pd.Series(index=df.index, dtype=float)
    upper1 = pd.Series(index=df.index, dtype=float)
    lower1 = pd.Series(index=df.index, dtype=float)
    upper2 = pd.Series(index=df.index, dtype=float)
    lower2 = pd.Series(index=df.index, dtype=float)
    upper3 = pd.Series(index=df.index, dtype=float)
    lower3 = pd.Series(index=df.index, dtype=float)

    session_summary: List[dict] = []
    for day, grp in df.groupby("session"):
        cum_tp = grp["tp_vol"].cumsum()
        cum_v = grp["volume"].cumsum().replace(0, np.nan)
        v = cum_tp / cum_v
        dev = grp["typical"] - v
        var = (dev.pow(2) * grp["volume"]).cumsum() / cum_v
        std = var.pow(0.5)
        vwap.loc[grp.index] = v
        upper1.loc[grp.index] = v + std
        lower1.loc[grp.index] = v - std
        upper2.loc[grp.index] = v + 2 * std
        lower2.loc[grp.index] = v - 2 * std
        upper3.loc[grp.index] = v + 3 * std
        lower3.loc[grp.index] = v - 3 * std
        session_summary.append({"date": str(day), "endVwap": float(v.iloc[-1]) if pd.notna(v.iloc[-1]) else None})

    # Prior session's final VWAP.
    prev_vwap = session_summary[-2]["endVwap"] if len(session_summary) >= 2 else None
    cur_vwap = float(vwap.iloc[-1])
    last_price = float(df["close"].iloc[-1])

    # Slope: average of last 5 bar deltas as % of vwap.
    slope_bars = 5
    if len(vwap) > slope_bars:
        deltas = vwap.diff().tail(slope_bars).mean()
        slope_pct = (deltas / cur_vwap) * 100 if cur_vwap else 0
    else:
        slope_pct = 0.0

    # Volume vs 20-bar avg.
    vol_avg = df["volume"].tail(20).mean() if len(df) >= 20 else df["volume"].mean()
    vol_ratio = float(df["volume"].iloc[-1] / vol_avg) if vol_avg > 0 else 1.0

    # Band position.
    u1 = float(upper1.iloc[-1])
    l1 = float(lower1.iloc[-1])
    u2 = float(upper2.iloc[-1])
    l2 = float(lower2.iloc[-1])
    u3 = float(upper3.iloc[-1])
    l3 = float(lower3.iloc[-1])

    if last_price > u3:
        band_pos, signal = "Above +3σ (extreme)", "EXTENDED"
    elif last_price > u2:
        band_pos, signal = "Between +2σ / +3σ", "EXTENDED"
    elif last_price > u1:
        band_pos, signal = "Between +1σ / +2σ", "EXTENDED"
    elif last_price > cur_vwap:
        band_pos, signal = "Above VWAP / below +1σ", "BUY"
    elif last_price < l3:
        band_pos, signal = "Below -3σ (extreme)", "STRONG BUY"
    elif last_price < l2:
        band_pos, signal = "Between -2σ / -3σ", "STRONG BUY"
    elif last_price < l1:
        band_pos, signal = "Between -1σ / -2σ", "BUY"
    elif last_price < cur_vwap:
        band_pos, signal = "Below VWAP / above -1σ", "SELL"
    else:
        band_pos, signal = "At VWAP", "NEUTRAL"

    # Anchored VWAP(s).
    anchored = []
    if anchor_bars:
        n = len(df)
        for idx in anchor_bars:
            if not (0 <= idx < n):
                continue
            sub = df.iloc[idx:]
            cum_tp = (sub["typical"] * sub["volume"]).cumsum()
            cum_v = sub["volume"].cumsum().replace(0, np.nan)
            av = cum_tp / cum_v
            anchored.append({
                "anchorIdx": idx,
                "anchorTime": _ms(sub.index[:1])[0],
                "anchorPrice": float(df["close"].iloc[idx]),
                "current": float(av.iloc[-1]) if pd.notna(av.iloc[-1]) else None,
                "t": _ms(sub.index),
                "values": _none_for_nan(av.values),
                "abovePrice": last_price > float(av.iloc[-1]) if pd.notna(av.iloc[-1]) else None,
            })

    return {
        "t": _ms(df.index),
        "vwap": _none_for_nan(vwap.values),
        "upper1": _none_for_nan(upper1.values),
        "lower1": _none_for_nan(lower1.values),
        "upper2": _none_for_nan(upper2.values),
        "lower2": _none_for_nan(lower2.values),
        "upper3": _none_for_nan(upper3.values),
        "lower3": _none_for_nan(lower3.values),
        "anchored": anchored,
        "signal": {
            "label": signal,
            "vwap": round(cur_vwap, 2),
            "prevVwap": round(prev_vwap, 2) if prev_vwap is not None else None,
            "prevVwapChangePct": round((cur_vwap - prev_vwap) / prev_vwap * 100, 3) if prev_vwap else None,
            "lastPrice": round(last_price, 2),
            "priceVsVwapPct": round((last_price - cur_vwap) / cur_vwap * 100, 3),
            "bandPosition": band_pos,
            "u1": round(u1, 2), "l1": round(l1, 2),
            "u2": round(u2, 2), "l2": round(l2, 2),
            "u3": round(u3, 2), "l3": round(l3, 2),
            "slopePct": round(slope_pct, 3),
            "slopeLabel": "rising" if slope_pct > 0.01 else "falling" if slope_pct < -0.01 else "flat",
            "volumeRatio": round(vol_ratio, 2),
            "extendedWarning": signal == "EXTENDED",
        },
    }


# =============================================================================
# 2. Ichimoku (full system with 6-condition score)
# =============================================================================

def calculate_ichimoku_full(candles: List[dict]) -> dict:
    df = _df(candles)
    if len(df) < 60:
        return {"error": "need ≥ 60 bars for ichimoku"}

    h, l, c = df["high"], df["low"], df["close"]
    tenkan = (h.rolling(9).max() + l.rolling(9).min()) / 2
    kijun = (h.rolling(26).max() + l.rolling(26).min()) / 2
    span_a_now = (tenkan + kijun) / 2
    span_b_now = (h.rolling(52).max() + l.rolling(52).min()) / 2
    # On-chart we shift forward; for current-bar evaluation we use _now.
    span_a = span_a_now.shift(26)
    span_b = span_b_now.shift(26)
    chikou = c.shift(-26)

    price = float(c.iloc[-1])
    t = float(tenkan.iloc[-1])
    k = float(kijun.iloc[-1])
    sa = float(span_a.iloc[-1]) if pd.notna(span_a.iloc[-1]) else float(span_a_now.iloc[-1])
    sb = float(span_b.iloc[-1]) if pd.notna(span_b.iloc[-1]) else float(span_b_now.iloc[-1])

    # 6-condition checklist.
    cloud_top = max(sa, sb)
    cloud_bot = min(sa, sb)
    cond_price_above_cloud = price > cloud_top
    cond_price_below_cloud = price < cloud_bot
    cond_tk_above_kj = t > k
    # Recent TK cross within last 30 bars.
    diff = tenkan - kijun
    recent = diff.tail(30).dropna()
    fresh_cross = False
    cross_bars_ago = None
    if len(recent) > 1:
        signs = np.sign(recent.values)
        for i in range(len(signs) - 1, 0, -1):
            if signs[i] != signs[i - 1] and signs[i] != 0:
                fresh_cross = True
                cross_bars_ago = len(signs) - i
                break
    cond_chikou_above = bool(chikou.iloc[-27] > c.iloc[-53]) if len(c) > 53 else False
    cond_price_above_tk = price > t
    cond_green_cloud_ahead = float(span_a_now.iloc[-1]) > float(span_b_now.iloc[-1])

    conds = [
        cond_price_above_cloud,
        cond_tk_above_kj,
        fresh_cross,
        cond_chikou_above,
        cond_price_above_tk,
        cond_green_cloud_ahead,
    ]
    score = sum(conds)
    if score >= 5:
        signal = "STRONG BUY"
    elif score >= 4:
        signal = "BUY"
    elif cond_price_below_cloud and not cond_tk_above_kj:
        signal = "SELL"
    elif score <= 1:
        signal = "STRONG SELL"
    else:
        signal = "NEUTRAL"

    return {
        "t": _ms(df.index),
        "tenkan": _none_for_nan(tenkan.values),
        "kijun": _none_for_nan(kijun.values),
        "spanA": _none_for_nan(span_a.values),
        "spanB": _none_for_nan(span_b.values),
        "chikou": _none_for_nan(chikou.values),
        "signal": {
            "label": signal,
            "score": score,
            "outOf": 6,
            "price": round(price, 2),
            "tenkan": round(t, 2),
            "kijun": round(k, 2),
            "spanA": round(sa, 2),
            "spanB": round(sb, 2),
            "cloudColor": "green" if sa > sb else "red",
            "cloudThickness": round(abs(sa - sb), 2),
            "freshTkCross": fresh_cross,
            "crossBarsAgo": cross_bars_ago,
            "conditions": {
                "priceAboveCloud": cond_price_above_cloud,
                "tenkanAboveKijun": cond_tk_above_kj,
                "freshTkCross": fresh_cross,
                "chikouAbove": cond_chikou_above,
                "priceAboveTenkan": cond_price_above_tk,
                "greenCloudAhead": cond_green_cloud_ahead,
            },
        },
    }


# =============================================================================
# 3. SMC / ICT — order blocks, FVGs, BOS, CHoCH, liquidity, premium/discount
# =============================================================================

def _swings(df: pd.DataFrame, k: int = 3):
    highs = df["high"].values
    lows = df["low"].values
    n = len(df)
    sh: List[int] = []
    sl: List[int] = []
    for i in range(k, n - k):
        if all(highs[i] > highs[i - j] for j in range(1, k + 1)) and all(highs[i] > highs[i + j] for j in range(1, k + 1)):
            sh.append(i)
        if all(lows[i] < lows[i - j] for j in range(1, k + 1)) and all(lows[i] < lows[i + j] for j in range(1, k + 1)):
            sl.append(i)
    return sh, sl


def calculate_smc(candles: List[dict]) -> dict:
    df = _df(candles)
    if len(df) < 60:
        return {"error": "need ≥ 60 bars for SMC"}

    sh, sl = _swings(df, k=3)
    highs = df["high"].values
    lows = df["low"].values
    opens = df["open"].values
    closes = df["close"].values
    n = len(df)
    last_close = float(closes[-1])

    # Order blocks: the last down-close candle before a bullish leg (bull OB)
    # and the last up-close candle before a bearish leg (bear OB).
    bull_obs: List[dict] = []
    bear_obs: List[dict] = []
    for idx in sl[-10:]:
        # Find the last bearish candle before this swing low.
        for back in range(idx - 1, max(0, idx - 12), -1):
            if closes[back] < opens[back]:
                bull_obs.append({
                    "barIdx": back,
                    "t": int(df.index[back].value // 1_000_000),
                    "top": float(highs[back]),
                    "bottom": float(lows[back]),
                    "mitigated": last_close < float(lows[back]),
                })
                break
    for idx in sh[-10:]:
        for back in range(idx - 1, max(0, idx - 12), -1):
            if closes[back] > opens[back]:
                bear_obs.append({
                    "barIdx": back,
                    "t": int(df.index[back].value // 1_000_000),
                    "top": float(highs[back]),
                    "bottom": float(lows[back]),
                    "mitigated": last_close > float(highs[back]),
                })
                break
    bull_obs = sorted({ob["barIdx"]: ob for ob in bull_obs}.values(), key=lambda x: x["barIdx"])[-3:]
    bear_obs = sorted({ob["barIdx"]: ob for ob in bear_obs}.values(), key=lambda x: x["barIdx"])[-3:]

    # FVGs: bullish if low[i] > high[i-2]; bearish if high[i] < low[i-2].
    fvgs: List[dict] = []
    for i in range(2, n):
        if lows[i] > highs[i - 2]:
            fvgs.append({
                "type": "bullish",
                "barIdx": i,
                "t": int(df.index[i].value // 1_000_000),
                "top": float(lows[i]),
                "bottom": float(highs[i - 2]),
                "filled": float(closes[-1]) < float(highs[i - 2]) or any(lows[j] < highs[i - 2] for j in range(i + 1, n)),
            })
        elif highs[i] < lows[i - 2]:
            fvgs.append({
                "type": "bearish",
                "barIdx": i,
                "t": int(df.index[i].value // 1_000_000),
                "top": float(lows[i - 2]),
                "bottom": float(highs[i]),
                "filled": float(closes[-1]) > float(lows[i - 2]) or any(highs[j] > lows[i - 2] for j in range(i + 1, n)),
            })
    unfilled_fvgs = [f for f in fvgs if not f["filled"]][-5:]

    # Market structure (HH/HL/LH/LL) using last 6 alternating pivots.
    pivots = sorted(
        [(i, highs[i], "H") for i in sh] + [(i, lows[i], "L") for i in sl],
        key=lambda x: x[0],
    )
    # Keep alternating.
    alt: List = []
    for p in pivots:
        if not alt or alt[-1][2] != p[2]:
            alt.append(p)
        else:
            # Replace if more extreme.
            prev_idx, prev_price, kind = alt[-1]
            if (kind == "H" and p[1] > prev_price) or (kind == "L" and p[1] < prev_price):
                alt[-1] = p
    structure_seq: List[str] = []
    for i in range(1, len(alt)):
        prev_p = alt[i - 1][1]
        cur = alt[i][1]
        kind = alt[i][2]
        if kind == "H":
            structure_seq.append("HH" if cur > prev_p else "LH")
        else:
            structure_seq.append("HL" if cur > prev_p else "LL")
    last_struct = structure_seq[-4:] if structure_seq else []
    if last_struct.count("HH") + last_struct.count("HL") >= 3:
        bias = "BULLISH"
    elif last_struct.count("LL") + last_struct.count("LH") >= 3:
        bias = "BEARISH"
    else:
        bias = "MIXED"

    # Most recent BOS / CHoCH.
    last_bos = None
    last_choch = None
    for i in range(len(structure_seq) - 1, -1, -1):
        if structure_seq[i] in ("HH", "LL") and last_bos is None:
            last_bos = {
                "type": "bullish" if structure_seq[i] == "HH" else "bearish",
                "price": float(alt[i + 1][1]),
                "barIdx": int(alt[i + 1][0]),
                "barsAgo": n - int(alt[i + 1][0]),
            }
        if i > 0 and structure_seq[i] != structure_seq[i - 1] and structure_seq[i] in ("LH", "HL") and last_choch is None:
            last_choch = {
                "type": "bullish" if structure_seq[i] == "HL" else "bearish",
                "price": float(alt[i + 1][1]),
                "barIdx": int(alt[i + 1][0]),
                "barsAgo": n - int(alt[i + 1][0]),
            }
        if last_bos and last_choch:
            break

    # Liquidity: equal highs / equal lows within 0.15%.
    def near(a: float, b: float) -> bool:
        return abs(a - b) / max(a, b, 1e-9) < 0.0015

    ssl = None  # equal highs (sell-side liquidity above)
    bsl = None  # equal lows  (buy-side liquidity below)
    sh_prices = sorted([(highs[i], i) for i in sh[-8:]], key=lambda x: -x[0])
    for i in range(len(sh_prices) - 1):
        if near(sh_prices[i][0], sh_prices[i + 1][0]):
            ssl = {"price": float(sh_prices[i][0]), "touches": 2}
            break
    sl_prices = sorted([(lows[i], i) for i in sl[-8:]], key=lambda x: x[0])
    for i in range(len(sl_prices) - 1):
        if near(sl_prices[i][0], sl_prices[i + 1][0]):
            bsl = {"price": float(sl_prices[i][0]), "touches": 2}
            break

    # Premium/Discount: 50% of most recent swing high → swing low range.
    if sh and sl:
        last_sh = float(highs[sh[-1]])
        last_sl = float(lows[sl[-1]])
        if last_sh > last_sl:
            position_pct = (last_close - last_sl) / (last_sh - last_sl) * 100
        else:
            position_pct = 50.0
    else:
        position_pct = 50.0
    zone = "PREMIUM" if position_pct > 60 else "DISCOUNT" if position_pct < 40 else "EQUILIBRIUM"

    # Aggregate signal.
    bull_score = 0
    bear_score = 0
    if bias == "BULLISH": bull_score += 2
    if bias == "BEARISH": bear_score += 2
    if last_bos and last_bos["type"] == "bullish": bull_score += 1
    if last_bos and last_bos["type"] == "bearish": bear_score += 1
    if last_choch and last_choch["type"] == "bearish" and last_choch["barsAgo"] < 20: bear_score += 1
    if last_choch and last_choch["type"] == "bullish" and last_choch["barsAgo"] < 20: bull_score += 1
    if zone == "DISCOUNT": bull_score += 1
    if zone == "PREMIUM": bear_score += 1
    nearest_bull = min(bull_obs, key=lambda x: abs(last_close - (x["top"] + x["bottom"]) / 2)) if bull_obs else None
    nearest_bear = min(bear_obs, key=lambda x: abs(last_close - (x["top"] + x["bottom"]) / 2)) if bear_obs else None

    if bull_score >= 3 and bull_score > bear_score:
        label = "BUY"
    elif bear_score >= 3 and bear_score > bull_score:
        label = "SELL"
    else:
        label = "NEUTRAL"

    return {
        "t": _ms(df.index),
        "signal": {
            "label": label,
            "structureBias": bias,
            "structureSequence": last_struct,
            "lastBos": last_bos,
            "lastChoch": last_choch,
            "bullOrderBlocks": bull_obs,
            "bearOrderBlocks": bear_obs,
            "nearestBullOb": nearest_bull,
            "nearestBearOb": nearest_bear,
            "unfilledFvgs": unfilled_fvgs,
            "ssl": ssl,
            "bsl": bsl,
            "zone": zone,
            "positionPct": round(position_pct, 1),
            "bullScore": bull_score,
            "bearScore": bear_score,
        },
    }


# =============================================================================
# 4. Order Flow / Delta (estimated from candle range — no tick-level data)
# =============================================================================

def calculate_order_flow(candles: List[dict]) -> dict:
    df = _df(candles)
    if len(df) < 30:
        return {"error": "need ≥ 30 bars for order flow"}

    hl = (df["high"] - df["low"]).replace(0, 1e-6)
    up_mask = df["close"] >= df["open"]
    buy_vol = np.where(up_mask, df["volume"] * (df["close"] - df["low"]) / hl, df["volume"] * (df["high"] - df["close"]) / hl)
    sell_vol = df["volume"].values - buy_vol
    delta = buy_vol - sell_vol
    cum_delta = np.cumsum(delta)

    # Divergences over last 30 bars: price higher-high but cumulative-delta lower-high.
    window = min(30, len(df) - 1)
    last_segment_close = df["close"].iloc[-window:].values
    last_segment_cum = cum_delta[-window:]
    price_change = float(last_segment_close[-1] - last_segment_close[0])
    delta_change = float(last_segment_cum[-1] - last_segment_cum[0])
    divergence = None
    if price_change > 0 and delta_change < 0:
        divergence = {"type": "bearish", "note": "Price up but cumulative delta down — hidden selling"}
    elif price_change < 0 and delta_change > 0:
        divergence = {"type": "bullish", "note": "Price down but cumulative delta up — hidden buying"}

    # Absorption: big price move but opposite delta on the same bar.
    pct_chg = df["close"].pct_change().fillna(0).values
    absorption: List[dict] = []
    for i in range(max(0, len(df) - 20), len(df)):
        if pct_chg[i] > 0.003 and delta[i] < 0:
            absorption.append({"barIdx": int(i), "type": "bullish-up-absorbed", "delta": float(delta[i])})
        elif pct_chg[i] < -0.003 and delta[i] > 0:
            absorption.append({"barIdx": int(i), "type": "bearish-down-absorbed", "delta": float(delta[i])})

    cur_delta = float(delta[-1])
    cur_cum = float(cum_delta[-1])
    cur_buy = float(buy_vol[-1])
    cur_sell = float(sell_vol[-1])
    total = cur_buy + cur_sell
    buy_pct = cur_buy / total * 100 if total > 0 else 50

    # Last 10 bars positive bar count.
    pos_bars = int(sum(1 for d in delta[-10:] if d > 0))
    pos_pct = pos_bars * 10

    if divergence and divergence["type"] == "bearish":
        label = "REVERSAL WATCH (bearish)"
    elif divergence and divergence["type"] == "bullish":
        label = "REVERSAL WATCH (bullish)"
    elif cur_cum > 0 and cur_delta > 0:
        label = "BUYERS IN CONTROL"
    elif cur_cum < 0 and cur_delta < 0:
        label = "SELLERS IN CONTROL"
    else:
        label = "BALANCED"

    return {
        "t": _ms(df.index),
        "delta": [float(x) for x in delta],
        "cumDelta": [float(x) for x in cum_delta],
        "signal": {
            "label": label,
            "currentDelta": round(cur_delta, 2),
            "cumulativeDelta": round(cur_cum, 2),
            "buyVolume": round(cur_buy, 2),
            "sellVolume": round(cur_sell, 2),
            "buyPct": round(buy_pct, 1),
            "sellPct": round(100 - buy_pct, 1),
            "positivePctLast10": pos_pct,
            "divergence": divergence,
            "absorption": absorption[-3:],
        },
    }


# =============================================================================
# 5. Market Profile / TPO — daily POC/VAH/VAL/HVN/LVN/IB
# =============================================================================

def calculate_market_profile(candles: List[dict]) -> dict:
    df = _df(candles)
    if len(df) < 30:
        return {"error": "need ≥ 30 bars for market profile"}

    df = df.copy()
    df["session"] = df.index.date
    today = df["session"].iloc[-1]
    today_df = df[df["session"] == today]
    if len(today_df) < 5:
        # Fall back to last 60 bars when today's session is too small.
        today_df = df.tail(60)

    # Auto price step = ATR / 10, rounded to 0.05 minimum.
    atr_proxy = (today_df["high"] - today_df["low"]).mean()
    step = max(0.05, round(atr_proxy / 10, 2))

    # TPO count per price level using 30-min periods (proxy: groups of 30 bars).
    period_size = max(1, len(today_df) // 13)  # roughly A..L
    tpo_count: Dict[float, set] = {}
    for i, (_, row) in enumerate(today_df.iterrows()):
        period_letter = chr(65 + min(12, i // period_size))
        lo = round(row["low"] / step) * step
        hi = round(row["high"] / step) * step
        level = lo
        while level <= hi + 1e-6:
            level = round(level, 2)
            tpo_count.setdefault(level, set()).add(period_letter)
            level += step

    if not tpo_count:
        return {"error": "no levels"}

    tpo = {p: len(periods) for p, periods in tpo_count.items()}
    poc_price = max(tpo, key=tpo.get)

    # Value Area = 70% of total TPO.
    total = sum(tpo.values())
    va_target = total * 0.70
    sorted_levels = sorted(tpo.items(), key=lambda x: x[1], reverse=True)
    va_prices = [sorted_levels[0][0]]
    va_acc = sorted_levels[0][1]
    i = 1
    while va_acc < va_target and i < len(sorted_levels):
        va_prices.append(sorted_levels[i][0])
        va_acc += sorted_levels[i][1]
        i += 1
    vah = max(va_prices)
    val = min(va_prices)

    p80 = np.percentile(list(tpo.values()), 80)
    p20 = np.percentile(list(tpo.values()), 20)
    hvn = sorted([p for p, c in tpo.items() if c >= p80 and p != poc_price])
    lvn = sorted([p for p, c in tpo.items() if c <= p20])

    # Initial Balance (first 2 periods).
    ib_count = period_size * 2
    ib_df = today_df.head(ib_count)
    ib_high = float(ib_df["high"].max()) if len(ib_df) else 0
    ib_low = float(ib_df["low"].min()) if len(ib_df) else 0

    last_price = float(df["close"].iloc[-1])
    if last_price > vah:
        position, label = "ABOVE VAH", "BUY"
    elif last_price < val:
        position, label = "BELOW VAL", "SELL"
    elif abs(last_price - poc_price) / poc_price < 0.001:
        position, label = "AT POC", "NEUTRAL"
    else:
        position, label = "INSIDE VALUE AREA", "NEUTRAL"

    # Profile shape heuristic.
    upper_half = sum(c for p, c in tpo.items() if p > poc_price)
    lower_half = sum(c for p, c in tpo.items() if p < poc_price)
    if upper_half > lower_half * 1.4:
        shape = "P-SHAPED"
    elif lower_half > upper_half * 1.4:
        shape = "b-SHAPED"
    elif len(hvn) >= 2 and (max(hvn) - min(hvn)) / poc_price > 0.01:
        shape = "DOUBLE DISTRIBUTION"
    else:
        shape = "NORMAL"

    return {
        "signal": {
            "label": label,
            "poc": round(poc_price, 2),
            "vah": round(vah, 2),
            "val": round(val, 2),
            "vaWidthPct": round((vah - val) / poc_price * 100, 2),
            "ibHigh": round(ib_high, 2),
            "ibLow": round(ib_low, 2),
            "ibWidth": round(ib_high - ib_low, 2),
            "hvn": [round(p, 2) for p in hvn[-3:]],
            "lvn": [round(p, 2) for p in lvn[-3:]],
            "position": position,
            "shape": shape,
            "priceStep": step,
            "lastPrice": round(last_price, 2),
        },
    }
