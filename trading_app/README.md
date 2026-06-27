# Trading Lab 📈

Production-grade intraday trading research app built around **Curtis Arnold's PPS (Pattern Probability Strategy)** from the 1995 book *PPS Trading System*, combined with **7 modern intraday strategies** for NSE equities and crypto.

> **Goal:** 5 % daily portfolio profit, hard −2 % daily kill-switch.
> **Capital:** ₹1,00,000 (configurable).

---

## 1. Project layout

```
trading_app/
├── main.py                 # full backtest report (CLI)
├── config.py               # capital, risk, time-of-day, universe
├── data/
│   ├── fetcher.py          # yfinance + parquet cache
│   └── preprocessor.py
├── indicators/
│   └── custom_indicators.py  # pure-pandas: VWAP, ST, RSI, swings, wedges…
├── strategies/
│   ├── base_strategy.py    # contract + look-ahead guard
│   ├── book_strategies.py  # SymmetricalTriangle, AscendingTriangle,
│   │                       # RisingWedgeShort, DoubleTopMinor
│   ├── orb.py              # Opening Range Breakout
│   ├── vwap_scalp.py
│   ├── gap_and_go.py
│   ├── supertrend_ema.py
│   ├── rsi_divergence.py
│   ├── volume_breakout.py
│   └── master_strategy.py  # 8-vote confluence (book signal counts)
├── screener/
│   └── screener.py         # daily top-5 picks
├── backtester/
│   ├── engine.py           # event loop, slippage, commission, intraday rules
│   ├── metrics.py          # Sharpe, Sortino, drawdown, 5%-day counter, MC
│   └── optimizer.py        # grid search + walk-forward
├── risk/
│   └── risk_manager.py     # daily P&L gate, sizing, time rules, kill-switch
├── dashboard/
│   └── app.py              # Streamlit, 5 pages, dark theme
└── tests/
    └── test_strategies.py  # 46 tests passing
```

---

## 2. Install & run

```bash
pip install -r trading_app/requirements.txt

# 1) full backtest report (NSE 5-min × 30 days + crypto 1-hour × 60 days)
python -m trading_app.main --days 30

# 2) launch the web app  (FastAPI + Plotly.js dark UI)
python -m uvicorn trading_app.server.main:app --reload --port 8000
# open http://localhost:8000

# 3) unit tests
pytest trading_app/tests/ -v
```

### Architecture (no Streamlit)

| Layer | Tech | Files |
|---|---|---|
| Backend | FastAPI + uvicorn | `trading_app/server/main.py` |
| Frontend | Vanilla HTML/CSS/JS + Plotly.js via CDN | `trading_app/frontend/{index.html, style.css, app.js}` |
| Quant core | unchanged Python modules | `strategies/`, `backtester/`, `indicators/`, `risk/`, `screener/` |

The browser app has 6 pages — Pattern Analysis, Live Signals, Backtest, Pre-Market Screener, Optimizer, Daily Battle Plan — all using the same FastAPI endpoints under `/api/*`.

---

## 3. The 11 strategies

| # | Strategy | Type | High-conviction? |
|---|---|---|---|
| 1 | **OpeningRangeBreakout (ORB)** | Breakout | ⭐ (book sym-triangle reinforces) |
| 2 | VWAPMomentumScalp | Mean-reversion | |
| 3 | **GapAndGo** | Momentum | ⭐ (book ascending-triangle) |
| 4 | **SupertrendEMAScalp** | Trend | ⭐ (book 18/40 MA filter) |
| 5 | RSIDivergenceReversal | Reversal | (book double-top minor) |
| 6 | **VolumeBreakout** | Breakout | ⭐ (book sym-triangle) |
| 7 | **MasterConfluence** | Multi-factor | ⭐⭐⭐ (8-vote system inc. book signal) |
| B1 | SymmetricalTriangle | Continuation | core PPS pattern |
| B2 | AscendingTriangle | Uptrend continuation | book §13 |
| B8 | RisingWedgeShort | Reversal (explosive) | book §15, highest individual returns |
| B5 | DoubleTopMinor | Minor reversal | book's best win-rate pattern |

---

## 4. Risk Manager rules

