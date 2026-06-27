"""Strategy-selection engine.

Given a symbol's OHLCV history, the advisor:
  1. Detects the market regime
  2. Scores every StrategySpec for fit against that regime
  3. Returns the top-3 ranked strategies + a structured 5-section response
     matching Section E of the system prompt
     (Regime → Strategy → Signal → Risk → Emotional check)
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import List, Optional

import numpy as np
import pandas as pd

from .regime import MarketRegime, detect_regime
from .strategies import STRATEGIES, StrategySpec, STRATEGIES_BY_CODE
from .kelly import annualized_sharpe, kelly_fraction, years_for_significance
from .psychology import emotional_check


@dataclass
class ScoredStrategy:
    code: str
    title: str
    category: str
    fit_score: float        # 0-100, how well it fits current regime
    signal: str
    when_to_use: str
    risk_block: str


@dataclass
class AdvisorRecommendation:
    symbol: str
    regime: dict
    primary: ScoredStrategy
    alternates: List[ScoredStrategy]
    sharpe_60d: float
    kelly_half: float
    years_for_sig: float
    emotional_check: str
    response_5section: str   # ready-to-display markdown


def _score_strategy(s: StrategySpec, reg: MarketRegime) -> float:
    """Score how well strategy `s` fits the current regime."""
    score = s.base_score

    # Band match (R-4 leverage bands)
    if reg.band in s.bands:
        score += 15
    else:
        score -= 25

    # Trend match
    if reg.trend in s.trend_states:
        score += 8
    else:
        score -= 12

    # Stationarity requirement (MR-1)
    if s.stationarity_required and not reg.is_stationary:
        score -= 35

    # Category-regime alignment (HYB-2)
    style = reg.favored_style
    if style == "MEAN_REVERSION" and s.category == "MEAN_REVERSION": score += 12
    if style == "MOMENTUM"       and s.category == "MOMENTUM":       score += 12
    if style == "BALANCED"       and s.category == "HYBRID":         score += 10
    if style == "REDUCE":
        # In crisis: only momentum / hedge strategies stay viable.
        if s.category != "MOMENTUM":
            score -= 30

    # Trend filter helps in trending markets.
    if s.code == "HYB-1" and reg.adx_14 > 22:
        score += 10

    # Range compression boosts breakout-style momentum.
    if reg.range_pct < 5 and s.category == "MOMENTUM":
        score += 5

    return max(0.0, min(100.0, score))


def _format_5section(symbol: str, reg: MarketRegime, primary: ScoredStrategy,
                     sharpe: float, kelly: float, emotion: str) -> str:
    """Render the Section-E structured response as markdown."""
    lev_pct = int(reg.leverage_haircut * 100)
    return (
f"""**1. REGIME CHECK**
Realized vol {reg.realized_vol_pct:.1f}% (band: {reg.band}), trend: {reg.trend}, ADX {reg.adx_14:.1f}, Hurst {reg.hurst:.2f} → {'mean-reverting' if reg.is_stationary else 'trending/random-walk'}. Leverage haircut {lev_pct}% per R-4.

**2. STRATEGY TYPE**
{primary.category.replace('_', ' ').title()} — *{primary.title}* (code {primary.code}).

**3. EXACT SIGNAL**
{primary.signal}

**4. RISK PARAMETERS**
{primary.risk_block}
• Recent 60-day Sharpe of {symbol}: {sharpe:.2f}
• Half-Kelly fraction (from 60d returns): {kelly:.2f}
• Years for 5% significance: {years_for_significance(sharpe):.1f}

**5. EMOTIONAL CHECK**
{emotion}
"""
    )


def recommend(df: pd.DataFrame, symbol: str,
              vix: Optional[float] = None) -> AdvisorRecommendation:
    """Top-level entrypoint. Returns full recommendation for `symbol`."""
    reg = detect_regime(df, vix=vix)

    # Score every strategy.
    scored = []
    for s in STRATEGIES:
        fit = _score_strategy(s, reg)
        scored.append(ScoredStrategy(
            code=s.code, title=s.title, category=s.category,
            fit_score=round(fit, 1),
            signal=s.signal_template,
            when_to_use=s.when_to_use,
            risk_block=s.risk_block,
        ))
    scored.sort(key=lambda x: x.fit_score, reverse=True)
    primary = scored[0]
    alternates = scored[1:4]

    # Recent stats on the symbol itself.
    rets = df["close"].pct_change().dropna().tail(60)
    sharpe = annualized_sharpe(rets)
    kelly  = kelly_fraction(rets)
    emo    = emotional_check(reg, primary.category)

    response = _format_5section(symbol, reg, primary, sharpe, kelly, emo)

    return AdvisorRecommendation(
        symbol=symbol.upper(),
        regime=asdict(reg),
        primary=primary,
        alternates=alternates,
        sharpe_60d=round(sharpe, 3),
        kelly_half=round(kelly, 4),
        years_for_sig=round(years_for_significance(sharpe), 2),
        emotional_check=emo,
        response_5section=response,
    )
