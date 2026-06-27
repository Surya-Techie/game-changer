import { Signal } from "../models/Signal.js";
import { bus, type SignalEvent } from "./eventBus.js";
import type { Tick } from "./mockFeed.js";
import { logger } from "../utils/logger.js";

/**
 * Watches every live signal that has a stop and a target and decides, in
 * real time, whether the trade idea would have worked.
 *
 *   BUY  → WIN  if price hits target before stop, LOSS if it hits stop first
 *   SELL → WIN  if price hits target before stop, LOSS if it hits stop first
 *
 * Outcomes are persisted on the Signal document and broadcast on the bus so
 * the UI can show a *measured* rolling hit-rate instead of an unverified
 * confidence number. This is the only honest substitute for the "100%
 * accuracy" the user asked for: the system reports how often it has actually
 * been right, going forward.
 *
 * A signal that never reaches either level inside `expireAfterMs` is marked
 * EXPIRED and excluded from the hit-rate denominator — it neither succeeded
 * nor failed.
 */
interface Pending {
  signalId: string;
  symbol: string;
  action: "BUY" | "SELL";
  stop: number;
  target: number;
  createdAt: number;
}

const EXPIRE_AFTER_MS = 1000 * 60 * 60 * 2; // 2 hours of trading time
const SWEEP_INTERVAL_MS = 60_000;

class SignalOutcomeTracker {
  private bySymbol = new Map<string, Pending[]>();
  private sweepTimer?: NodeJS.Timeout;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.hydrateFromMongo();

    bus.on("signal", (s) => this.onSignal(s));
    bus.on("tick", (t) => this.onTick(t));

    this.sweepTimer = setInterval(() => void this.sweepExpired(), SWEEP_INTERVAL_MS);
    logger.info("SignalOutcomeTracker started", {
      pending: Array.from(this.bySymbol.values()).reduce((n, arr) => n + arr.length, 0),
    });
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.bySymbol.clear();
    this.started = false;
  }

  private async hydrateFromMongo(): Promise<void> {
    const docs = await Signal.find({
      outcome: "PENDING",
      action: { $in: ["BUY", "SELL"] },
      suggestedStop: { $ne: null },
      suggestedTarget: { $ne: null },
    })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    for (const d of docs) {
      if (d.suggestedStop == null || d.suggestedTarget == null) continue;
      this.addPending({
        signalId: String(d._id),
        symbol: d.symbol,
        action: d.action as "BUY" | "SELL",
        stop: d.suggestedStop,
        target: d.suggestedTarget,
        createdAt: new Date(d.createdAt).getTime(),
      });
    }
  }

  private addPending(p: Pending): void {
    const arr = this.bySymbol.get(p.symbol) ?? [];
    arr.push(p);
    this.bySymbol.set(p.symbol, arr);
  }

  private onSignal(s: SignalEvent): void {
    if (s.action === "HOLD") return;
    if (s.suggestedStop == null || s.suggestedTarget == null) return;
    this.addPending({
      signalId: s.signalId,
      symbol: s.symbol,
      action: s.action,
      stop: s.suggestedStop,
      target: s.suggestedTarget,
      createdAt: Date.now(),
    });
  }

  private onTick(tick: Tick): void {
    const arr = this.bySymbol.get(tick.symbol);
    if (!arr || arr.length === 0) return;

    const survivors: Pending[] = [];
    for (const p of arr) {
      const hit = this.checkHit(p, tick.price);
      if (!hit) {
        survivors.push(p);
        continue;
      }
      void this.recordOutcome(p, hit, tick.price);
    }
    if (survivors.length === arr.length) return;
    if (survivors.length === 0) this.bySymbol.delete(tick.symbol);
    else this.bySymbol.set(tick.symbol, survivors);
  }

  private checkHit(p: Pending, price: number): "WIN" | "LOSS" | null {
    if (p.action === "BUY") {
      if (price >= p.target) return "WIN";
      if (price <= p.stop) return "LOSS";
    } else {
      if (price <= p.target) return "WIN";
      if (price >= p.stop) return "LOSS";
    }
    return null;
  }

  private async recordOutcome(p: Pending, outcome: "WIN" | "LOSS" | "EXPIRED", price: number): Promise<void> {
    try {
      await Signal.updateOne(
        { _id: p.signalId, outcome: "PENDING" },
        { $set: { outcome, outcomePrice: price, outcomeAt: new Date() } }
      );
      logger.info("Signal outcome", { signalId: p.signalId, symbol: p.symbol, action: p.action, outcome, price });
    } catch (err) {
      logger.error("Failed to record signal outcome", { signalId: p.signalId, err: (err as Error).message });
    }
  }

  private async sweepExpired(): Promise<void> {
    const cutoff = Date.now() - EXPIRE_AFTER_MS;
    for (const [symbol, arr] of this.bySymbol.entries()) {
      const survivors: Pending[] = [];
      for (const p of arr) {
        if (p.createdAt <= cutoff) {
          void this.recordOutcome(p, "EXPIRED", 0);
        } else {
          survivors.push(p);
        }
      }
      if (survivors.length === 0) this.bySymbol.delete(symbol);
      else this.bySymbol.set(symbol, survivors);
    }
  }

  pendingCount(): number {
    let n = 0;
    for (const arr of this.bySymbol.values()) n += arr.length;
    return n;
  }
}

export const signalOutcomeTracker = new SignalOutcomeTracker();
