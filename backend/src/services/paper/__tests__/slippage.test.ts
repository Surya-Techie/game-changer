import { test } from "node:test";
import assert from "node:assert/strict";
import { marketFill, limitFill, slMarketFill } from "../slippage.js";

test("MARKET LONG entry fills above LTP (worse side)", () => {
  const fill = marketFill(100, 10, "OPEN_LONG");
  assert.ok(fill > 100, `expected fill > 100, got ${fill}`);
  // 15 bps = 0.15% = 0.15 → 100.15
  assert.ok(Math.abs(fill - 100.15) < 0.01);
});

test("MARKET SHORT entry fills below LTP", () => {
  const fill = marketFill(100, 10, "OPEN_SHORT");
  assert.ok(fill < 100, `expected fill < 100, got ${fill}`);
  assert.ok(Math.abs(fill - 99.85) < 0.01);
});

test("Large turnover adds extra 5 bps", () => {
  // Reference price × qty must exceed ₹5L for the extra slippage to kick in.
  const small = marketFill(500, 100, "OPEN_LONG"); // 50k turnover → 15 bps
  const big = marketFill(500, 2000, "OPEN_LONG"); // 1M turnover → 20 bps
  const smallSlipBps = ((small - 500) / 500) * 10_000;
  const bigSlipBps = ((big - 500) / 500) * 10_000;
  assert.ok(Math.abs(smallSlipBps - 15) < 0.5, `small ≈ 15 bps, got ${smallSlipBps}`);
  assert.ok(Math.abs(bigSlipBps - 20) < 0.5, `big ≈ 20 bps, got ${bigSlipBps}`);
});

test("LIMIT fill is exact, no slippage", () => {
  assert.equal(limitFill(123.45), 123.45);
  assert.equal(limitFill(100.999), 101);
});

test("SL_MARKET applies wider 20 bps", () => {
  const fill = slMarketFill(100, 10, "OPEN_LONG");
  assert.ok(Math.abs(fill - 100.2) < 0.01, `SL slip should be 20 bps, got ${fill}`);
});
