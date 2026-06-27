"""Chan Advisor — rule-based encoding of Ernest Chan's algorithmic-trading
playbook plus the 22 strategies enumerated in the system prompt.

Public surface:

    regime.detect_regime(df)         → MarketRegime dataclass
    strategies.STRATEGIES            → list of StrategySpec
    advisor.recommend(df, symbol)    → AdvisorRecommendation
    psychology.emotional_check(reg, side) → str  (rule-based warning)
    kelly.kelly_fraction(sharpe, ret) → float
"""
from .regime import detect_regime, MarketRegime
from .advisor import recommend, AdvisorRecommendation
from .strategies import STRATEGIES

__all__ = [
    "detect_regime", "MarketRegime",
    "recommend", "AdvisorRecommendation",
    "STRATEGIES",
]
