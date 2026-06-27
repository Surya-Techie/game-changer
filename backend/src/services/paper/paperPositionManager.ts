// Background loop that runs every ~15s during market hours.
// For every open paper position it:
//   1. Pulls fresh prices via paperPriceFeed (which calls yfinance + caches)
//   2. Updates currentPrice / unrealisedPnl / MAE / MFE
//   3. Bumps trailing stop on new highs/lows
//   4. Triggers SL / TP closes
//   5. Fills LIMIT / SL_MARKET / SL_LIMIT pending orders that hit
//   6. At 15:20 IST expires DAY orders, at 15:25 auto-squares-off MIS positions
//
// All actual state changes go through paperEngine.closePosition / fillAndOpen
// equivalents — this file is pure orchestration.

import mongoose from "mongoose";
import { PaperPosition } from "../../models/PaperPosition.js";
import { PaperOrder } from "../../models/PaperOrder.js";
import { PaperAccount } from "../../models/PaperAccount.js";
import { paperPriceFeed } from "./priceFeed.js";
import {
  closePosition,
  distinctActiveSymbols,
  marketFill,
  slMarketFill,
  limitFill,
  round2,
} from "./paperEngine.js";
import {
  isMarketOpen,
  isTradingDay,
  marketStatus,
  shouldRunEodSquareoff,
  shouldExpireDayOrders,
  shouldWarnSquareoff,
} from "./marketHours.js";
import { emitPaper } from "./paperEvents.js";
import { captureEntrySignal } from "./entrySignal.js";
import { Types } from "mongoose";
import { logger } from "../../utils/logger.js";

const TICK_MS = 15_000;

