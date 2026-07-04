#!/usr/bin/env bash
# QTI all-in-one dev launcher. Boots ai-service, backend, and frontend
# with sensible defaults so you don't have to remember the env vars.
#
# Usage:
#   ./dev.sh            # boots everything, follows logs, Ctrl-C stops all
#   ./dev.sh stop       # kills any QTI dev processes left over
#   ./dev.sh logs       # tails the last 50 lines of each service log
#
# Logs land in /tmp/qti-{ai,be,fe}.log so you can inspect any service
# after-the-fact even if the launcher is closed.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
AI="$ROOT/ai-service"
BE="$ROOT/backend"
FE="$ROOT/frontend"

AI_LOG=/tmp/qti-ai.log
BE_LOG=/tmp/qti-be.log
FE_LOG=/tmp/qti-fe.log

stop_all() {
  pkill -f "tsx watch src/server.ts" 2>/dev/null
  pkill -f "uvicorn main:app" 2>/dev/null
  pkill -f "vite" 2>/dev/null
  echo "QTI: all services stopped."
}

case "${1:-up}" in
  stop)
    stop_all
    exit 0
    ;;
  logs)
    echo "─── ai-service ───"; tail -n 50 "$AI_LOG" 2>/dev/null || echo "(no log yet)"
    echo "─── backend ───";    tail -n 50 "$BE_LOG" 2>/dev/null || echo "(no log yet)"
    echo "─── frontend ───";   tail -n 50 "$FE_LOG" 2>/dev/null || echo "(no log yet)"
    exit 0
    ;;
esac

# Kill any leftovers from a previous run.
stop_all
sleep 1

echo "QTI: booting…"

# ─── AI service ────────────────────────────────────────────────────────
if [ -d "$AI/.venv" ]; then
  echo "  ai-service → http://localhost:8000  (logs: $AI_LOG)"
  ( cd "$AI" && source .venv/bin/activate && \
    nohup python3 -m uvicorn main:app --port 8000 --host 127.0.0.1 \
    > "$AI_LOG" 2>&1 & )
else
  echo "  ⚠ ai-service venv missing — skipping (run: cd ai-service && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt)"
fi

# ─── Backend ───────────────────────────────────────────────────────────
echo "  backend    → http://localhost:4000  (logs: $BE_LOG)"
(
  cd "$BE"
  export USE_INMEM_MONGO=true
  export USE_INMEM_CACHE=true
  export PORT=4000
  export MOCK_FEED_ENABLED=true
  export JWT_SECRET="${JWT_SECRET:-qti-dev-secret-replace-me-32chars-min}"
  export AI_SERVICE_URL=http://localhost:8000
  # Dev: keep the pattern engine ticking around the clock so chart overlays
  # fire outside NSE hours, and emit lower-confidence patterns so there's
  # always something for the chart to draw on the demo data.
  export PATTERN_ENGINE_REQUIRE_MARKET=false
  export PATTERN_ENGINE_MIN_EMIT_CONF=40
  # Let the auto-trade loop execute against the mock feed around the clock
  # (otherwise every order queues until NSE opens). Dev only.
  export AUTOTRADE_REQUIRE_MARKET=false
  # Move prices with a synthetic walk so the full auto-trade loop (open →
  # stop/target → exit → trade) is exercisable when NSE is closed. Dev only.
  export MOCK_FEED_SYNTHETIC=true
  nohup npm run dev > "$BE_LOG" 2>&1 &
)

# ─── Frontend ──────────────────────────────────────────────────────────
echo "  frontend   → http://localhost:5173  (logs: $FE_LOG)"
( cd "$FE" && nohup npm run dev > "$FE_LOG" 2>&1 & )

# Give them a moment to come up so the readiness probe is meaningful.
sleep 6

# ─── Readiness checks ──────────────────────────────────────────────────
echo ""
echo "QTI: readiness probe…"
probe() {
  local name="$1" url="$2" max=15 i=0
  while [ $i -lt $max ]; do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      echo "  ✓ $name ready"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "  ✗ $name NOT ready after ${max}s — check $3"
  return 1
}
probe "ai-service" "http://localhost:8000/health" "$AI_LOG"
probe "backend"    "http://localhost:4000/health" "$BE_LOG"
probe "frontend"   "http://localhost:5173/"       "$FE_LOG"

echo ""
echo "QTI is up. Open http://localhost:5173"
echo ""
echo "Stop everything:  ./dev.sh stop"
echo "Tail logs:        ./dev.sh logs"
echo "Or watch one:     tail -f $BE_LOG"
