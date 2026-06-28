import { Position } from "../models/Position.js";
import { Trade } from "../models/Trade.js";
import { AccountState } from "../models/AccountState.js";
import { User } from "../models/User.js";
import { bus } from "./eventBus.js";
import { paperBroker } from "./paperBroker.js";
import { priceBook } from "./priceBook.js";
import { recordPnl, getOrCreateAccountState } from "./riskManager.js";
import { logger } from "../utils/logger.js";

class PositionManager {
  private busy = new Set<string>();

  start() {
    bus.on("tick", (tick) => {
      void this.onTick(tick.symbol, tick.price);
    });
    logger.info("PositionManager started");
  }

  private async onTick(symbol: string, price: number) {
    const positions = await Position.find({ symbol, status: "OPEN" });
    for (const pos of positions) {
      const id = String(pos._id);
      if (this.busy.has(id)) continue;
      try {
        // Update watermarks for trailing stop.
        let updated = false;
        if (pos.side === "LONG" && price > (pos.highWatermark ?? pos.entryPrice)) {
          pos.highWatermark = price;
          updated = true;
        } else if (pos.side === "SHORT" && price < (pos.lowWatermark ?? pos.entryPrice)) {
          pos.lowWatermark = price;
          updated = true;
        }

        // Apply trailing stop if configured.
        if (pos.trailingPct && pos.trailingPct > 0) {
          if (pos.side === "LONG" && pos.highWatermark != null) {
            const candidate = pos.highWatermark * (1 - pos.trailingPct / 100);
            if (pos.stopPrice == null || candidate > pos.stopPrice) {
              pos.stopPrice = round2(candidate);
              updated = true;
            }
          } else if (pos.side === "SHORT" && pos.lowWatermark != null) {
            const candidate = pos.lowWatermark * (1 + pos.trailingPct / 100);
            if (pos.stopPrice == null || candidate < pos.stopPrice) {
              pos.stopPrice = round2(candidate);
              updated = true;
            }
          }
        }

        if (updated) await pos.save();

        // Partial TP at 1R, then move stop to break-even.
        const state = await AccountState.findOne({ userId: pos.userId }).lean();
        if (state?.partialTpEnabled && !pos.partialTpDone && pos.initialStopPrice != null) {
          const r = Math.abs(pos.entryPrice - pos.initialStopPrice);
          const oneR = pos.side === "LONG" ? pos.entryPrice + r : pos.entryPrice - r;
          const triggered = pos.side === "LONG" ? price >= oneR : price <= oneR;
          if (triggered && pos.qty >= 2) {
            this.busy.add(id);
            await this.executePartialTp(id, r);
            this.busy.delete(id);
            continue; // tick handled
          }
        }

        // SL or TP hit on the remaining qty.
        let reason: "SL" | "TP" | "TRAIL" | null = null;
        if (pos.side === "LONG") {
          if (pos.stopPrice != null && price <= pos.stopPrice) {
            reason = pos.partialTpDone ? "TRAIL" : "SL";
          } else if (pos.targetPrice != null && price >= pos.targetPrice) {
            reason = "TP";
          }
        } else {
          if (pos.stopPrice != null && price >= pos.stopPrice) {
            reason = pos.partialTpDone ? "TRAIL" : "SL";
          } else if (pos.targetPrice != null && price <= pos.targetPrice) {
            reason = "TP";
          }
        }
        if (reason) {
          this.busy.add(id);
          await this.closePosition(id, reason);
          this.busy.delete(id);
        }
      } catch (err) {
        this.busy.delete(id);
        logger.error("Position tick handling failed", { id, err: (err as Error).message });
      }
    }
  }

