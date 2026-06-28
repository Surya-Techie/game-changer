import type { Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { verifyToken, type JwtPayload } from "../utils/jwt.js";
import { DEV_USER } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { mockFeed } from "../services/mockFeed.js";
import { candleAggregator } from "../services/candleAggregator.js";
import { bus } from "../services/eventBus.js";
import { Signal } from "../models/Signal.js";
import { User } from "../models/User.js";
import type { Candle } from "../models/Candle.js";
import { logger } from "../utils/logger.js";

interface Client {
  ws: WebSocket;
  user: JwtPayload;
  subs: Set<string>;
  isAdmin: boolean; // cached on connect; used to gate the training-progress broadcast
}

const clients = new Set<Client>();
let wss: WebSocketServer | undefined;

export function attachWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const token = url.searchParams.get("token");
    // When auth is disabled (login UI removed), accept tokenless / invalid
    // connections as the shared DEV_USER so they receive that account's
    // order/position/portfolio broadcasts. Production still requires a
    // valid token.
    let user: JwtPayload;
    if (token && token !== "null" && token !== "undefined") {
      try {
        user = verifyToken(token);
      } catch {
        if (!env.authDisabled) return ws.close(4001, "Invalid token");
        user = DEV_USER;
      }
    } else {
      if (!env.authDisabled) return ws.close(4001, "Missing token");
      user = DEV_USER;
    }

    const client: Client = { ws, user, subs: new Set(), isAdmin: false };
    clients.add(client);
    logger.info("WS connected", { userId: user.userId });

    // Resolve admin role asynchronously; events fired before the role
    // resolves simply don't go to that client, which is the safe default.
    void User.findById(user.userId).select("role").lean().then((u) => {
      if (u && (u as { role?: string }).role === "ADMIN") client.isAdmin = true;
    }).catch(() => {});

    send(ws, { type: "hello", userId: user.userId, symbols: mockFeed.symbols() });

    ws.on("message", (data) => handleClientMessage(client, data));
    ws.on("close", () => {
      clients.delete(client);
      logger.info("WS disconnected", { userId: user.userId });
    });
    ws.on("error", (err) => logger.warn("WS error", { err: err.message }));
  });

  // Ticks → only subscribed clients.
  bus.on("tick", (tick) => {
    for (const c of clients) {
      if (c.subs.has(tick.symbol) && c.ws.readyState === WebSocket.OPEN) {
        send(c.ws, { type: "tick", ...tick });
      }
    }
  });

  // Candles update.
  candleAggregator.on("candle:update", (candle: Candle) => {
    for (const c of clients) {
      if (c.subs.has(candle.symbol) && c.ws.readyState === WebSocket.OPEN) {
        send(c.ws, { type: "candle", candle });
      }
    }
  });

  // Signals → all connected clients subscribed to that symbol get a copy.
  bus.on("signal", async (sig) => {
    const doc = await Signal.findById(sig.signalId).lean();
    if (!doc) return;
    for (const c of clients) {
      if (c.subs.has(sig.symbol) && c.ws.readyState === WebSocket.OPEN) {
        send(c.ws, { type: "signal", signal: doc });
      }
    }
  });

  // Per-user algo events.
  bus.on("order", (ev) => sendToUser(ev.userId, { type: "order", order: ev }));
  bus.on("position", (ev) => sendToUser(ev.userId, { type: "position", position: ev }));
  bus.on("portfolio", (ev) => sendToUser(ev.userId, { type: "portfolio", portfolio: ev }));
  // Paper trading: single channel, kind-discriminated payload.
  bus.on("paper", (env) =>
    sendToUser(env.userId, { type: "paper", ts: env.ts, event: env.event })
  );

  // Pattern detection — Phase 5. Two events:
  //   • pattern        — informational, fan out to anyone watching the symbol.
  //   • pattern_signal — actionable (≥85 confidence + paper enabled), same fan-out.
  // Both reuse the symbol-subscription model so the user only hears about
  // patterns on instruments they're actually following.
  bus.on("pattern", (p) => {
    for (const c of clients) {
      if (c.subs.has(p.symbol) && c.ws.readyState === WebSocket.OPEN) {
        send(c.ws, { type: "pattern", pattern: p });
      }
    }
  });
  bus.on("pattern_signal", (p) => {
    for (const c of clients) {
      if (c.subs.has(p.symbol) && c.ws.readyState === WebSocket.OPEN) {
        send(c.ws, { type: "pattern_signal", pattern: p });
      }
    }
  });
  // Training progress: admin-only broadcast.
  bus.on("pattern_training_progress", (ev) => {
    for (const c of clients) {
      if (c.isAdmin && c.ws.readyState === WebSocket.OPEN) {
        send(c.ws, { type: "pattern_training_progress", progress: ev });
      }
    }
  });

  logger.info("WebSocket server attached at /ws");
}

function sendToUser(userId: string, payload: unknown) {
  for (const c of clients) {
    if (c.user.userId === userId && c.ws.readyState === WebSocket.OPEN) {
      send(c.ws, payload);
    }
  }
}

function handleClientMessage(client: Client, data: RawData) {
  let msg: { type?: string; symbols?: string[]; symbol?: string };
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg.type === "subscribe" && Array.isArray(msg.symbols)) {
    client.subs.clear();
    for (const s of msg.symbols) client.subs.add(s.toUpperCase());
    send(client.ws, { type: "subscribed", symbols: [...client.subs] });
  } else if (msg.type === "unsubscribe" && msg.symbol) {
    client.subs.delete(msg.symbol.toUpperCase());
  } else if (msg.type === "ping") {
    send(client.ws, { type: "pong", ts: Date.now() });
  }
}

function send(ws: WebSocket, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore broken pipe
  }
}

// Kept for backward compat with anything still calling broadcast.
export function broadcast(_payload: unknown) {
  /* no-op: replaced by event bus */
}
