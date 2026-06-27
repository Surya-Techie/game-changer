// Snapshots the AI signal + premium-indicator state at the moment of
// entry so the journal can later answer "did I trade with or against
// the AI?" without re-querying historical state.
//
// Tolerant of missing fields — the snapshot is a "best effort" capture;
// every field is optional so the order goes through even when the AI
// service is briefly down.

import axios from "axios";
import { Signal } from "../../models/Signal.js";
import { aiHeaders } from "../../utils/aiHeaders.js";

const AI_BASE = process.env.AI_SERVICE_URL ?? "http://localhost:8000";

export interface EntrySignalSnapshot {
  capturedAt: number;
  signal?: {
    action: "BUY" | "SELL" | "HOLD";
    confidence: number;
    price?: number;
    suggestedStop?: number;
    suggestedTarget?: number;
    reason?: string;
  };
  composite?: {
    score: number;
    label: string;
    subSignals?: Record<string, number>;
  };
  indicators?: Record<string, unknown>;
}

export async function captureEntrySignal(symbol: string): Promise<EntrySignalSnapshot> {
  const snap: EntrySignalSnapshot = { capturedAt: Date.now() };

  // Latest stored signal for this symbol — produced by the existing
  // signal engine, no external dependency.
  try {
    const sig = await Signal.findOne({ symbol })
      .sort({ createdAt: -1 })
      .lean<{
        action: "BUY" | "SELL" | "HOLD";
        confidence: number;
        price?: number;
        suggestedStop?: number;
        suggestedTarget?: number;
        reason?: string;
      }>();
    if (sig) {
      snap.signal = {
        action: sig.action,
        confidence: sig.confidence,
        price: sig.price,
        suggestedStop: sig.suggestedStop,
        suggestedTarget: sig.suggestedTarget,
        reason: sig.reason,
      };
    }
  } catch {
    // ignore — signal is optional context
  }

  // Composite score (Gainz Alpha) — fetched from the AI service if reachable.
  try {
    const res = await axios.get(`${AI_BASE}/composite/${encodeURIComponent(symbol)}`, {
      timeout: 2_000,
      headers: aiHeaders(),
    });
    if (res.data && typeof res.data === "object") {
      snap.composite = res.data as EntrySignalSnapshot["composite"];
    }
  } catch {
    // optional
  }

  return snap;
}