  /**
   * Half-close at 1R, move remaining stop to break-even.
   */
  private async executePartialTp(positionId: string, r: number) {
    const pos = await Position.findOne({ _id: positionId, status: "OPEN" });
    if (!pos || pos.partialTpDone || pos.qty < 2) return;
    const halfQty = Math.floor(pos.qty / 2);
    if (halfQty <= 0) return;
    const exitSide = pos.side === "LONG" ? "SELL" : "BUY";
    const { filledPrice } = await paperBroker.submitMarket({
      userId: String(pos.userId),
      symbol: pos.symbol,
      side: exitSide,
      qty: halfQty,
      source: "AUTO",
    });
    const pnl =
      pos.side === "LONG"
        ? (filledPrice - pos.entryPrice) * halfQty
        : (pos.entryPrice - filledPrice) * halfQty;
    const pnlPct = ((filledPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === "LONG" ? 1 : -1);

    await Trade.create({
      userId: pos.userId,
      positionId: pos._id,
      symbol: pos.symbol,
      side: pos.side,
      qty: halfQty,
      entryPrice: pos.entryPrice,
      exitPrice: filledPrice,
      entryAt: pos.entryAt,
      exitAt: new Date(),
      exitReason: "PARTIAL_TP",
      pnl: round2(pnl),
      pnlPct: round4(pnlPct),
      durationMs: Date.now() - (pos.entryAt?.getTime() ?? 0),
    });

    await recordPnl(String(pos.userId), pnl);

    pos.qty -= halfQty;
    pos.partialTpDone = true;
    pos.stopPrice = pos.entryPrice; // break-even
    await pos.save();

    bus.emit("position", {
      userId: String(pos.userId),
      positionId: String(pos._id),
      symbol: pos.symbol,
      side: pos.side as "LONG" | "SHORT",
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      stopPrice: pos.stopPrice,
      targetPrice: pos.targetPrice ?? undefined,
      status: "OPEN",
      exitReason: "PARTIAL_TP",
      realisedPnl: round2(pnl),
    });

    await this.broadcastPortfolio(String(pos.userId));

    logger.info("Partial TP", {
      symbol: pos.symbol,
      side: pos.side,
      halfQty,
      fill: filledPrice,
      pnl: round2(pnl),
      remainingQty: pos.qty,
      r,
    });
  }

  async closePosition(positionId: string, reason: "SL" | "TP" | "TRAIL" | "MANUAL" | "FLIP") {
    const pos = await Position.findOne({ _id: positionId, status: "OPEN" });
    if (!pos) return null;

    const exitSide = pos.side === "LONG" ? "SELL" : "BUY";
    const { filledPrice } = await paperBroker.submitMarket({
      userId: String(pos.userId),
      symbol: pos.symbol,
      side: exitSide,
      qty: pos.qty,
      source: "AUTO",
    });

    const pnl =
      pos.side === "LONG"
        ? (filledPrice - pos.entryPrice) * pos.qty
        : (pos.entryPrice - filledPrice) * pos.qty;
    const pnlPct = ((filledPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === "LONG" ? 1 : -1);

    pos.status = "CLOSED";
    pos.exitPrice = filledPrice;
    pos.exitAt = new Date();
    pos.exitReason = reason;
    pos.realisedPnl = round2(pnl);
    await pos.save();

    await Trade.create({
      userId: pos.userId,
      positionId: pos._id,
      symbol: pos.symbol,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitPrice: filledPrice,
      entryAt: pos.entryAt,
      exitAt: pos.exitAt,
      exitReason: reason,
      pnl: round2(pnl),
      pnlPct: round4(pnlPct),
      durationMs: pos.exitAt.getTime() - (pos.entryAt?.getTime() ?? 0),
    });

    await recordPnl(String(pos.userId), pnl);

    bus.emit("position", {
      userId: String(pos.userId),
      positionId: String(pos._id),
      symbol: pos.symbol,
      side: pos.side as "LONG" | "SHORT",
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      status: "CLOSED",
      exitPrice: filledPrice,
      exitReason: reason,
      realisedPnl: round2(pnl),
    });

    await this.broadcastPortfolio(String(pos.userId));

    logger.info("Position closed", {
      symbol: pos.symbol,
      side: pos.side,
      reason,
      pnl: round2(pnl),
    });

    return pos;
  }

  async broadcastPortfolio(userId: string) {
    const state = await getOrCreateAccountState(userId);
    const openPositions = await Position.find({ userId, status: "OPEN" }).lean();
    let unrealised = 0;
    for (const p of openPositions) {
      const px = priceBook.price(p.symbol);
      if (px == null) continue;
      unrealised += p.side === "LONG" ? (px - p.entryPrice) * p.qty : (p.entryPrice - px) * p.qty;
    }
    // Equity is the CAPITAL BASE plus realised + unrealised P&L — not the
    // P&L alone (that bug showed a negative equity on the dashboard). Match
    // the REST /api/portfolio default of 100k when no User capital is set.
    const user = await User.findById(userId).select("capital").lean();
    const capital = user?.capital ?? 100_000;
    bus.emit("portfolio", {
      userId,
      capital,
      equity: round2(capital + state.realisedPnl + unrealised),
      realisedPnl: round2(state.realisedPnl),
      unrealisedPnl: round2(unrealised),
      dailyPnl: round2(state.dailyPnl),
      openPositions: openPositions.length,
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export const positionManager = new PositionManager();
