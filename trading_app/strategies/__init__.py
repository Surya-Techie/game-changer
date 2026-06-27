"""Strategy package — exports all strategies."""
from .base_strategy        import BaseStrategy
from .orb                  import OpeningRangeBreakout
from .vwap_scalp           import VWAPMomentumScalp
from .gap_and_go           import GapAndGo
from .supertrend_ema       import SupertrendEMAScalp
from .rsi_divergence       import RSIDivergenceReversal
from .volume_breakout      import VolumeBreakout
from .master_strategy      import MasterConfluence
from .book_strategies      import (
    SymmetricalTriangle,
    AscendingTriangle,
    RisingWedgeShort,
    DoubleTopMinor,
    BOOK_STRATEGIES,
)

ALL_STRATEGIES = [
    OpeningRangeBreakout,
    VWAPMomentumScalp,
    GapAndGo,
    SupertrendEMAScalp,
    RSIDivergenceReversal,
    VolumeBreakout,
    MasterConfluence,
] + BOOK_STRATEGIES

# fast name → class lookup used by the dashboard and the CLI
STRAT_MAP = {c.__name__: c for c in ALL_STRATEGIES}

# numbered list used by the Pattern Analysis page
NUMBERED_STRATEGIES = [
    ("Strategy 1",  "OpeningRangeBreakout",   "ORB — Opening Range Breakout"),
    ("Strategy 2",  "VWAPMomentumScalp",      "VWAP Momentum Scalp"),
    ("Strategy 3",  "GapAndGo",               "Gap & Go"),
    ("Strategy 4",  "SupertrendEMAScalp",     "Supertrend + EMA Stack"),
    ("Strategy 5",  "RSIDivergenceReversal",  "RSI Divergence Reversal"),
    ("Strategy 6",  "VolumeBreakout",         "Volume / Tight-Range Breakout"),
    ("Strategy 7",  "MasterConfluence",       "Master Confluence (8-vote)"),
    ("Strategy 8",  "SymmetricalTriangle",    "📘 Book — Symmetrical Triangle"),
    ("Strategy 9",  "AscendingTriangle",      "📘 Book — Ascending Triangle"),
    ("Strategy 10", "RisingWedgeShort",       "📘 Book — Rising Wedge Short"),
    ("Strategy 11", "DoubleTopMinor",         "📘 Book — Double Top Minor"),
]

__all__ = [
    "BaseStrategy",
    "OpeningRangeBreakout", "VWAPMomentumScalp", "GapAndGo",
    "SupertrendEMAScalp", "RSIDivergenceReversal", "VolumeBreakout",
    "MasterConfluence",
    "SymmetricalTriangle", "AscendingTriangle",
    "RisingWedgeShort", "DoubleTopMinor",
    "BOOK_STRATEGIES", "ALL_STRATEGIES",
    "STRAT_MAP", "NUMBERED_STRATEGIES",
]
