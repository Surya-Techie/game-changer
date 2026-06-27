import { Order } from "../models/Order.js";
import { priceBook } from "./priceBook.js";
import { bus } from "./eventBus.js";
import { logger } from "../utils/logger.js";

const SLIPPAGE_BPS = 2; // 0.02% slippage applied against the trader

export interface PlaceOrderInput {
  userId: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  source: "MANUAL" | "AUTO";
  sourceSignalId?: string;
}

export interface FillResult {
  orderId: string;
  filledPrice: number;
}

class PaperBroker {
  /**
   * Synchronously fills a market order at the latest tick price (plus slippage).
   * Returns the fill so the caller can open/close a position atomically.
   */
  async submitMarket(input: PlaceOrderInput): Promise<FillResult> {
    const last = priceBook.price(input.symbol);
    if (last == null) {
      const rejected = await Order.create({
        ...input,
        type: "MARKET",
        status: "REJECTED",
        rejectReason: "No live price",
      });
      bus.emit("order", {
        userId: input.userId,
        orderId: String(rejected._id),
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        status: "REJECTED",
      });
      throw new Error("No live price for symbol");
    }

    const slip = (last * SLIPPAGE_BPS) / 10_000;
    const filledPrice = round2(input.side === "BUY" ? last + slip : last - slip);

    const order = await Order.create({
      ...input,
      type: "MARKET",
      status: "FILLED",
      filledPrice,
      filledAt: new Date(),
    });

    bus.emit("order", {
      userId: input.userId,
      orderId: String(order._id),
      symbol: input.symbol,
      side: input.side,
      qty: input.qty,
      status: "FILLED",
      filledPrice,
    });

    logger.info("Paper order filled", {
      symbol: input.symbol,
      side: input.side,
      qty: input.qty,
      price: filledPrice,
      source: input.source,
    });

    return { orderId: String(order._id), filledPrice };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const paperBroker = new PaperBroker();
