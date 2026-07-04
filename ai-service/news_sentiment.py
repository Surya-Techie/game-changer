"""Live news-sentiment signal — real headlines, honestly labelled.

What this IS:
  • A real, current sentiment read per symbol. It pulls recent headlines
    (yfinance news), scores each with the lexicon classifier (sentiment.py),
    and aggregates them with recency weighting into one score in [-1, 1].

What this is NOT (read this before trusting it as alpha):
  • A backtested edge. We deliberately do NOT fold this into the ML model's
    features, because there is no free archive of *historical, timestamped*
    news for these symbols — so its predictive value CANNOT be measured
    out-of-sample the way price features were (see ml_training.py notes).
    Treating an un-backtested signal as validated edge is exactly the trap
    the rest of this codebase avoids. It is a CONTEXT signal: useful for a
    human glance, not a license to size a position.
  • Relevance-perfect. Headline relevance is best-effort (title/summary
    mention of the symbol root). Some items will be off-target (e.g. a
    different "SBI"); `relevant_count` exposes how many actually matched.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import List, Optional

from sentiment import classify

# Half-life (hours) for recency weighting — a 1-day-old headline counts half
# as much as a fresh one. News decays fast; week-old items barely register.
RECENCY_HALF_LIFE_H = 24.0
MAX_ITEMS = 20


def _parse_ts(pub: Optional[str]) -> Optional[int]:
    if not pub:
        return None
    try:
        dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def fetch_news(symbol: str) -> List[dict]:
    """Pull recent headlines for a symbol. Returns [] on any failure rather
    than raising, so a news outage never takes down the caller."""
    try:
        import yfinance as yf  # lazy — network/dep only when actually used
        raw = yf.Ticker(symbol).news or []
    except Exception:
        return []
    out: List[dict] = []
    for it in raw[:MAX_ITEMS]:
        c = it.get("content", it) if isinstance(it, dict) else {}
        title = (c.get("title") or "").strip()
        if not title:
            continue
        out.append({
            "title": title,
            "summary": (c.get("summary") or c.get("description") or "").strip(),
            "ts": _parse_ts(c.get("pubDate") or c.get("displayTime")),
            "provider": ((c.get("provider") or {}).get("displayName") or "").strip(),
            "url": (c.get("canonicalUrl") or {}).get("url") if isinstance(c.get("canonicalUrl"), dict) else None,
        })
    return out


def _recency_weight(ts_ms: Optional[int], now_ms: int) -> float:
    if not ts_ms:
        return 0.5  # unknown age — count it, but at half weight
    age_h = max(0.0, (now_ms - ts_ms) / 3_600_000)
    return 0.5 ** (age_h / RECENCY_HALF_LIFE_H)


def analyze_symbol(symbol: str, aliases: Optional[List[str]] = None) -> dict:
    """Aggregate a recency-weighted sentiment signal for `symbol`.

    aliases: extra strings (company name words) used only for the relevance
    count — they do NOT filter, so the score stays transparent.
    """
    root = symbol.upper().replace(".NS", "").replace(".BO", "")
    match_terms = {root.lower(), *[a.lower() for a in (aliases or [])]}
    items = fetch_news(symbol)
    now_ms = int(time.time() * 1000)

    if not items:
        return {
            "symbol": root, "label": "NEUTRAL", "score": 0.0,
            "n_headlines": 0, "relevant_count": 0, "freshness_h": None,
            "headlines": [],
            "disclaimer": "No headlines available. Live signal only — not a backtested edge.",
        }

    scored = []
    wsum = 0.0
    acc = 0.0
    relevant = 0
    newest_ts = 0
    for it in items:
        text = f"{it['title']} {it['summary']}".strip()
        s = classify(text)
        w = _recency_weight(it["ts"], now_ms)
        acc += s["score"] * w
        wsum += w
        if it["ts"]:
            newest_ts = max(newest_ts, it["ts"])
        is_rel = any(term in text.lower() for term in match_terms)
        relevant += 1 if is_rel else 0
        scored.append({
            "title": it["title"], "provider": it["provider"], "ts": it["ts"],
            "url": it["url"], "label": s["label"], "score": s["score"],
            "relevant": is_rel,
        })

    score = round(acc / wsum, 3) if wsum > 0 else 0.0
    label = "POSITIVE" if score > 0.12 else "NEGATIVE" if score < -0.12 else "NEUTRAL"
    freshness_h = round((now_ms - newest_ts) / 3_600_000, 1) if newest_ts else None
    # Confidence shrinks with few or low-relevance headlines, and with stale
    # news — an honest "how much should you weight this" number in [0,1].
    rel_frac = relevant / len(scored)
    vol_factor = min(1.0, len(scored) / 8.0)
    fresh_factor = 1.0 if freshness_h is None else 0.5 ** (freshness_h / 48.0)
    confidence = round(min(1.0, rel_frac * vol_factor * fresh_factor), 3)

    return {
        "symbol": root,
        "label": label,
        "score": score,                 # recency-weighted, [-1, 1]
        "confidence": confidence,        # [0,1] — trust weight, NOT alpha
        "n_headlines": len(scored),
        "relevant_count": relevant,
        "freshness_h": freshness_h,
        "headlines": sorted(scored, key=lambda h: h["ts"] or 0, reverse=True)[:10],
        "disclaimer": (
            "Live sentiment signal from real headlines. NOT a backtested "
            "edge — no historical news archive exists to validate it. Use as "
            "context, not as a position-sizing input."
        ),
    }
