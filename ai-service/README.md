# QTI AI Service

FastAPI microservice that returns BUY/SELL/HOLD signals from a candle window.

## Quickstart

```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Health check: `curl http://localhost:8000/health`

## Contract

`POST /signal`
```json
{
  "symbol": "RELIANCE",
  "candles": [{"t": 1715000000000, "o": 100, "h": 101, "l": 99, "c": 100.5, "v": 1000}, ...]
}
```
Response:
```json
{
  "action": "BUY",
  "confidence": 0.72,
  "reason": "...",
  "indicators": {"rsi14": 42.5, "sma9": 100.3, "sma21": 99.8, "sma50": 98.1, "atr14": 0.5, "last": 100.5},
  "suggestedEntry": 100.5,
  "suggestedStop": 99.75,
  "suggestedTarget": 101.75
}
```

Replace the rule-based logic in `main.py` with a real ML model later — the HTTP contract stays the same.
