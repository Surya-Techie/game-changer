# QTI — Quick Trade Insights

Full-stack AI-powered NSE (Indian equities) trading platform. Three services:

- **Frontend** — React 18 + Vite + TypeScript + TailwindCSS, lightweight-charts, Zustand
- **Backend** — Node 20 + Express + TypeScript + Mongoose + WebSocket
- **AI service** — Python 3.12 + FastAPI + NumPy + yfinance

---

## Quick start

```bash
# 1. Mongo + Redis via Docker
docker compose up -d mongo redis

# 2. Backend
cd backend
cp ../.env.example .env       # then edit the values for your environment
npm ci
npm run dev                   # http://localhost:4000

# 3. AI service
cd ../ai-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8000

# 4. Frontend
cd ../frontend
npm ci
npm run dev                   # http://localhost:5173
```

Full Docker stack (single command — backend, AI, mongo, redis, nginx):

```bash
docker compose up -d --build
```

---

## What's in the box

### Trading
- Live dashboard with AI signals, Gainz Alpha composite score, premium indicators (VWAP, Ichimoku, SMC, Order Flow, Market Profile), candlestick patterns
- **Paper trading system** — multi-account, real NSE prices (yfinance), MARKET/LIMIT/SL_MARKET/SL_LIMIT, slippage + Zerodha-style brokerage, MIS/CNC, partial close, position pyramiding (with 2× losing-position guardrail), after-hours queueing, EOD auto-squareoff, NSE holiday calendar
- **Auto-trader** — 3 modes (OFF / SEMI / AUTO), kill switch, configurable risk caps, trailing stops, partial TP, after-hours queueing, broker-adapter abstraction (mock or Zerodha Kite)
- **Backtest engine** — replay any symbol with the full strategy stack
- **Scanner** — multi-symbol screening, watchlist universes, signal accuracy tracking
- **Options chain** — full chain with Black-Scholes Greeks (delta/gamma/theta/vega/rho), IV percentile, PCR, Max Pain, unusual OI flagging
- **Alerts** — price / indicator / AI-signal / composite / custom-formula alerts with timeframe selection
- **Chart drawing tools** — horizontal lines (draggable), trendlines, Fibonacci (auto 0/23.6/38.2/50/61.8/78.6/100), rectangles, text. Save/load named layouts per symbol.

### Risk & analytics
- Paper analytics page — equity curve, daily P&L, drawdown, distribution, by-symbol/hour/weekday/strategy, Sharpe/Sortino/Calmar/SQN/Kelly/Recovery, behavior signals (overtrading, revenge trading, hold-time)
- Trade journal — auto-captured entry signal snapshot + manual reflection fields
- Auto-review of closed trades (heuristic coaching feedback)
- Weekly review templates
- Cross-user leaderboard (% return, last 30d)
- Tax CSV export by Indian FY

### Production
- **Broker adapter** — `BROKER_MODE=mock | kite`. Mock path is the default and preserves the original auto-trader behaviour byte-for-byte.
- **Kite Connect** — REST adapter, login redirect flow, postback webhook for fill reconciliation, daily token refresh
- **Structured logging** — text format in dev, JSON in production, `LOG_FORMAT=json|text`, `LOG_LEVEL=info|warn|error|debug`
- **Prometheus metrics** — `/metrics` endpoint with HTTP latency histograms, request counters, paper/broker order counters, WS connection gauge
- **Mongo resilience** — capped-backoff initial connect retry, persistent driver-level reconnect, full lifecycle event logging
- **WebSocket auto-reconnect** — capped exponential backoff with jitter, 25s heartbeat
- **AuditLog TTL** — auto-rotation after 90 days (tunable via `AUDIT_TTL_DAYS`)
- **AI-service token gate** — optional `AI_SERVICE_TOKEN` for service-to-service auth
- **Rate-limited broker auth** — 6 requests/min on `/api/broker/auth` to protect Zerodha's session endpoint
- **Out-of-app notifications** — generic webhook + optional SMTP email via `NOTIFIER_*` envs
- **CI** — GitHub Actions for typecheck + tests + build across all three services
- **Tests** — Node `node:test` runner for brokerage / slippage / market hours / metrics

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React :5173)                       │
│  Dashboard · Paper · Analytics · Journal · Portfolio · Scanner …    │
└──────────┬──────────────────────────────────────┬───────────────────┘
           │ REST + JWT                           │ WebSocket
           ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     BACKEND (Express :4000)                         │
