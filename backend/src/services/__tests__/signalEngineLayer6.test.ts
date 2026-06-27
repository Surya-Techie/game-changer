/**
 * Phase 11.1 — signalEngine Layer 6 schema test.
 *
 * Verifies that the Signal Mongoose schema accepts the new
 * `pattern_confirmation` sub-document (Layer 6 added in Phase 11) and that
 * the SignalEvent type carries it through to the bus consumer. We don't
 * spin up the full signalEngine.tick() loop (that would need a real
 * candleAggregator + AI service); we just confirm the model + event-bus
 * surface contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.USE_INMEM_MONGO = "true";
process.env.MOCK_FEED_ENABLED = "false";

import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../../db/mongo.js";
import { Signal } from "../../models/Signal.js";
import { bus, type SignalEvent } from "../eventBus.js";


test("Signal schema persists pattern_confirmation sub-document", async () => {
  await connectMongo();
  try {
    const doc = await Signal.create({
      symbol: "RELIANCE",
      action: "BUY",
      confidence: 0.78,
      price: 2800,
      reason: "test",
      pattern_confirmation: {
        pattern_name: "Bullish Engulfing",
        grade: "A",
        direction: "bullish",
        confidence: 84,
        timeframe: "M15",
        agrees: true,
        delta: 0.08,
      },
    });
    const fresh = await Signal.findById(doc._id).lean();
    assert.ok(fresh, "saved signal should be retrievable");
    const pc = (fresh as { pattern_confirmation?: Record<string, unknown> }).pattern_confirmation;
    assert.ok(pc, "pattern_confirmation should round-trip");
    assert.equal(pc!.pattern_name, "Bullish Engulfing");
    assert.equal(pc!.agrees, true);
    assert.equal(pc!.delta, 0.08);
  } finally {
    await mongoose.connection.dropDatabase();
    await disconnectMongo();
  }
});


test("SignalEvent carries pattern_confirmation through the bus", async () => {
  const received: SignalEvent[] = [];
  const handler = (s: SignalEvent) => received.push(s);
  bus.on("signal", handler);
  try {
    bus.emit("signal", {
      signalId: "abc123",
      symbol: "TCS",
      action: "SELL",
      confidence: 0.63,
      price: 3600,
      reason: "Pattern conflicts",
      pattern_confirmation: {
        pattern_name: "Bullish Pin Bar",
        grade: "B",
        direction: "bullish",
        confidence: 76,
        timeframe: "M15",
        agrees: false,
        delta: -0.05,
      },
    });
    assert.equal(received.length, 1);
    const ev = received[0];
    assert.ok(ev.pattern_confirmation, "pattern_confirmation should be present on the event");
    assert.equal(ev.pattern_confirmation!.agrees, false);
    assert.equal(ev.pattern_confirmation!.delta, -0.05);
  } finally {
    bus.off("signal", handler);
  }
});
