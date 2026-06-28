import { EventEmitter } from "node:events";
import type { Tick } from "./mockFeed.js";
import type { PaperEventEnvelope } from "./paper/paperEvents.js";

/**
 * In-process event bus that the trading engine and WebSocket layer subscribe to.
 * Decouples signal generation, order execution, and notification.
 */
export interface SignalEvent {
  signalId: string;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  price: number;
  suggestedEntry?: number;
  suggestedStop?: number;
  suggestedTarget?: number;
  reason?: string;
  // Phase 11 — Layer 6 pattern confirmation snapshot (best agreeing or
  // conflicting pattern at signal time). null when no high-confidence pattern fired.
  pattern_confirmation?: {
    pattern_name: string;
    grade?: string;
    direction?: "bullish" | "bearish" | "continuation" | "neutral";
    confidence?: number;
    timeframe?: string;
    agrees?: boolean;
    delta?: number;
  };
}

export interface OrderEvent {
  userId: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  status: string;
  filledPrice?: number;
}

export interface PositionEvent {
  userId: string;
  positionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  status: "OPEN" | "CLOSED";
  exitPrice?: number;
  exitReason?: string;
  realisedPnl?: number;
}

export interface PortfolioEvent {
  userId: string;
  capital: number;
  equity: number;
  realisedPnl: number;
  unrealisedPnl: number;
  dailyPnl: number;
  openPositions: number;
}

/** Trendline overlay coordinate written by Western/institutional detectors. */
export interface TrendlinePoint {
  time: number;
  price: number;
}

/**
 * PatternEvent — emitted by the patternEngine whenever a confidence-≥75
 * pattern fires that agrees with the current AI signal direction. Fanned
 * out to every client subscribed to the symbol.
 */
export interface PatternEvent {
  patternId?: string; // Mongo _id (only when persisted)
  symbol: string;
  timeframe: string;
  pattern_name: string;
  category?: string;
  direction: "bullish" | "bearish" | "continuation" | "neutral";
  confidence: number;     // 0..100
  grade: string;          // A+ | A | B | C
  candle_indices: number[];
  trendline_points: TrendlinePoint[];
  entry?: number;
  target?: number;
  stop?: number;
  rr?: number;
  ai_explanation?: string;
  detected_at: number;    // epoch ms
}

/**
 * PatternSignalEvent — emitted when confidence ≥85 AND paper-trading is
 * enabled. Same payload as PatternEvent plus a discrete BUY/SELL action so
 * the paper terminal can prefill an order ticket.
 */
export interface PatternSignalEvent extends PatternEvent {
  signal_action: "BUY" | "SELL";
}

/**
 * PatternTrainingProgressEvent — mirrored from the AI service's training
 * job runner via the /internal/patterns/train-progress webhook. Broadcast
 * to admin connections only.
 */
export interface PatternTrainingProgressEvent {
  job_id: string;
  status: string;     // queued | running | completed | failed | cancelled
  percent: number;    // 0..100
  message: string;
  timeframe?: string;
  finished_at?: string;
  error?: string;
}

type Events = {
  tick: (t: Tick) => void;
  signal: (s: SignalEvent) => void;
  order: (o: OrderEvent) => void;
  position: (p: PositionEvent) => void;
  portfolio: (p: PortfolioEvent) => void;
  paper: (e: PaperEventEnvelope) => void;
  pattern: (p: PatternEvent) => void;
  pattern_signal: (p: PatternSignalEvent) => void;
  pattern_training_progress: (p: PatternTrainingProgressEvent) => void;
};

class TypedBus extends EventEmitter {
  override emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof Events>(event: K, listener: Events[K]): this {
    return super.on(event, listener as never);
  }
}

export const bus = new TypedBus();
bus.setMaxListeners(50);
