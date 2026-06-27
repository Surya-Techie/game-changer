"""Strategy registry — all 22 strategies from the Chan/Brandt prompt.

Each StrategySpec carries:
  • code              ID from the prompt (MR-1..11, MOM-1..9, HYB-1..2)
  • category          "MEAN_REVERSION" | "MOMENTUM" | "HYBRID"
  • title             short human-readable name
  • signal_template   parameterised entry/exit/sizing description
  • when_to_use       gating conditions (band, trend, hurst, etc.)
  • risk_block        stop/leverage/sizing notes from Section D
  • emotional_check   which Section A rule applies most

advisor.recommend() picks the highest-scoring strategy for the current
regime — see chan_advisor.advisor for the scoring logic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class StrategySpec:
    code: str
    category: str
    title: str
    signal_template: str
    when_to_use: str
    risk_block: str
    emotional_check: str
    stationarity_required: bool = False
    bands: tuple[str, ...] = field(default_factory=lambda: ("CALM", "NORMAL", "ELEVATED", "CRISIS"))
    trend_states: tuple[str, ...] = field(default_factory=lambda: ("UP", "DOWN", "RANGE"))
    base_score: float = 50.0


# ── MEAN REVERSION ────────────────────────────────────────────────────
MR = [
    StrategySpec(
        code="MR-3", category="MEAN_REVERSION",
        title="Linear Z-Score (parameterless)",
        signal_template="position = -Z × scaling_factor where Z = (close - SMA20) / std20",
        when_to_use="Stationary series, low VIX, no strong trend",
        risk_block="No stop loss — use hard max position size (R-1). Scale-in as |Z| grows (P-5).",
        emotional_check="Loss aversion: position grows as it moves against you — that's the design (Rule 1).",
        stationarity_required=True,
        bands=("CALM", "NORMAL"),
        trend_states=("RANGE",),
        base_score=60,
    ),
    StrategySpec(
        code="MR-4", category="MEAN_REVERSION",
        title="Bollinger Band Reversal",
        signal_template="Short when close > SMA20+2σ; Long when close < SMA20-2σ; Exit at SMA20",
        when_to_use="Stationary, range-bound markets (R-4: VIX < 20)",
        risk_block="No stop, hard max position size. Half-Kelly leverage (P-2).",
        emotional_check="Rule 3: do NOT override during a 'painful' band hold. Bands work because they're sometimes painful.",
        stationarity_required=True,
        bands=("CALM", "NORMAL"),
        trend_states=("RANGE",),
        base_score=58,
    ),
    StrategySpec(
        code="MR-7", category="MEAN_REVERSION",
        title="Cross-Sectional Mean Reversion (basket)",
        signal_template="Rank universe by 5d return; long bottom decile, short top decile; daily rebalance",
        when_to_use="Any large basket — no stationarity test required",
        risk_block="Beta-neutral by construction. Position cap ~3% per name. Sharpe-driven Kelly sizing.",
        emotional_check="Stay mechanical — rebalancing means selling yesterday's winners (Rule 4).",
        bands=("CALM", "NORMAL", "ELEVATED"),
        trend_states=("UP", "DOWN", "RANGE"),
        base_score=55,
    ),
    StrategySpec(
        code="MR-8", category="MEAN_REVERSION",
        title="ETF Pairs Trading (cointegrated)",
        signal_template="Spread = ETF_A - h × ETF_B; entry |Z|>1.5, exit Z=0; h from Johansen",
        when_to_use="Use ETFs sharing fundamentals (EWA/EWC, GLD/GDX, XLE/USO)",
        risk_block="Exit on cointegration breakdown — not a price stop (R-1). Avoid futures-backed ETFs.",
        emotional_check="If both legs are losing, cointegration may have broken — check, don't override.",
        stationarity_required=True,
        bands=("CALM", "NORMAL"),
        base_score=52,
    ),
    StrategySpec(
        code="MR-9", category="MEAN_REVERSION",
        title="VX-ES Spread (VIX futures vs S&P)",
        signal_template="Spread = VX - h × ES; short VX & long ES when spread Z > 2",
        when_to_use="Fear spike events; works well in regime ELEVATED",
        risk_block="Small allocation (5–10%). Tail-risk fund. Half-Kelly.",
        emotional_check="Volatility spikes hurt before they help. Hold through the spike.",
        bands=("ELEVATED", "CRISIS"),
        base_score=50,
    ),
    StrategySpec(
        code="MR-10", category="MEAN_REVERSION",
        title="Intraday Stock Mean Reversion (no-news filter)",
        signal_template="Z = (now - open)/std; long Z<-1, short Z>+1; flat by close",
        when_to_use="Liquid stocks with NO scheduled news that day",
        risk_block="Close all positions before close. No overnight risk.",
        emotional_check="Skip stocks with news — sentiment trumps stats intraday.",
        bands=("CALM", "NORMAL"),
        base_score=48,
    ),
    StrategySpec(
        code="MR-11", category="MEAN_REVERSION",
        title="Modified Index Arbitrage",
        signal_template="Trade spread between top-50 cointegrating stocks and the index future",
        when_to_use="When you can scan the entire NIFTY for highest-cointegration subset",
        risk_block="Hedge ratio drift — refit weekly. Capital intensive.",
        emotional_check="Edge is thin; let the model run, don't second-guess.",
        bands=("CALM", "NORMAL"),
        base_score=45,
    ),
]

# ── MOMENTUM ──────────────────────────────────────────────────────────
MOM = [
    StrategySpec(
        code="MOM-3", category="MOMENTUM",
        title="Futures Roll Return Momentum",
        signal_template="Roll = (front - back)/front × 252/days; long if positive, short if negative",
        when_to_use="Futures with persistent backwardation/contango (commodities, vol futures)",
        risk_block="Stop at 1–2× target. Diversify across asset classes.",
        emotional_check="Trend-following = many small losses, few large wins. Expect it.",
        bands=("NORMAL", "ELEVATED", "CRISIS"),
        base_score=58,
    ),
    StrategySpec(
        code="MOM-4", category="MOMENTUM",
        title="News Sentiment Momentum (1–5 day hold)",
        signal_template="Long after positive surprise (earnings beat, upgrade); short on negative",
        when_to_use="Stocks with fresh news; effect strongest first 24h, fades by day 5",
        risk_block="Stop at -2× ATR. Exit by day 5 regardless.",
        emotional_check="Don't chase late — late entries get the fade, not the move.",
        bands=("CALM", "NORMAL", "ELEVATED"),
        base_score=55,
    ),
    StrategySpec(
        code="MOM-5", category="MOMENTUM",
        title="Leveraged ETF Rebalancing (close-30min)",
        signal_template="On |index_return| > 1% buy/short the underlying 30–60min before close, flat at close",
        when_to_use="Big intraday move in a high-AUM 2x/3x ETF (TQQQ, UPRO equivalents)",
        risk_block="Size from AUM × return × (leverage-1). Slippage matters.",
        emotional_check="Last-30min trade — execution discipline beats discretion.",
        bands=("NORMAL", "ELEVATED"),
        base_score=52,
    ),
    StrategySpec(
        code="MOM-6", category="MOMENTUM",
        title="Opening Gap Continuation (futures/FX)",
        signal_template="Gap > 0.1σ of 90d returns → trade in gap direction, hold intraday",
        when_to_use="Index/FX futures only — stocks tend to fill gaps (reverse rule)",
        risk_block="ATR-based stop. Day-trade — flat at close.",
        emotional_check="Gap reversers feel smarter but lose more often in futures.",
        bands=("CALM", "NORMAL", "ELEVATED"),
        base_score=50,
    ),
    StrategySpec(
        code="MOM-8", category="MOMENTUM",
        title="Cross-Sectional Futures Momentum",
        signal_template="Rank universe by 1m or 12m return; long top quartile, short bottom",
        when_to_use="Multi-asset futures portfolio; rebalance monthly",
        risk_block="Diversification is the risk control. Vol-target the portfolio.",
        emotional_check="Long horizon — review only monthly, ignore intra-month noise.",
        bands=("CALM", "NORMAL", "ELEVATED", "CRISIS"),
        base_score=55,
    ),
    StrategySpec(
        code="MOM-9", category="MOMENTUM",
        title="Index Composition Change",
        signal_template="Long stocks announced for inclusion; short removals; hold through effective date",
        when_to_use="Around NIFTY/SENSEX semi-annual reviews",
        risk_block="Event-driven — position cap per name. Exit a week after effective date.",
        emotional_check="Forced flows are mechanical — trust the structural driver.",
        bands=("CALM", "NORMAL"),
        base_score=48,
    ),
]

# ── HYBRID ────────────────────────────────────────────────────────────
HYB = [
    StrategySpec(
        code="HYB-1", category="HYBRID",
        title="Trend-Filtered Mean Reversion",
        signal_template="If 200d SMA rising → only LONG MR entries; if falling → only SHORT MR entries",
        when_to_use="Default upgrade on top of any MR strategy",
        risk_block="Same risk profile as base MR strategy.",
        emotional_check="Skipping the wrong-side trade always feels like missing out. Don't.",
        bands=("CALM", "NORMAL", "ELEVATED"),
        base_score=62,
    ),
    StrategySpec(
        code="HYB-2", category="HYBRID",
        title="Regime-Based Strategy Switching",
        signal_template="VIX<20: MR; VIX 20-30: balanced 50/50; VIX>30: MOM only + reduce size",
        when_to_use="Portfolio-level allocation, not individual signals",
        risk_block="Smoothest equity curve — MR & MOM negatively correlate in crisis.",
        emotional_check="Switching feels wrong when the dead strategy 'almost worked'. Switch anyway.",
        bands=("CALM", "NORMAL", "ELEVATED", "CRISIS"),
        base_score=65,
    ),
]

STRATEGIES: List[StrategySpec] = MR + MOM + HYB
STRATEGIES_BY_CODE = {s.code: s for s in STRATEGIES}
