/**
 * Phase 5 integration smoke test.
 *
 * Verifies that:
 *  1. patternEngine.tick() emits a 'pattern' bus event when the AI service
 *     returns a confidence-≥75 pattern that agrees with the latest Signal.
 *  2. patternEngine.tick() emits a 'pattern_signal' event when the
 *     confidence is ≥85 AND a paper account is active.
 *  3. The dedupe map prevents duplicate emissions on subsequent ticks
 *     until the candle index advances.
 *  4. The /internal/patterns/train-progress webhook route emits a
 *     'pattern_training_progress' bus event.
 *
 * Runs against the in-memory Mongo bundled with the project; no network
 * calls, no real ai-service. We stub the aiClient.detectPatterns export.
 *
 * Uses node:test + node's built-in fetch for the HTTP webhook check
 * (supertest is not in the dependency tree).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";

// Force in-mem Mongo BEFORE importing app modules that read env.
process.env.USE_INMEM_MONGO = "true";
process.env.MOCK_FEED_ENABLED = "false";
process.env.PATTERN_ENGINE_REQUIRE_MARKET = "false";

import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../../db/mongo.js";
import { PaperAccount } from "../../models/PaperAccount.js";
import { Signal } from "../../models/Signal.js";
import { Watchlist } from "../../models/Watchlist.js";
import { bus, type PatternEvent, type PatternSignalEvent, type PatternTrainingProgressEvent } from "../eventBus.js";
import { _internal as engine } from "../patternEngine.js";
import internalPatternsRoutes from "../../routes/internalPatterns.js";


async function startTestApp(routesPath: string, router: express.Router): Promise<{ server: Server; url: string }> {
  const app = express();
  app.use(express.json());
  app.use(routesPath, router);
  return await new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}


test("patternEngine: emits 'pattern' for ≥75 confidence agreeing with signal", async () => {
  await connectMongo();
  try {
    const userId = new mongoose.Types.ObjectId();
    await Watchlist.create({ userId, name: "test", symbols: ["RELIANCE"] });
    await Signal.create({
      symbol: "RELIANCE",
      action: "BUY",
      confidence: 0.7,
      price: 2800,
      reason: "test",
    });

    engine.clearDedupe();
    engine.setDetectFn(async (symbol, timeframe) => ({
      symbol,
      timeframe,
      cached: false,
      served_at_ms: Date.now(),
      candles_used: 100,
      higher_tf: null,
      patterns: [
        {
          pattern_name: "Bullish Engulfing",
          detected: true,
          direction: "bullish",
          candle_indices: [98, 99],
          strength: 0.8,
          description: "test",
          historical_win_rate: 0.67,
          confidence_score: 82,
          grade: "A",
          category: "two_candle",
          score_breakdown: {},
          score_reasoning: [],
          filters: {},
          ml_probs: {},
        },
      ],
    }));

    const received: PatternEvent[] = [];
    bus.on("pattern", (p) => received.push(p));

    await engine.tick();

    const ev = received.find((e) => e.pattern_name === "Bullish Engulfing" && e.symbol === "RELIANCE");
    assert.ok(ev, `expected Bullish Engulfing for RELIANCE in received events; got ${received.length} events`);
    assert.equal(ev!.confidence, 82);
    assert.equal(ev!.grade, "A");
    assert.equal(ev!.direction, "bullish");

    // Dedupe: second tick should NOT re-emit (same last candle index).
    // The first tick fires once per timeframe (M5/M15/H1/D1) so we expect 4
    // events; the second tick should add zero.
    const before = received.length;
    await engine.tick();
    const after = received.length;
    assert.equal(after, before, `dedupe should suppress repeat emissions; got ${before} → ${after}`);

    engine.setDetectFn(null);
    bus.removeAllListeners("pattern");
  } finally {
    await disconnectMongo();
  }
});


test("patternEngine: emits 'pattern_signal' for ≥85 confidence with paper active", async () => {
  await connectMongo();
  try {
    const userId = new mongoose.Types.ObjectId();
    await Watchlist.create({ userId, name: "test", symbols: ["TCS"] });
    await PaperAccount.create({
      userId,
      name: "Active",
      startingCapital: 100_000,
      currentCash: 100_000,
      isActive: true,
    });

    engine.clearDedupe();
    engine.setDetectFn(async (symbol, timeframe) => ({
      symbol,
      timeframe,
      cached: false,
      served_at_ms: Date.now(),
      candles_used: 100,
      higher_tf: null,
      patterns: [
        {
          pattern_name: "Wyckoff Spring",
          detected: true,
          direction: "bullish",
          candle_indices: [79, 99],
          strength: 0.9,
          description: "test",
          historical_win_rate: 0.71,
          confidence_score: 88,
          grade: "A+",
          category: "institutional",
          score_breakdown: {},
          score_reasoning: [],
          filters: {},
          ml_probs: {},
          entry_price: 3700,
          target_price: 3750,
          stop_price: 3680,
          risk_reward: 2.5,
        },
      ],
    }));

    const signals: PatternSignalEvent[] = [];
    bus.on("pattern_signal", (p) => signals.push(p));

    await engine.tick();

    const sig = signals.find((s) => s.symbol === "TCS" && s.pattern_name === "Wyckoff Spring");
    assert.ok(sig, "expected a pattern_signal for the ≥85 pattern with paper active");
    assert.equal(sig!.signal_action, "BUY");
    assert.equal(sig!.entry, 3700);
    assert.equal(sig!.target, 3750);
    assert.equal(sig!.stop, 3680);

    engine.setDetectFn(null);
    bus.removeAllListeners("pattern");
    bus.removeAllListeners("pattern_signal");
  } finally {
    await disconnectMongo();
  }
});


test("internalPatterns: POST /train-progress emits bus event", async () => {
  const { server, url } = await startTestApp("/internal/patterns", internalPatternsRoutes);
  try {
    const received: PatternTrainingProgressEvent[] = [];
    bus.on("pattern_training_progress", (e) => received.push(e));

    const payload = {
      job_id: "abcd12345678",
      status: "running",
      percent: 55,
      message: "fitting models",
      timeframe: "D1",
    };
    const res = await fetch(`${url}/internal/patterns/train-progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].job_id, "abcd12345678");
    assert.equal(received[0].percent, 55);

    bus.removeAllListeners("pattern_training_progress");
  } finally {
    await closeServer(server);
  }
});


test("internalPatterns: secret enforced when configured", async () => {
  process.env.INTERNAL_WEBHOOK_SECRET = "topsecret";
  // Re-import the router so it picks up the env at handler-call time.
  // (The middleware reads the env on every call, so a fresh import isn't strictly required,
  // but we restart the server for cleanliness.)
  const { server, url } = await startTestApp("/internal/patterns", internalPatternsRoutes);
  try {
    const noHeader = await fetch(`${url}/internal/patterns/train-progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "abcd12345678", status: "running", percent: 0, message: "" }),
    });
    assert.equal(noHeader.status, 401);

    const wrongHeader = await fetch(`${url}/internal/patterns/train-progress`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Internal-Secret": "nope" },
      body: JSON.stringify({ job_id: "abcd12345678", status: "running", percent: 0, message: "" }),
    });
    assert.equal(wrongHeader.status, 401);

    const ok = await fetch(`${url}/internal/patterns/train-progress`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Internal-Secret": "topsecret" },
      body: JSON.stringify({ job_id: "abcd12345678", status: "running", percent: 1, message: "" }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await closeServer(server);
    delete process.env.INTERNAL_WEBHOOK_SECRET;
  }
});
