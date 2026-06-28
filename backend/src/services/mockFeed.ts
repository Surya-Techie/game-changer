import { EventEmitter } from "node:events";
import axios from "axios";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { isMarketOpen } from "./paper/marketHours.js";

export interface Tick {
  symbol: string;
  price: number;
  volume: number;
  ts: number;
}

interface SymbolState {
  symbol: string;
  price: number;
  drift: number; // small bias per step
  volatility: number; // stddev per step (fraction)
  anchor: number; // mean-reversion anchor
}

const UNIVERSE: Array<Omit<SymbolState, "drift" | "volatility" | "anchor"> & { vol: number }> = [
  { symbol: "RELIANCE",   price: 2850, vol: 0.0008 },
  { symbol: "TCS",        price: 3950, vol: 0.0007 },
  { symbol: "INFY",       price: 1620, vol: 0.0009 },
  { symbol: "HDFCBANK",   price: 1485, vol: 0.0007 },
  { symbol: "ICICIBANK",  price: 1175, vol: 0.0008 },
  { symbol: "SBIN",       price: 815,  vol: 0.001  },
  { symbol: "AXISBANK",   price: 1120, vol: 0.0009 },
  { symbol: "ITC",        price: 460,  vol: 0.0006 },
  { symbol: "LT",         price: 3540, vol: 0.0009 },
  { symbol: "BHARTIARTL", price: 1490, vol: 0.0008 },
  // --- expanded universe (Nifty-20 style high-cap names) ---
  { symbol: "MARUTI",     price: 12450, vol: 0.0010 },
  { symbol: "KOTAKBANK",  price: 1735,  vol: 0.0008 },
  { symbol: "BAJFINANCE", price: 7250,  vol: 0.0012 },
  { symbol: "HCLTECH",    price: 1420,  vol: 0.0008 },
  { symbol: "WIPRO",      price: 540,   vol: 0.0010 },
  { symbol: "ASIANPAINT", price: 2890,  vol: 0.0007 },
  { symbol: "NESTLEIND",  price: 23500, vol: 0.0006 },
  { symbol: "TITAN",      price: 3540,  vol: 0.0010 },
  { symbol: "ADANIENT",   price: 2880,  vol: 0.0015 },
  { symbol: "SUNPHARMA",  price: 1620,  vol: 0.0008 },
];

/** Display names for the 20 universe symbols (used on cards). */
export const SYMBOL_DISPLAY_NAME: Record<string, string> = {
  RELIANCE:   "Reliance Industries",
  TCS:        "Tata Consultancy Services",
  INFY:       "Infosys",
  HDFCBANK:   "HDFC Bank",
  ICICIBANK:  "ICICI Bank",
  SBIN:       "State Bank of India",
  AXISBANK:   "Axis Bank",
  ITC:        "ITC",
  LT:         "Larsen & Toubro",
  BHARTIARTL: "Bharti Airtel",
  MARUTI:     "Maruti Suzuki",
  KOTAKBANK:  "Kotak Mahindra Bank",
  BAJFINANCE: "Bajaj Finance",
  HCLTECH:    "HCL Technologies",
  WIPRO:      "Wipro",
  ASIANPAINT: "Asian Paints",
  NESTLEIND:  "Nestlé India",
  TITAN:      "Titan",
  ADANIENT:   "Adani Enterprises",
  SUNPHARMA:  "Sun Pharma",
};

/** Coarse sector tag — used by the top-stocks card. */
export const SYMBOL_SECTOR: Record<string, string> = {
  RELIANCE: "Energy", ONGC: "Energy",
  TCS: "IT", INFY: "IT", HCLTECH: "IT", WIPRO: "IT",
  HDFCBANK: "Banking", ICICIBANK: "Banking", SBIN: "Banking", AXISBANK: "Banking", KOTAKBANK: "Banking",
  BAJFINANCE: "Finance",
  ITC: "FMCG", NESTLEIND: "FMCG", ASIANPAINT: "FMCG",
  LT: "Infra", ADANIENT: "Infra",
  BHARTIARTL: "Telecom",
  MARUTI: "Auto",
  TITAN: "Consumer",
  SUNPHARMA: "Pharma",
};

class MockFeed extends EventEmitter {
  private states = new Map<string, SymbolState>();
  private timer?: NodeJS.Timeout;
  private realTimer?: NodeJS.Timeout;
  private running = false;
  private synthetic = false;
  // Wall-clock of the last successful NSE batch. We use it to suppress
  // synthetic ticks while a real feed is flowing — otherwise consumers
  // would see real + fake mixed together on the same symbol.
  private lastRealAt = 0;

  constructor() {
    super();
    for (const s of UNIVERSE) {
      this.states.set(s.symbol, {
        symbol: s.symbol,
        price: s.price,
        drift: 0,
        volatility: s.vol,
        anchor: s.price,
      });
    }
  }

  symbols(): string[] {
    return [...this.states.keys()];
  }

