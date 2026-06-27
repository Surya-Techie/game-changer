# QTI Demo Walkthrough

A tour of every feature, with the exact commands and clicks. Verified end-to-end against the real backend; outputs you see below are real responses captured during the audit.

---

## 0. One-command demo bootstrap

```bash
# From repo root
cd backend && USE_INMEM_MONGO=true USE_INMEM_CACHE=true MOCK_FEED_ENABLED=true \
  JWT_SECRET="demo-secret-32chars-min-replace-me-please" npm run dev
# → backend on :4000 with in-memory Mongo + Redis, no external deps

# In another terminal:
cd ai-service && source .venv/bin/activate && uvicorn main:app --port 8000

# In a third terminal:
cd frontend && npm run dev
# → open http://localhost:5173
```

Register a user via the UI, or via curl for headless testing:

```bash
curl -s -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@qti.local","password":"DemoPass123!","name":"Demo Trader"}'
```

---

## 1. Dashboard (`/`)

What you should see when you log in:

- **Symbol selector** (left sidebar). Click `RELIANCE` — chart loads, AI signal card populates on the right.
- **Candlestick chart** centre-stage (lightweight-charts).
- **Premium Indicators toolbar** above the chart — 5 toggle pills: VWAP, Order Flow, Market Profile, Ichimoku, SMC. Click one to render its overlay on the chart.
- **AI Signal Card** (top-right rail): BUY/SELL/HOLD with confidence %, suggested entry/stop/target, indicator snapshot.
  - The card now shows an **Options context row**: PCR (put-call ratio), Max Pain, DTE. Symbols without options chains are remembered and not re-fetched (no more 404 spam).
- **"📄 Paper Trade this signal"** button (green, under the signal). Click it → deep-links to `/paper` with symbol/side/qty/SL/TP prefilled from the AI signal.
- **Right rail tabs**: Signals / Analysis / Risk.
- **Bottom tabs**: Heatmap / Movers / Bulk Deals.

### Chart drawing tools (Phase 2)
Left edge of the chart shows a vertical toolbar.

1. Click the `─` icon → **active-tool status bar** appears at the bottom showing "Horizontal line — Click on chart to place. Click an existing line to drag it." Click on the chart at any price level. The line snaps to that price on the right scale.
2. Click an existing horizontal line in `hline` tool → you grab it for **drag-to-move** (cursor switches to `ns-resize`). Drop anywhere to update its price.
3. `╱` Trend Line: click-drag from one bar to another.
4. `𝓕` Fibonacci: click-drag swing-high to swing-low; auto-draws 0/23.6/38.2/50/61.8/78.6/100 levels with price labels on the right.
5. `▭` Rectangle: click-drag any zone.
6. `T` Text: click anywhere, type, Enter to commit.
7. `✕` Eraser: click any drawing to delete it.
8. `⟲` Clear All: wipes everything, with **undo toast** for 5 seconds.
9. `💾` Save Layout: opens a dropdown — name the layout, click Save. Up to 5 layouts per symbol. The save now also captures **which premium overlays were active** so loading restores them too.

Click "Done" on the status bar to return to Select mode (chart pans/zooms again).

---

## 2. Paper Trading (`/paper`) — the main flow

