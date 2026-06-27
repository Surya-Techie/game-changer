import { mockFeed, type Tick } from "./mockFeed.js";
import { bus } from "./eventBus.js";

/**
 * Tracks the latest known price per symbol. The trading engine, paper broker,
 * and position manager all read from this single source of truth.
 */
class PriceBook {
  private last = new Map<string, number>();

  constructor() {
    mockFeed.on("tick", (tick: Tick) => {
      this.last.set(tick.symbol, tick.price);
      bus.emit("tick", tick);
    });
  }

  price(symbol: string): number | undefined {
    return this.last.get(symbol);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.last);
  }
}

export const priceBook = new PriceBook();
