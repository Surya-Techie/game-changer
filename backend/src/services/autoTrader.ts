import { AccountState } from "../models/AccountState.js";
import { Position } from "../models/Position.js";
import { Order } from "../models/Order.js";
import { positionManager } from "./positionManager.js";
import { evaluateNewPosition, getOrCreateAccountState } from "./riskManager.js";
import { bus, type SignalEvent } from "./eventBus.js";
import { broker } from "./brokers/registry.js";
import { isMarketOpen } from "./paper/marketHours.js";
import { logger } from "../utils/logger.js";

class AutoTrader {
  // Track market-open transitions so we only flush the queue once per open.
  private wasOpen = false;
  private flushTimer: NodeJS.Timeout | undefined;

  start() {
    bus.on("signal", (sig) => {
      void this.handleSignal(sig).catch((err) =>
        logger.error("AutoTrader error", { err: (err as Error).message })
      );
    });

    // Background market-clock watcher. Polls every 30s; when the market
    // flips from closed→open, replay any auto-trade orders that were
    // queued overnight. We do not bother with intra-day re-emission
    // since live signals fire continuously.
    this.wasOpen = isMarketOpen();
    this.flushTimer = setInterval(() => {
      const open = isMarketOpen();
      if (open && !this.wasOpen) {
        void this.flushQueuedAutoOrders().catch((err) =>
          logger.warn("auto-trade queue flush failed", { err: (err as Error).message })
        );
      }
      this.wasOpen = open;
    }, 30_000);

    logger.info("AutoTrader started");
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
  }

  /** Replays PENDING auto-source orders through the broker at market open. */
  private async flushQueuedAutoOrders(): Promise<void> {
    const pending = await Order.find({ status: "PENDING", source: "AUTO" });
    if (pending.length === 0) return;
    logger.info("flushing queued auto-trade orders at market open", { count: pending.length });
    for (const o of pending) {
      try {
        const result = await broker().placeOrder({
          userId: String(o.userId),
          symbol: String(o.symbol),
          side: o.side as "BUY" | "SELL",
          qty: o.qty,
          orderType: "MARKET",
          productType: "MIS",
          source: "AUTO",
          sourceSignalId: o.sourceSignalId ? String(o.sourceSignalId) : undefined,
          tag: "QTI-AUTO-Q",
        });
        // Whether filled or rejected, the original placeholder Order doc
        // is now superseded — mark it cancelled so it doesn't linger.
        o.status = "CANCELLED";
        await o.save();
        logger.info("queued auto-trade replayed", {
          userId: String(o.userId),
          symbol: o.symbol,
          status: result.status,
          message: result.message,
        });
      } catch (err) {
        logger.warn("queued auto-trade replay failed", {
          orderId: String(o._id),
          err: (err as Error).message,
        });
      }
    }
  }

  private async handleSignal(sig: SignalEvent) {
    if (sig.action === "HOLD") return;
    const states = await AccountState.find({ autoTradeMode: "AUTO", killSwitch: false }).lean();
    for (const state of states) {
      try {
        await this.processForUser(String(state.userId), sig);
      } catch (err) {
        logger.warn("Auto-trade skipped", {
          userId: String(state.userId),
          symbol: sig.symbol,
          err: (err as Error).message,
        });
      }
    }
  }

