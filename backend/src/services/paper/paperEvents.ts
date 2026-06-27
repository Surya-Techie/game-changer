// Paper-trading WebSocket event types. Emitted on the existing `bus`
// under the channel `paper`, then routed to the connected user by the
// WebSocket layer (see ws/marketSocket.ts).
//
// Kept in a separate file so both the engine (emitter) and the WS
// layer (subscriber) can import the union without circular imports.

import { bus } from "../eventBus.js";

export type PaperEvent =
  | { kind: "order_placed"; orderId: string; symbol: string; side: "BUY" | "SELL"; qty: number; orderType: string }
  | { kind: "order_filled"; orderId: string; symbol: string; side: "BUY" | "SELL"; qty: number; filledPrice: number; positionId?: string }
  | { kind: "order_cancelled"; orderId: string; reason?: string }
  | { kind: "order_rejected"; orderId: string; reason: string }
  | { kind: "position_opened"; positionId: string; symbol: string; direction: "LONG" | "SHORT"; qty: number; avgEntryPrice: number }
  | { kind: "position_updated"; positionId: string; symbol: string; currentPrice: number; unrealisedPnl: number; stopLoss?: number; takeProfit?: number }
  | { kind: "position_closed"; positionId: string; symbol: string; netPnl: number; exitReason: string; exitPrice: number }
  | { kind: "sl_hit"; positionId: string; symbol: string; exitPrice: number; loss: number }
  | { kind: "tp_hit"; positionId: string; symbol: string; exitPrice: number; profit: number }
  | { kind: "trailing_sl_updated"; positionId: string; symbol: string; newStop: number }
  | { kind: "squareoff_warning"; minutesLeft: number; openMis: number }
  | { kind: "market_open" }
  | { kind: "market_close" }
  | { kind: "account_changed"; accountId: string };

export interface PaperEventEnvelope {
  userId: string;
  ts: number;
  event: PaperEvent;
}

export function emitPaper(userId: string, event: PaperEvent) {
  // Cast through `unknown` because the `bus` is generically typed but
  // does not yet include `paper` in its event map — that change is
  // applied in eventBus.ts so this file stays a pure types module.
  (bus.emit as unknown as (k: string, p: PaperEventEnvelope) => boolean)("paper", {
    userId,
    ts: Date.now(),
    event,
  });
}