  /** True when real NSE ticks were emitted in the last 5 s. */
  isLive(): boolean {
    return Date.now() - this.lastRealAt < 5_000;
  }

  start(_intervalMs = 800) {
    if (this.running) return;
    this.running = true;
    logger.info("MockFeed started", { symbols: this.symbols().length });
    // By default the synthetic random-walk emitter is OFF — production wants
    // honest data only: during market hours pollReal() emits real yfinance
    // ticks, and outside market hours the last real close is shown frozen.
    //
    // MOCK_FEED_SYNTHETIC=true (dev.sh) re-enables the walk so prices MOVE
    // around the clock — required to actually exercise the auto-trade loop
    // end-to-end (open → stop/target hit → exit → trade) when NSE is closed.
    this.synthetic = (process.env.MOCK_FEED_SYNTHETIC ?? "false").toLowerCase() === "true";
    if (this.synthetic) {
      logger.info("MockFeed synthetic walk ENABLED (dev)", { intervalMs: _intervalMs });
      this.timer = setInterval(() => this.step(), _intervalMs);
    }

    // Single poller. Polls every 2 s during market hours, every 60 s
    // outside (last-close prices don't move, so frequent polls waste API).
    const tick = async () => {
      const t0 = Date.now();
      try {
        await this.pollReal();
        const dt = Date.now() - t0;
        const live = this.isLive();
        logger.info("MockFeed poll", {
          marketOpen: isMarketOpen(), elapsedMs: dt, live,
          lastRealAge: live ? Date.now() - this.lastRealAt : null,
        });
      } catch (err) {
        logger.warn("MockFeed poll threw", { err: (err as Error).message });
      }
      const intervalMs = isMarketOpen() ? 2_000 : 60_000;
      this.realTimer = setTimeout(tick, intervalMs);
    };
    // Immediate first poll so the chart paints with real data on load.
    void tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.realTimer) clearTimeout(this.realTimer);
    this.realTimer = undefined;
    this.running = false;
  }

  private step() {
    // Don't pollute the stream with synthetic ticks while real NSE data
    // is in-flight (within the last 5 s).
    if (this.isLive()) return;
    const now = Date.now();
    for (const state of this.states.values()) {
      const z = randn();
      const meanReversion = (state.anchor - state.price) / state.anchor; // pulls toward anchor
      // Dev synthetic mode amplifies per-step volatility so prices travel
      // far enough to hit stops/targets in an observable window — but kept
      // modest so single steps don't gap violently through stops (which
      // would inflate slippage and trip the daily-loss kill switch in
      // seconds). Light mean-reversion lets trends run toward targets too.
      const SYNTH_VOL_MULT = 4;
      const pctChange = 0.02 * meanReversion + state.volatility * SYNTH_VOL_MULT * z;
      const newPrice = Math.max(0.01, state.price * (1 + pctChange));
      state.price = round2(newPrice);

      // Drift the anchor slowly so trends emerge.
      state.anchor = round2(state.anchor * (1 + 0.00005 * randn()));

      const volume = Math.floor(50 + Math.random() * 500);
      const tick: Tick = { symbol: state.symbol, price: state.price, volume, ts: now };
      this.emit("tick", tick);
    }
  }

  /** Fetch the whole universe's LTPs from NSE (via ai-service) and emit
   *  one tick per symbol. Runs even outside market hours so the chart
   *  shows the REAL last-close price instead of synthetic noise. */
  private async pollReal(): Promise<void> {
    const symbols = [...this.states.keys()];
    if (symbols.length === 0) return;
    try {
      const url = `${env.aiServiceUrl}/nse-live`;
      // 10 s budget: yfinance cold-cache + 20-symbol parallel fetch is
      // ~2.5 s; this leaves headroom for first-run yfinance throttling
      // and network blips.
      const { data } = await axios.get(url, {
        params: { symbols: symbols.join(",") },
        timeout: 10_000,
      });
      if (!data?.available || !data.quotes) return;
      const quotes = data.quotes as Record<string, { ltp: number; ts: number }>;
      const now = Date.now();
      let emitted = 0;
      for (const [sym, q] of Object.entries(quotes)) {
        const state = this.states.get(sym);
        if (!state) continue;
        const px = Number(q.ltp);
        if (!isFinite(px) || px <= 0) continue;
        // Adopt the real price as the new anchor so synthetic ticks
        // resume from the right level if NSE goes briefly unreachable.
        state.price = round2(px);
        state.anchor = state.price;
        const tick: Tick = { symbol: sym, price: state.price, volume: 0, ts: q.ts ?? now };
        this.emit("tick", tick);
        emitted++;
      }
      if (emitted > 0) this.lastRealAt = now;
    } catch (err) {
      // Network or NSE blocked us — fall back silently to synthetic.
      logger.debug?.("NSE poll failed, falling back to synthetic", {
        err: (err as Error).message,
      });
    }
  }
}

function randn(): number {
  // Box–Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const mockFeed = new MockFeed();