│                                                                     │
│  Auth · Routes (37+) · Audit · Event Bus · WebSocket Hub · Metrics  │
│                                                                     │
│  Services:                                                          │
│  • signalEngine — generates AI signals                              │
│  • autoTrader  — places orders via brokerAdapter                    │
│  • positionManager — MTM, SL/TP, trailing                           │
│  • paperEngine — isolated paper trading                             │
│  • paperPositionManager — background fills/MTM                      │
│  • alertWatcher — price/indicator/formula alerts                    │
│  • notifier + notifierBridge — webhook + SMTP delivery              │
│  • scanner — multi-symbol screening                                 │
│                                                                     │
│  Brokers: mockAdapter | kiteAdapter (Zerodha Kite Connect v3)       │
└──────────┬──────────────────────────────────────┬───────────────────┘
           │ HTTP calls (X-Service-Token)          │ Mongoose
           ▼                                      ▼
┌──────────────────────────┐         ┌────────────────────────────────┐
│   AI SERVICE (FastAPI)   │         │            MongoDB             │
│                          │         │                                │
│  /signal /indicators     │         │  Users · Signals · Orders      │
│  /patterns /backtest     │         │  Positions · Trades · Alerts   │
│  /predict /sentiment     │         │  AccountState · Candles        │
│  /price/{symbol}         │         │  AuditLog (TTL 90d)            │
│  /options/chain/{symbol} │         │                                │
│  /indicators/snapshot/.. │         │  PaperAccount · PaperPosition  │
└──────────────────────────┘         │  PaperTrade · PaperOrder       │
                                     │  ChartLayout                   │
                                     └────────────────────────────────┘
```

---

## Environment variables

See [.env.example](.env.example) for a complete list. Key ones:

| Var | Purpose | Default |
|---|---|---|
| `BROKER_MODE` | `mock` keeps existing auto-trader behaviour; `kite` routes to Zerodha | `mock` |
| `KITE_API_KEY` / `KITE_API_SECRET` | Zerodha Kite Connect credentials | — |
| `JWT_SECRET` | JWT signing secret. **Must be set in production** — server refuses to start with the dev fallback when `NODE_ENV=production` | dev fallback |
| `AI_SERVICE_TOKEN` | Optional shared secret between Node backend and FastAPI ai-service | unset (open) |
| `LOG_FORMAT` | `json` (prod default) / `text` (dev default) | inherits |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `AUDIT_TTL_DAYS` | Days before AuditLog rows auto-purge | `90` |
| `NOTIFIER_WEBHOOK_URL` | Generic JSON-POST webhook (Slack incoming-webhook compatible) | unset |
| `NOTIFIER_SMTP_*` + `NOTIFIER_EMAIL_*` | SMTP email channel (requires `npm i nodemailer`) | unset |

---

## API reference (selected)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe |
| GET | `/metrics` | Prometheus-format metrics |
| GET | `/api/broker/status` | Broker connection + cached margins |
| POST | `/api/broker/auth` | Exchange Kite `request_token` → access token (rate-limited 6/min) |
| POST | `/api/broker/postback` | Kite postback webhook (no JWT; checksum verified) |
| GET | `/api/paper/portfolio` | Live equity / cash / margin / day P&L |
| POST | `/api/paper/orders` | Place paper order (MARKET / LIMIT / SL_MARKET / SL_LIMIT) |
| GET | `/api/paper/analytics` | Full performance bundle |
| GET | `/api/paper/leaderboard` | Cross-user `?since=<ISO>` |
| GET | `/api/paper/trades/:id/review` | Heuristic auto-review of one trade |
| GET | `/api/paper/weekly-review` | Last-7-days journal template |
| GET | `/api/paper/trades/export.csv?fy=2025-26` | Tax CSV export |
| GET | `/api/options/chain/:symbol` | Full options chain with Greeks |
| GET | `/api/options/greeks/:symbol/:expiry/:strike/:kind` | Single-strike Greeks |
| POST | `/api/alerts` | Create alert (price / indicator / `INDICATOR_FORMULA`) |
| GET | `/api/chart-layouts?symbol=…` | Saved drawing layouts (max 5 per symbol) |

---

## Tests + CI

Backend tests use Node's built-in test runner (zero new deps):

```bash
cd backend && npm test
```

GitHub Actions runs typecheck + tests + build on every push and PR — see [.github/workflows/ci.yml](.github/workflows/ci.yml).

---

## Known scope items not shipped

- **Embedded TradingView chart on the `/paper` right panel** — chart synchronisation is a multi-day refactor; the page links out to the dashboard chart for now.
- **Native options trading** — chain view + Greeks ship, but you can't place an option order yet (multi-leg strategy engine + margin calc needed).
- **Futures / commodities / currency / crypto** — equity only.
- **Full mobile-responsive overhaul** — desktop-first; the layout adapts but isn't touch-optimised.
- **DB migration framework** — Mongoose creates collections lazily. Field renames in production need a mongo-shell pass.
- **Secrets vault / scheduled DB backups** — deployment concerns, not code.
