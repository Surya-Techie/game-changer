"""
Trading App — Global Configuration
Single source of truth for capital, risk, timings, universe.
"""
from datetime import time
from pathlib import Path

# ── ACCOUNT ────────────────────────────────────────────────────
CAPITAL = 100_000           # ₹1,00,000 starting capital
CURRENCY = "INR"
MARKET = "NSE"

# ── DAILY GOALS / GUARDRAILS ───────────────────────────────────
DAILY_PROFIT_TARGET = 0.05  # +5% → stop trading for the day
MAX_DAILY_LOSS      = 0.02  # -2% → hard stop for the day
MAX_RISK_PER_TRADE  = 0.01  # 1% capital risk per trade
MAX_OPEN_TRADES     = 2     # never more than 2 simultaneous
MAX_CONSEC_LOSSES   = 3     # 3 losses → take a break

# ── INTRADAY TIME RULES (IST) ──────────────────────────────────
MARKET_OPEN   = time(9, 15)
MARKET_CLOSE  = time(15, 30)
ORB_END       = time(9, 30)   # 15-min opening range
NO_NEW_ENTRY  = time(14, 30)  # 2:30 PM — no fresh entries
FORCE_CLOSE   = time(15, 15)  # 3:15 PM — flatten everything
AVOID_FIRST_5 = time(9, 20)   # except Gap & Go

# ── COSTS ──────────────────────────────────────────────────────
SLIPPAGE_PCT   = 0.0005   # 0.05% per side
COMMISSION_PCT = 0.001    # 0.1% per trade

# ── UNIVERSE ───────────────────────────────────────────────────
# NOTE: TATAMOTORS.NS and ZOMATO.NS were removed/renamed on Yahoo
#   (Zomato → ETERNAL.NS in 2025; Tata Motors data unavailable).
# Substituted with TATASTEEL.NS and ETERNAL.NS.
NSE_STOCKS = [
    "RELIANCE.NS", "TATASTEEL.NS", "ETERNAL.NS",
    "ADANIENT.NS", "SUZLON.NS",
]
CRYPTO    = ["BTC-USD", "ETH-USD", "SOL-USD"]
BENCHMARK = "^NSEI"   # Nifty 50

# ── DATA ───────────────────────────────────────────────────────
DEFAULT_INTERVAL_EQUITY = "5m"
DEFAULT_INTERVAL_CRYPTO = "1h"
LOOKBACK_DAYS_5M  = 30      # yfinance limit on 5m
LOOKBACK_DAYS_1H  = 720
LOOKBACK_DAYS_1D  = 730

# ── PATHS ──────────────────────────────────────────────────────
ROOT      = Path(__file__).resolve().parent
DATA_DIR  = ROOT / "_cache"
RESULTS   = ROOT / "_results"
DATA_DIR.mkdir(exist_ok=True)
RESULTS.mkdir(exist_ok=True)

# ── BACKTEST ───────────────────────────────────────────────────
TRAIN_PCT       = 0.70
MONTE_CARLO_RUNS = 500
RANDOM_SEED     = 42

# ── DASHBOARD ──────────────────────────────────────────────────
THEME = {
    "bg":     "#0d1117",
    "card":   "#161b22",
    "accent": "#00ff88",
    "red":    "#ff4d4d",
    "text":   "#c9d1d9",
}

# ── STRATEGY REGISTRY ──────────────────────────────────────────
STRATEGY_REGISTRY = [
    "OpeningRangeBreakout",
    "VWAPMomentumScalp",
    "GapAndGo",
    "SupertrendEMAScalp",
    "RSIDivergenceReversal",
    "VolumeBreakout",
    "MasterConfluence",
    # Book strategies
    "SymmetricalTriangle",
    "AscendingTriangle",
    "RisingWedgeShort",
    "DoubleTopMinor",
]
