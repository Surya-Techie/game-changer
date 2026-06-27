// Mock broker adapter. Wraps the existing paperBroker.submitMarket() so
// BROKER_MODE=mock produces identical behaviour to the pre-adapter code
// path. Only MARKET orders execute synchronously here (matching the
// existing paperBroker contract); other types are rejected with a clear
// message — the auto-trader only ever sends MARKET orders.
//
// Positions/orders/holdings/margins are derived from the existing
// Position / Order / AccountState collections so the UI sees the same
// data whether you query via /api/positions or /api/broker/positions.

import { paperBroker } from "../paperBroker.js";
import { priceBook } from "../priceBook.js";
import { Order } from "../../models/Order.js";
import { Position } from "../../models/Position.js";
import { User } from "../../models/User.js";
import { AccountState } from "../../models/AccountState.js";
import { getOrCreateAccountState } from "../riskManager.js";
import type {
  IBrokerAdapter,
  PlaceOrderRequest,
  PlaceOrderResult,
  BrokerStatus,
  BrokerOrder,
  BrokerPosition,
  BrokerHolding,
  BrokerMargins,
} from "./IBrokerAdapter.js";

class MockAdapter implements IBrokerAdapter {
  readonly mode = "mock" as const;

  async status(): Promise<BrokerStatus> {
    return { mode: "mock", connected: true };
  }

  async authenticate(): Promise<BrokerStatus> {
    return this.status();
  }

  async logout(): Promise<void> {
    /* nothing to do for mock */
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    if (req.orderType !== "MARKET") {
      return {
        brokerOrderId: "",
        status: "REJECTED",
        message: `Mock adapter only supports MARKET orders (got ${req.orderType}). Use /api/paper for full LIMIT/SL flow.`,
      };
    }
    try {
      const fill = await paperBroker.submitMarket({
        userId: req.userId,
        symbol: req.symbol,
        side: req.side,
        qty: req.qty,
        source: req.source,
        sourceSignalId: req.sourceSignalId,
      });
      return {
        brokerOrderId: fill.orderId,
        status: "FILLED",
        filledPrice: fill.filledPrice,
        filledQty: req.qty,
      };
    } catch (err) {
      return {
        brokerOrderId: "",
        status: "REJECTED",
        message: (err as Error).message,
      };
    }
  }

  async cancelOrder(userId: string, brokerOrderId: string) {
    const order = await Order.findOne({ _id: brokerOrderId, userId });
    if (!order) return { ok: false, message: "Order not found" };
    if (order.status !== "PENDING") return { ok: false, message: `Cannot cancel order in status ${order.status}` };
    order.status = "CANCELLED";
    await order.save();
    return { ok: true };
  }

  async getOrders(userId: string): Promise<BrokerOrder[]> {
    const rows = await Order.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return rows.map((o) => ({
      brokerOrderId: String(o._id),
      symbol: String(o.symbol),
      side: o.side as "BUY" | "SELL",
      orderType: (o.type === "LIMIT" ? "LIMIT" : "MARKET") as "LIMIT" | "MARKET",
      qty: o.qty,
      filledQty: o.status === "FILLED" ? o.qty : 0,
      status: String(o.status),
      avgPrice: o.filledPrice ?? undefined,
      placedAt: (o.createdAt ?? new Date()).toISOString(),
    }));
  }

  async getPositions(userId: string): Promise<BrokerPosition[]> {
    const rows = await Position.find({ userId, status: "OPEN" }).lean();
    return rows.map((p) => {
      const ltp = priceBook.price(String(p.symbol));
      const pnl = ltp != null
        ? (p.side === "LONG" ? (ltp - p.entryPrice) : (p.entryPrice - ltp)) * p.qty
        : undefined;
      return {
        symbol: String(p.symbol),
        qty: p.side === "LONG" ? p.qty : -p.qty,
        avgPrice: p.entryPrice,
        ltp,
        pnl,
        product: "MIS",
      };
    });
  }

  async getHoldings(_userId: string): Promise<BrokerHolding[]> {
    // The mock has no concept of CNC holdings — return empty so the UI
    // section just shows "No holdings" rather than crashing.
    return [];
  }

  async getMargins(userId: string): Promise<BrokerMargins> {
    const user = await User.findById(userId).lean();
    const capital = (user?.capital as number | undefined) ?? 100_000;
    const state = await AccountState.findOne({ userId }).lean();
    // Compute used = sum(entry * qty) for open positions.
    const opens = await Position.find({ userId, status: "OPEN" }).lean();
    const used = opens.reduce((acc, p) => acc + p.entryPrice * p.qty, 0);
    const realised = state?.realisedPnl ?? 0;
    const available = Math.max(0, capital + realised - used);
    // Make sure account state exists so the auto-trader can read it later.
    await getOrCreateAccountState(userId);
    return {
      available: round2(available),
      used: round2(used),
      net: round2(capital + realised),
      currency: "INR",
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const mockAdapter = new MockAdapter();