class PaperPositionManager {
  private timer: NodeJS.Timeout | undefined;
  private lastMarketState: "OPEN" | "PRE_OPEN" | "CLOSED" | null = null;
  private warnedSquareoffOn: string | null = null; // YYYY-MM-DD

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        logger.warn("paperPositionManager tick error", { err: (err as Error).message })
      );
    }, TICK_MS);
    logger.info("paperPositionManager started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick() {
    const status = marketStatus();
    // Broadcast market open/close transitions exactly once.
    if (this.lastMarketState && this.lastMarketState !== status.state) {
      if (status.state === "OPEN") this.broadcastAll({ kind: "market_open" });
      if (this.lastMarketState === "OPEN" && status.state !== "OPEN") {
        this.broadcastAll({ kind: "market_close" });
      }
    }
    this.lastMarketState = status.state;

    if (!isTradingDay()) return;

    // 15:20 → expire DAY orders.
    if (shouldExpireDayOrders()) {
      await PaperOrder.updateMany(
        { status: { $in: ["PENDING", "QUEUED"] }, validity: "DAY" },
        { $set: { status: "EXPIRED" } }
      );
    }

    // 15:20 → 15:25 squareoff warning (once per day).
    const dayKey = status.istDate;
    if (shouldWarnSquareoff() && this.warnedSquareoffOn !== dayKey) {
      const misCount = await PaperPosition.countDocuments({ productType: "MIS" });
      if (misCount > 0) {
        // Emit to each affected user.
        const users = await PaperPosition.distinct("userId", { productType: "MIS" });
        for (const u of users) {
          const userOpen = await PaperPosition.countDocuments({ userId: u, productType: "MIS" });
          emitPaper(String(u), { kind: "squareoff_warning", minutesLeft: 5, openMis: userOpen });
        }
      }
      this.warnedSquareoffOn = dayKey;
    }

    // 15:25 → auto squareoff MIS at market.
    if (shouldRunEodSquareoff()) {
      await this.eodSquareoff();
    }

    // The remaining ticks only do work when the market is open.
    if (!isMarketOpen()) return;

    // Re-activate QUEUED MARKET orders now that we're open.
    await this.processQueuedMarketOrders();

    // Refresh prices for everything we care about.
    const symbols = await distinctActiveSymbols();
    if (symbols.length === 0) return;
    const quotes = await paperPriceFeed.fetchMany(symbols);

    // Update positions, run SL/TP/trailing.
    const positions = await PaperPosition.find({ symbol: { $in: symbols } });
    for (const p of positions) {
      const q = quotes[p.symbol.toUpperCase()];
      if (!q) continue;
      await this.updatePosition(p, q.price);
    }

    // Fill pending LIMIT/SL orders.
    const pending = await PaperOrder.find({
      status: "PENDING",
      symbol: { $in: symbols },
      orderType: { $in: ["LIMIT", "SL_MARKET", "SL_LIMIT"] },
    });
    for (const o of pending) {
      const q = quotes[o.symbol.toUpperCase()];
      if (!q) continue;
      await this.tryFillPending(o, q.price);
    }
  }

  private broadcastAll(event: { kind: "market_open" | "market_close" }) {
    PaperAccount.distinct("userId")
      .then((users) => {
        for (const u of users) emitPaper(String(u), event);
      })
      .catch(() => {});
  }

  private async updatePosition(
    p: mongoose.HydratedDocument<typeof PaperPosition.prototype>,
    price: number
  ) {
    const direction = p.direction as "LONG" | "SHORT";
    const unreal =
      direction === "LONG"
        ? (price - p.avgEntryPrice) * p.qty
        : (p.avgEntryPrice - price) * p.qty;
    p.currentPrice = price;
    p.unrealisedPnl = round2(unreal);

    // High/low watermarks → drive trailing stop.
    if (p.highWatermark == null || price > p.highWatermark) p.highWatermark = price;
    if (p.lowWatermark == null || price < p.lowWatermark) p.lowWatermark = price;

    // MAE / MFE in price terms.
    if (direction === "LONG") {
      p.maxAdverseExcursion =
        p.maxAdverseExcursion == null ? price : Math.min(p.maxAdverseExcursion, price);
      p.maxFavorableExcursion =
        p.maxFavorableExcursion == null ? price : Math.max(p.maxFavorableExcursion, price);
    } else {
      p.maxAdverseExcursion =
        p.maxAdverseExcursion == null ? price : Math.max(p.maxAdverseExcursion, price);
      p.maxFavorableExcursion =
        p.maxFavorableExcursion == null ? price : Math.min(p.maxFavorableExcursion, price);
    }

    // Trailing stop: ratchet only.
    if (p.trailingStopPct && p.trailingStopPct > 0) {
      const dist = (p.avgEntryPrice * p.trailingStopPct) / 100;
      if (direction === "LONG") {
        const candidate = (p.highWatermark ?? price) - dist;
        if (p.stopLoss == null || candidate > p.stopLoss) {
          p.stopLoss = round2(candidate);
          emitPaper(String(p.userId), {
            kind: "trailing_sl_updated",
            positionId: String(p._id),
            symbol: p.symbol,
            newStop: p.stopLoss,
          });
        }
      } else {
        const candidate = (p.lowWatermark ?? price) + dist;
        if (p.stopLoss == null || candidate < p.stopLoss) {
          p.stopLoss = round2(candidate);
          emitPaper(String(p.userId), {
            kind: "trailing_sl_updated",
            positionId: String(p._id),
            symbol: p.symbol,
            newStop: p.stopLoss,
          });
        }
      }
    }

    await p.save();

    emitPaper(String(p.userId), {
      kind: "position_updated",
      positionId: String(p._id),
      symbol: p.symbol,
      currentPrice: price,
      unrealisedPnl: p.unrealisedPnl ?? 0,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
    });

    // SL check.
    if (
      p.stopLoss != null &&
      ((direction === "LONG" && price <= p.stopLoss) ||
        (direction === "SHORT" && price >= p.stopLoss))
    ) {
      const exitPrice = slMarketFill(
        p.stopLoss,
        p.qty,
        direction === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT"
      );
      try {
        const res = await closePosition(String(p.userId), String(p._id), {
          exitReason: "SL",
          exitPriceOverride: exitPrice,
        });
        emitPaper(String(p.userId), {
          kind: "sl_hit",
          positionId: String(p._id),
          symbol: p.symbol,
          exitPrice: res.exitPrice,
          loss: res.netPnl,
        });
      } catch (err) {
        logger.warn("SL close failed", { err: (err as Error).message });
      }
      return;
    }

    // TP check.
    if (
      p.takeProfit != null &&
      ((direction === "LONG" && price >= p.takeProfit) ||
        (direction === "SHORT" && price <= p.takeProfit))
    ) {
      const exitPrice = marketFill(
        p.takeProfit,
        p.qty,
        direction === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT"
      );
      try {
        const res = await closePosition(String(p.userId), String(p._id), {
          exitReason: "TP",
          exitPriceOverride: exitPrice,
        });
        emitPaper(String(p.userId), {
          kind: "tp_hit",
          positionId: String(p._id),
          symbol: p.symbol,
          exitPrice: res.exitPrice,
          profit: res.netPnl,
        });
      } catch (err) {
        logger.warn("TP close failed", { err: (err as Error).message });
      }
    }
  }

  private async tryFillPending(
    o: mongoose.HydratedDocument<typeof PaperOrder.prototype>,
    price: number
  ) {
    const isBuy = o.side === "BUY";
    let shouldFill = false;
    let fillPrice = 0;

    if (o.orderType === "LIMIT" && o.limitPrice != null) {
      // BUY LIMIT fills when price drops to limit or below. SELL LIMIT when price rises to limit or above.
      if ((isBuy && price <= o.limitPrice) || (!isBuy && price >= o.limitPrice)) {
        shouldFill = true;
        fillPrice = limitFill(o.limitPrice);
      }
    } else if (o.orderType === "SL_MARKET" && o.triggerPrice != null) {
      // BUY SL triggers when price rises through trigger; SELL SL when price falls through.
      if ((isBuy && price >= o.triggerPrice) || (!isBuy && price <= o.triggerPrice)) {
        shouldFill = true;
        fillPrice = slMarketFill(o.triggerPrice, o.qty, isBuy ? "OPEN_LONG" : "OPEN_SHORT");
      }
    } else if (o.orderType === "SL_LIMIT" && o.triggerPrice != null && o.limitPrice != null) {
      if ((isBuy && price >= o.triggerPrice) || (!isBuy && price <= o.triggerPrice)) {
        // SL triggered → check if limit reachable on the same tick.
        if ((isBuy && price <= o.limitPrice) || (!isBuy && price >= o.limitPrice)) {
          shouldFill = true;
          fillPrice = limitFill(o.limitPrice);
        }
      }
    }
    if (!shouldFill) return;

    // Fill: cash drain + open/extend position. Inline-mini version of fillAndOpen.
    const account = await PaperAccount.findById(o.accountId);
    if (!account) return;
    const cost = fillPrice * o.qty;
    if (cost > account.currentCash + 1) {
      o.status = "REJECTED";
      o.rejectReason = "Insufficient cash at fill";
      await o.save();
      emitPaper(String(o.userId), {
        kind: "order_rejected",
        orderId: String(o._id),
        reason: o.rejectReason,
      });
      return;
    }
    const direction = isBuy ? "LONG" : "SHORT";
    const existing = await PaperPosition.findOne({
      accountId: o.accountId,
      symbol: o.symbol,
      direction,
    });
    let positionId: string;
    if (existing) {
      const newAvg = round2(
        (existing.avgEntryPrice * existing.qty + fillPrice * o.qty) / (existing.qty + o.qty)
      );
      existing.avgEntryPrice = newAvg;
      existing.qty += o.qty;
      existing.originalQty += o.qty;
      if (o.stopLoss != null) existing.stopLoss = o.stopLoss;
      if (o.takeProfit != null) existing.takeProfit = o.takeProfit;
      if (o.trailingStopPct != null) existing.trailingStopPct = o.trailingStopPct;
      await existing.save();
      positionId = String(existing._id);
    } else {
      const entrySignal = o.entrySignal ?? (await captureEntrySignal(o.symbol).catch(() => undefined));
      const p = await PaperPosition.create({
        accountId: o.accountId,
        userId: o.userId,
        symbol: o.symbol,
        direction,
        qty: o.qty,
        originalQty: o.qty,
        avgEntryPrice: fillPrice,
        currentPrice: fillPrice,
        unrealisedPnl: 0,
        stopLoss: o.stopLoss,
        takeProfit: o.takeProfit,
        trailingStopPct: o.trailingStopPct,
        highWatermark: fillPrice,
        lowWatermark: fillPrice,
        maxAdverseExcursion: fillPrice,
        maxFavorableExcursion: fillPrice,
        productType: o.productType,
        strategyTag: o.strategyTag,
        entrySignal,
        openedAt: new Date(),
      });
      positionId = String(p._id);
    }
    account.currentCash = round2(account.currentCash - cost);
    await account.save();
    o.status = "FILLED";
    o.filledAt = new Date();
    o.filledPrice = fillPrice;
    o.filledPositionId = new Types.ObjectId(positionId);
    await o.save();

    emitPaper(String(o.userId), {
      kind: "order_filled",
      orderId: String(o._id),
      symbol: o.symbol,
      side: o.side as "BUY" | "SELL",
      qty: o.qty,
      filledPrice: fillPrice,
      positionId,
    });
  }

  private async processQueuedMarketOrders() {
    const queued = await PaperOrder.find({ status: "QUEUED", orderType: "MARKET" });
    for (const o of queued) {
      const quote = await paperPriceFeed.fetch(o.symbol);
      if (!quote) continue;
      const account = await PaperAccount.findById(o.accountId);
      if (!account) continue;
      const fillPrice = marketFill(
        quote.price,
        o.qty,
        o.side === "BUY" ? "OPEN_LONG" : "OPEN_SHORT"
      );
      const cost = fillPrice * o.qty;
      if (cost > account.currentCash + 1) {
        o.status = "REJECTED";
        o.rejectReason = "Insufficient cash at market open";
        await o.save();
        emitPaper(String(o.userId), {
          kind: "order_rejected",
          orderId: String(o._id),
          reason: o.rejectReason,
        });
        continue;
      }
      o.status = "PENDING"; // tryFillPending isn't used for MARKET, so we
      // open the position directly inline instead.
      const direction = o.side === "BUY" ? "LONG" : "SHORT";
      const existing = await PaperPosition.findOne({
        accountId: o.accountId,
        symbol: o.symbol,
        direction,
      });
      let positionId: string;
      if (existing) {
        const newAvg = round2(
          (existing.avgEntryPrice * existing.qty + fillPrice * o.qty) /
            (existing.qty + o.qty)
        );
        existing.avgEntryPrice = newAvg;
        existing.qty += o.qty;
        existing.originalQty += o.qty;
        await existing.save();
        positionId = String(existing._id);
      } else {
        const p = await PaperPosition.create({
          accountId: o.accountId,
          userId: o.userId,
          symbol: o.symbol,
          direction,
          qty: o.qty,
          originalQty: o.qty,
          avgEntryPrice: fillPrice,
          currentPrice: fillPrice,
          stopLoss: o.stopLoss,
          takeProfit: o.takeProfit,
          trailingStopPct: o.trailingStopPct,
          highWatermark: fillPrice,
          lowWatermark: fillPrice,
          maxAdverseExcursion: fillPrice,
          maxFavorableExcursion: fillPrice,
          productType: o.productType,
          strategyTag: o.strategyTag,
          entrySignal: o.entrySignal,
          openedAt: new Date(),
        });
        positionId = String(p._id);
      }
      account.currentCash = round2(account.currentCash - cost);
      await account.save();
      o.status = "FILLED";
      o.filledAt = new Date();
      o.filledPrice = fillPrice;
      o.filledPositionId = new Types.ObjectId(positionId) as never;
      await o.save();
      emitPaper(String(o.userId), {
        kind: "order_filled",
        orderId: String(o._id),
        symbol: o.symbol,
        side: o.side as "BUY" | "SELL",
        qty: o.qty,
        filledPrice: fillPrice,
        positionId,
      });
    }
  }

  private async eodSquareoff() {
    const positions = await PaperPosition.find({ productType: "MIS" });
    for (const p of positions) {
      const quote = await paperPriceFeed.fetch(p.symbol);
      if (!quote) continue;
      const exitPrice = marketFill(
        quote.price,
        p.qty,
        p.direction === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT"
      );
      try {
        await closePosition(String(p.userId), String(p._id), {
          exitReason: "AUTO_SQUAREOFF_EOD",
          exitPriceOverride: exitPrice,
        });
      } catch (err) {
        logger.warn("EOD squareoff failed", { err: (err as Error).message });
      }
    }
  }
}

export const paperPositionManager = new PaperPositionManager();