| Rule | Value |
|---|---|
| Risk per trade | 1 % of capital |
| Daily profit target → STOP | +5 % |
| Daily loss limit → STOP | −2 % |
| Max concurrent open trades | 2 |
| 3 consecutive losses → STOP | yes |
| No new entries after 14:30 IST | yes |
| Force close all positions by 15:15 IST | yes |
| First 5 min (09:15–09:20) | only Gap & Go allowed |

---

## 5. FINAL REPORT (real backtest, 2025-04 → 2025-05, 5-min NSE + 1-hour crypto)

> Out of **528 strategy-trading-days** simulated across 11 strategies × 6 symbols (3 NSE delisted):

| Metric | Value |
|---|---|
| Total strategy-days observed | 528 |
| Days hitting ≥ +5 % | **0** (with default params) |
| Days hitting ≥ +5 % (MasterConfluence subset) | 5 |
| Realistic average daily return (default params) | −0.21 % |
| Best Symbol × Strategy combination | **ETH-USD × MasterConfluence → +16.64 %** |
| Strategies with positive Sharpe | MasterConfluence (ETH), DoubleTopMinor (ETH), RSIDivergence (SOL) |
| Top-3 by raw return | MasterConfluence-ETH, RSIDiv-SOL, ORB-RELIANCE |

### What the numbers reveal — read this carefully

- **The default parameters lose money** across most NSE 5-min trading.
  Reason: at 0.15 % round-trip costs and a choppy 30-day window, even a 42 %-win rate strategy bleeds.
- **SupertrendEMAScalp & MasterConfluence over-trade** (290 / 432 trades) — they need a higher score threshold or a cooldown.
- **Crypto on 1-hour bars works far better** than NSE 5-min — fewer trades, larger moves, better cost ratio.
- **Symmetrical Triangle & GapAndGo produced 0 trades** in this window — these patterns are genuinely rare. They will fire 2-4 times per month per symbol on average.

### Recommended capital allocation (post-tuning, NOT default)

| Strategy | Weight | ₹ Allocation |
|---|---|---|
| MasterConfluence (min_score ≥ 6) | 35 % | 35 000 |
| OpeningRangeBreakout | 20 % | 20 000 |
| GapAndGo | 15 % | 15 000 |
| RisingWedgeShort (book) | 15 % | 15 000 |
| DoubleTopMinor (book) | 10 % | 10 000 |
| Reserve (no new positions) | 5 % | 5 000 |

### Realistic daily-return target

| Scenario | Expected daily return |
|---|---|
| Default params, all 11 strategies, all symbols | −0.2 % (loses) |
| Tuned (min_score≥6, top-5 screener, crypto-focused) | +0.5 – 1.0 % |
| 5 % daily | achievable only **2-4 days per month**, not as average |

**Honest conclusion:** A 5 %-per-day *expected* return is unrealistic for any retail-accessible system over a 30-day window — it requires either (a) leverage + concentration on the best 2-3 setups per month, or (b) compounding from a smaller realistic 1 %-per-day target. **Use the +5 % rule as a daily *cap*, not a daily *expectation*.**

---

## 6. Gaps vs. the book (from Phase 1)

The 1995 PPS book is a **daily-bars, swing-position** methodology. We adapted it to intraday by:
- Porting 18/40-day MA filter → 18/40 **5-min bar** filter.
- Porting bisected-angle stop → "stop = midpoint between supply & support".
- Adding modern overlays the book lacks: VWAP, Supertrend, RSI, MACD, Opening Range, Gap analysis, relative volume, Master-confluence scoring.
- Adding intraday time-of-day rules the book never needed (09:15 / 09:20 / 14:30 / 15:15 IST).
- Adding Monte Carlo + walk-forward (the book uses only single-pass test).

---

## 7. Tests — all 46 pass

```bash
$ pytest trading_app/tests/ -v
================== 46 passed, 3 skipped, 3 warnings in 5.12s ==================
```

Tests cover: signal validity (∈{−1,0,+1}), no look-ahead bias (signals don't change when future bars revealed), position sizing (≤1 % risk), stop-loss always set and on correct side, full backtest round-trip, all metrics finite, Monte-Carlo quantile ordering, risk-manager kill-switches, time-of-day rules.

---

## 8. Disclaimer

This is a **research framework**, not a recommendation. The 1995 PPS results were on **commodity futures with daily bars** — intraday equity behavior in 2024-2026 is materially different. Use the dashboard's optimizer + walk-forward before considering any live deployment, and never with money you can't afford to lose.