### First visit
You'll see a **welcome card** explaining the system. Dismiss it when you've read it (it's permanent).

### Place your first order

1. Order Terminal (left, 40% of the page):
   - Symbol: `RELIANCE` (dropdown)
   - Click `LONG (B)` tab
   - Order Type: `MARKET`
   - Quantity: `10` (or click `25%` to auto-size from cash)
   - Risk Management section: set Stop Loss `2800`, click `2R` button to auto-fill Take Profit
   - **Order Preview** updates live: margin, est. fill, charges, max loss, potential gain, R:R, quality grade
2. Click **Place Paper Order** → confirmation modal → Confirm.
3. **Outside market hours?** Backend returns a clear message — you'll need to set "Queue for market open" (the UI passes `acceptQueue: true` automatically).
4. During market hours: order fills immediately, position appears in the **Open Positions** table at the bottom with live P&L.

### Captured curl proof (verified against real backend):

```
POST /api/paper/orders (no acceptQueue, market closed):
→ "Market is closed (NSE: 9:15 AM - 3:30 PM IST, Mon-Fri). Set acceptQueue=true to queue this order for the next market open."

POST /api/paper/orders (acceptQueue:true):
→ { "orderId":"...", "status":"QUEUED", "queued":true }

POST /api/paper/orders (LIMIT order — works any time):
→ { "orderId":"...", "status":"PENDING", "queued":false }
```

### Manage your positions

Bottom tabs: **Open positions / Pending orders / Today's trades / All trades**

- **Open positions** table: live P&L animates, click any row to expand (MAE/MFE/product/originalQty), Close button → modal with `Close 25% / 50% / 75% / 100%` buttons for partial close.
- **Pending orders** table: shows LIMIT + queued MARKET orders. Cancel button per row.
- **Today's trades** / **All trades**: closed-trade records with entry, exit, hold time, R-multiple, exit reason.

### Account management (header)

- **Account dropdown**: switch between paper accounts (up to 3)
- **+ new**: create another paper account with custom starting capital
- **reset**: wipes all positions/orders/trades, returns cash to starting capital (with confirm)
- **Sound toggle** (🔊/🔇): Web Audio cues on order placed / filled / SL / TP / squareoff warning
- **Market Status bar**: 🟢 OPEN with minutes-to-close countdown · 🟡 PRE-OPEN · 🔴 CLOSED with next-open time · ⚠️ holiday flag

---

## 3. Paper Analytics (`/paper/analytics`)

### With no trades yet
Shows a friendly empty-state card with a "Open the trading terminal →" link. **No more blank screen.**

### After you've closed some trades
- **Summary cards** (8): Starting Capital, Current Equity, Total P&L (₹+%), Win Rate, Profit Factor, Max Drawdown, Trades, Expectancy.
- **Equity Curve** with starting-capital baseline.
- **Daily P&L bars** (last 30 days).
- **Drawdown chart** with max-DD annotation.
- **Trade P&L distribution** histogram.
- **P&L by Symbol** ranked table.
- **P&L by Hour** heatmap (9 AM – 3 PM IST).
- **P&L by Weekday** bars.
- **Strategy Breakdown** table (per `strategyTag`).
- **Advanced Metrics**: Sharpe / Sortino / Calmar / SQN / Kelly / Recovery Factor.
- **Behavior**: hold-time winners-vs-losers, overtrading days, revenge trades.
- **Paper vs AI Backtest**: enter a symbol, click "Run" — calls `/api/backtest` and shows your numbers side-by-side with the AI strategy's.
- **Leaderboard**: top 50 paper traders by % return in the last 30d (`isYou` highlighted).
- **Export**: enter FY (e.g. `2025-26`), click "Download CSV" — auth'd fetch + Blob save. Tax-return-ready.
- **Achievements**: 7 badges with progress (`5 / 10` style).

---

## 4. Paper Journal (`/paper/journal`)

Left rail: chronological list of all closed trades.

Right pane (when a trade is selected):

1. **Auto-review** card at top: click "Generate" → heuristic coaching summary:
   ```
   ✅ LONG RELIANCE closed +₹1,250 (1.85R)
   • Strong win at 1.85R — let the runner work.
   • Stop hit on a small adverse move (0.34%). Stop may be tighter than needed.
   • Aligned with AI signal (BUY 72% confidence).
   • High composite score (75) at entry validated the entry framework.
   Grade: A
   ```
2. **Trade summary**: Symbol/Direction/P&L + per-leg numbers + R-multiple + MAE/MFE + AI entry signal snapshot (collapsible JSON).
3. **Journal fields**:
   - Pre-trade plan
   - Execution stars (1–5 ★)
   - Quality (A+/A/B/C/Mistake)
   - Emotion at entry / exit (Calm / Confident / FOMO / Anxious / Revenge / Bored / Excited)
   - Setup type (Trend / Breakout / Reversion / Scalp / News / Other)
   - Mistake
   - Lesson learned
   - Notes
4. Save → "Saved at HH:MM:SS" confirmation.

---

## 5. Options Chain (`/options`)

1. Symbol dropdown → pick `RELIANCE`.
2. Expiry pills: nearest 3 expiries (e.g. `2026-05-29 (10d)`).
3. **Summary cards**: PCR (with Bullish/Neutral/Bearish bias), Max Pain, Avg IV, # Unusual OI strikes.
4. **Strike scale strip**: visualises underlying price (green) and Max Pain level (amber) within the strike range.
5. **Chain table**: side-by-side CE | Strike | PE. Each side shows OI bar (green/red, sized by ratio), LTP, IV%, Δ. Unusual-OI strikes flagged with ⚡. ATM row highlighted amber. ITM-only toggle.
6. Click any strike cell → Greeks panel right-side updates: Δ Γ Θ ν ρ + IV% percentile gauge.

(Note: requires `pip install yfinance` and internet. Without it, the chain endpoint returns 503 and the page shows a clear error.)

---

## 6. Alerts (`/alerts`)

### Price alert (existing)
1. Symbol `INFY`, Condition "RSI below", value `30`, click Add Alert.
2. Now shows in the Active Alerts table with ON toggle, last triggered, count.

### **Indicator Formula alert (new in Phase 4)**
1. Switch Condition to "Indicator formula (advanced)" → formula builder appears.
2. Default: `RSI crosses below 30` (one row). Click **+ Add Condition** to AND more (e.g. `RSI crosses below 30 AND MACD is_below 0`).
3. Each row: indicator selector × operator (crosses_above / crosses_below / is_above / is_below) × `value`-or-`indicator` rhs toggle.
4. Timeframe selector (M5 / M15 / H1 / D1).
5. Save. Every 60s the backend hits FastAPI `/indicators/snapshot/{symbol}` and evaluates all conditions; fires when all are met. Stored `lastFormulaValues` are surfaced in the trigger-history view.

---

## 7. Broker Integration (`/settings` → Broker section)

### Mock mode (default — `BROKER_MODE=mock`)
Status shows **CONNECTED** with the auto-trader's notional margin.

### Switch to Kite
1. Edit `.env`: `BROKER_MODE=kite`, `KITE_API_KEY=...`, `KITE_API_SECRET=...`. Restart backend.
2. Settings → Broker section now shows mode pill `Zerodha Kite` + DISCONNECTED badge + a yellow live-trading warning.
3. Tick the **"I understand. Enable live broker actions."** checkbox.
4. Click **Connect to Kite** → redirects to Zerodha login → on success Kite redirects back to `/settings?request_token=...` → frontend auto-POSTs to `/api/broker/auth` → access token established → margin displayed.
5. Kite **postback URL**: set in your Kite dashboard to `https://your-host/api/broker/postback`. Order completions trigger reconciliation: auto-trader Position docs get their `entryPrice` updated to the actual broker fill (SHA-256 checksum verified).

---

## 8. Auto-trader (`/settings` → Auto-trade section)

- 3 modes: OFF / SEMI (manual confirm) / AUTO
- Kill switch
- Risk caps: per-trade %, max open positions, max daily loss %, min confidence
- Strategy toggles: stop mode (ATR / FIXED_PCT), trailing %, partial TP, regime filter (ADX), MTF confirmation
- **Now in this build**: when in AUTO + `BROKER_MODE=mock` and a signal fires outside market hours, the order is queued as PENDING. At market open the background watcher (30s tick) **flushes the queue** through the broker and the placeholder Order is marked CANCELLED so the audit log stays clean.

---

## 9. Notifications (out of app)

Configure via env vars in your `.env`:

```
NOTIFIER_WEBHOOK_URL=https://hooks.slack.com/services/...
NOTIFIER_EMAIL_TO=trader@example.com
NOTIFIER_SMTP_HOST=smtp.gmail.com
NOTIFIER_SMTP_PORT=587
NOTIFIER_SMTP_USER=...
NOTIFIER_SMTP_PASS=...
NOTIFIER_EMAIL_FROM=qti@yourdomain.com
```

Webhook is built in. Email lazy-loads `nodemailer` — run `npm i nodemailer` in the backend folder once to enable.

Events delivered: position closed (any source), paper SL hit, paper TP hit, EOD squareoff warning.

---

## 10. Operations

### Metrics

```bash
curl http://localhost:4000/metrics | head -20
```

Real captured output:
```
# HELP qti_http_requests_total HTTP request count
# TYPE qti_http_requests_total counter
qti_http_requests_total{method="GET",route="/health",status="200"} 1
qti_http_requests_total{method="POST",route="/register",status="201"} 1
qti_http_requests_total{method="POST",route="/orders",status="201"} 2
...
```

Includes HTTP latency histogram, paper order counters, broker order counters, WS connections gauge, signals emitted counter.

### Structured logs

```bash
NODE_ENV=production LOG_FORMAT=json npm start
# every line is a single JSON object — pipe straight into Loki / Datadog / CloudWatch
```

### CI

GitHub Actions config at [.github/workflows/ci.yml](.github/workflows/ci.yml) runs typecheck + tests + build on every push and PR for backend, frontend, and ai-service.

### Tests

```bash
cd backend && npm test
# → 18 / 18 pass — brokerage, slippage, market hours, metrics
```

---

## 11. Keyboard shortcuts (press `?` to see them in-app)

- `⌘K` / `Ctrl+K` — Command palette (Now includes Paper Trade, Paper Analytics, Paper Journal, Options Chain, Calendar, Top 20 Stocks)
- `1`–`9` — switch to symbol N of watchlist
- `G` then `D/W/S/H/P/B/A/,` — go to Dashboard / Watchlist / Scanner / signal History / Portfolio / Backtest / Alerts / Settings
- **Paper terminal**: `B` / `S` toggle direction; `M` / `L` switch order type; `Esc` cancel modal
- `Esc` — close any open modal / palette

---

## What this build's bug-fix pass cleaned up

The audit found and this build fixes:

| # | Bug | Status |
|---|---|---|
| 1 | "Price unavailable" error when market is just closed | ✓ now returns explicit market-closed message |
| 2 | Auto-trader queued orders never replayed at market open | ✓ background watcher flushes the queue |
| 3 | Save Layout overlays silently lost on load | ✓ `qti:apply-overlays` listener reconciles overlay toggles |
| 4 | OptionsContextRow spammed 404 on every symbol-switch for symbols without chains | ✓ per-symbol negative cache |
| 5 | Drawing toolbar icons cryptic — users didn't know what each did | ✓ tooltips per tool + bottom status bar with active-tool instructions |
| 6 | Empty tables ("No positions yet") gave no guidance | ✓ icon + 1-sentence "what to do next" everywhere |
| 7 | `/paper` had no first-time hint | ✓ welcome card explaining the system (dismissible, sticky) |
| 8 | Order terminal fields cryptic for new traders | ✓ inline `help` reveal explains MIS/CNC, MARKET/LIMIT/SL types, SL/TP, trailing |
| 9 | No demo doc | ✓ this file |

---

## What's intentionally still not built

Re-stated here so there are no surprises. These need either entire new domains or deployment work:

- Embedded TradingView-style chart on the `/paper` right panel (just links to dashboard chart)
- Native options trading (chain view + Greeks ship; placing options orders does not)
- Futures / commodities / currency / crypto
- Full mobile-responsive overhaul (desktop-first, layout adapts but not touch-optimised)
- DB migration framework (Mongoose creates collections lazily)
- Secrets vault, scheduled DB backups (ops, not code)
- SMS / Telegram notifications (third-party creds required)