  private async processForUser(userId: string, sig: SignalEvent) {
    const state = await getOrCreateAccountState(userId);
    if (sig.confidence < state.minConfidence) return;
    if (sig.suggestedEntry == null || sig.suggestedStop == null || sig.suggestedTarget == null) return;

    const desiredSide: "LONG" | "SHORT" = sig.action === "BUY" ? "LONG" : "SHORT";

    const existing = await Position.findOne({ userId, symbol: sig.symbol, status: "OPEN" });
    if (existing) {
      if (existing.side === desiredSide) return;
      await positionManager.closePosition(String(existing._id), "FLIP");
    }

    // Respect user's stop mode: override AI's stop/target if FIXED_PCT.
    let stop = sig.suggestedStop;
    let target = sig.suggestedTarget;
    if (state.stopMode === "FIXED_PCT" && state.stopPct > 0) {
      const entry = sig.suggestedEntry;
      const stopDist = entry * (state.stopPct / 100);
      const targetDist = stopDist * state.targetRR;
      if (desiredSide === "LONG") {
        stop = Math.round((entry - stopDist) * 100) / 100;
        target = Math.round((entry + targetDist) * 100) / 100;
      } else {
        stop = Math.round((entry + stopDist) * 100) / 100;
        target = Math.round((entry - targetDist) * 100) / 100;
      }
    }

    const risk = await evaluateNewPosition({
      userId,
      symbol: sig.symbol,
      entry: sig.suggestedEntry,
      stop,
    });
    if (!risk.allowed || !risk.qty) {
      logger.info("Skip auto-trade", { userId, symbol: sig.symbol, reason: risk.reason });
      return;
    }

    const orderSide = desiredSide === "LONG" ? "BUY" : "SELL";

    // After-hours queueing: when the market is closed (weekend / holiday
    // / outside 9:15–15:30 IST) we don't want to silently drop the signal.
    // Stash a PENDING order so the next-day scan can re-emit / execute it.
    // Mock-broker mode does its execution synchronously and needs the
    // market clock; live (Kite) sessions accept queued orders directly so
    // we let them pass through.
    if (broker().mode === "mock" && !isMarketOpen()) {
      await Order.create({
        userId,
        symbol: sig.symbol,
        side: orderSide,
        qty: risk.qty,
        type: "MARKET",
        status: "PENDING",
        source: "AUTO",
        sourceSignalId: sig.signalId,
      });
      logger.info("Auto-trade queued (market closed)", { userId, symbol: sig.symbol, side: orderSide, qty: risk.qty });
      return;
    }

    const result = await broker().placeOrder({
      userId,
      symbol: sig.symbol,
      side: orderSide,
      qty: risk.qty,
      orderType: "MARKET",
      productType: "MIS",
      source: "AUTO",
      sourceSignalId: sig.signalId,
      tag: "QTI-AUTO",
    });
    if (result.status === "REJECTED") {
      logger.warn("Auto-trade rejected by broker", { userId, symbol: sig.symbol, message: result.message });
      return;
    }
    // For live (Kite) orders fills are async — we record the position at
    // the suggested entry and let the broker's order webhook (or polling)
    // reconcile. For the mock adapter the fill is synchronous, so
    // filledPrice is always present.
    const fillPrice = result.filledPrice ?? sig.suggestedEntry;

    const pos = await Position.create({
      userId,
      symbol: sig.symbol,
      side: desiredSide,
      qty: risk.qty,
      originalQty: risk.qty,
      entryPrice: fillPrice,
      initialStopPrice: stop,
      stopPrice: stop,
      targetPrice: target,
      highWatermark: fillPrice,
      lowWatermark: fillPrice,
      partialTpDone: false,
      trailingPct: state.trailingStopEnabled ? state.trailingStopPct : undefined,
      sourceSignalId: sig.signalId,
    });

    bus.emit("position", {
      userId,
      positionId: String(pos._id),
      symbol: pos.symbol,
      side: pos.side as "LONG" | "SHORT",
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      stopPrice: pos.stopPrice ?? undefined,
      targetPrice: pos.targetPrice ?? undefined,
      status: "OPEN",
    });

    await positionManager.broadcastPortfolio(userId);

    logger.info("Auto-trade opened", {
      userId,
      symbol: pos.symbol,
      side: pos.side,
      qty: pos.qty,
      entry: pos.entryPrice,
      stop: pos.stopPrice,
      target: pos.targetPrice,
      stopMode: state.stopMode,
      trailing: state.trailingStopEnabled,
      partialTp: state.partialTpEnabled,
    });
  }
}

export const autoTrader = new AutoTrader();
