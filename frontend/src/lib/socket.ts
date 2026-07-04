import { useEffect, useRef, useState } from "react";
import { WS_URL } from "./api";

/** Trendline overlay coordinate emitted by Western/institutional patterns. */
export interface WsTrendlinePoint {
  time: number;
  price: number;
}

/** Common pattern payload shape — used by both 'pattern' and 'pattern_signal' events. */
export interface WsPatternPayload {
  patternId?: string;
  symbol: string;
  timeframe: string;
  pattern_name: string;
  category?: string;
  direction: "bullish" | "bearish" | "continuation" | "neutral";
  confidence: number;
  grade: string;
  candle_indices: number[];
  trendline_points: WsTrendlinePoint[];
  entry?: number;
  target?: number;
  stop?: number;
  rr?: number;
  ai_explanation?: string;
  detected_at: number;
}

export interface WsPatternSignalPayload extends WsPatternPayload {
  signal_action: "BUY" | "SELL";
}

export interface WsPatternTrainingProgress {
  job_id: string;
  status: string;
  percent: number;
  message: string;
  timeframe?: string;
  finished_at?: string;
  error?: string;
}

export type WsEvent =
  | { type: "hello"; userId: string; symbols: string[] }
  | { type: "subscribed"; symbols: string[] }
  | { type: "tick"; symbol: string; price: number; volume: number; ts: number }
  | {
      type: "candle";
      candle: { symbol: string; t: number; o: number; h: number; l: number; c: number; v: number };
    }
  | { type: "signal"; signal: Record<string, unknown> }
  | { type: "order"; order: Record<string, unknown> }
  | { type: "position"; position: Record<string, unknown> }
  | { type: "portfolio"; portfolio: Record<string, unknown> }
  | { type: "alert"; alert: Record<string, unknown> }
  | { type: "paper"; ts: number; event: Record<string, unknown> }
  | { type: "pattern"; pattern: WsPatternPayload }
  | { type: "pattern_signal"; pattern: WsPatternSignalPayload }
  | { type: "pattern_training_progress"; progress: WsPatternTrainingProgress }
  | { type: "pong"; ts: number };

interface Options {
  token: string | null;
  symbols: string[];
  onEvent: (ev: WsEvent) => void;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_MS = 25_000;

export function useMarketSocket({ token, symbols, onEvent }: Options) {
  const [status, setStatus] = useState<"idle" | "connecting" | "open" | "closed">("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  const symbolsRef = useRef<string[]>(symbols);
  onEventRef.current = onEvent;
  symbolsRef.current = symbols;

  useEffect(() => {
    // Auth is disabled (login removed), so `token` is null — connect anyway;
    // the backend accepts the dev user without a token. Append the token
    // only when one exists (future login restore stays compatible).
    let cancelled = false;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let backoffMs = MIN_BACKOFF_MS;

    function connect() {
      if (cancelled) return;
      setStatus("connecting");
      const url = token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        setStatus("open");
        backoffMs = MIN_BACKOFF_MS; // success → reset backoff
        ws.send(JSON.stringify({ type: "subscribe", symbols: symbolsRef.current }));
        // Heartbeat ping so intermediate proxies don't time out the socket.
        heartbeatTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, HEARTBEAT_MS);
      };

      ws.onmessage = (e) => {
        try {
          onEventRef.current(JSON.parse(e.data) as WsEvent);
        } catch {
          // ignore non-JSON frames
        }
      };

      const closeHandler = () => {
        setStatus("closed");
        if (heartbeatTimer) window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        wsRef.current = null;
        if (cancelled) return;
        // Capped exponential backoff with ±20% jitter to avoid thundering herd.
        const jitter = 1 + (Math.random() * 0.4 - 0.2);
        const delay = Math.min(MAX_BACKOFF_MS, backoffMs) * jitter;
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
        retryTimer = window.setTimeout(connect, delay);
      };
      ws.onclose = closeHandler;
      ws.onerror = () => {
        // onclose will fire right after; reconnect from there.
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      const ws = wsRef.current;
      if (ws) {
        // Detach handlers so the close doesn't trigger another reconnect.
        ws.onclose = null;
        ws.onerror = null;
        // Closing a still-CONNECTING socket makes the browser log
        // "WebSocket is closed before the connection is established."
        // This happens every render under React Strict Mode (intentional
        // double-mount). Defer the close until OPEN so the console stays
        // clean; if the handshake never lands, the socket dies on its own.
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = () => { try { ws.close(); } catch { /* */ } };
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
      wsRef.current = null;
    };
  }, [token]);

  // Re-subscribe whenever the symbol set changes.
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", symbols }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [symbols.join("|")]);

  return { status };
}
