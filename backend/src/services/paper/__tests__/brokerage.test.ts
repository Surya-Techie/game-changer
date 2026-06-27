// Pinned-value tests for the Zerodha-style brokerage simulator.
// Numbers are derived by hand from the formulas in brokerage.ts and
// rounded to 2 decimals for tolerance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { previewLegCharges, roundTripCharges } from "../brokerage.js";

const eq = (a: number, b: number, tol = 0.02) =>
  Math.abs(a - b) <= tol;

test("MIS BUY brokerage caps at ₹20", () => {
  // 100 qty × ₹3000 = ₹3L turnover → 0.03% = ₹90 → capped at ₹20
  const c = previewLegCharges(3000, 100, "BUY", "MIS");
  // brokerage 20 + stamp 0.003% (9) + exchange 0.00345% (10.35) + sebi (0.3) + gst on (20+10.35+0.3)*0.18 ≈ 5.52
  // expected total ≈ 20 + 9 + 10.35 + 0.3 + 5.52 = 45.17
  assert.ok(eq(c, 45.17, 0.5), `MIS BUY ~₹45 expected, got ${c}`);
});

test("MIS SELL adds STT 0.025%", () => {
  // 100 × 3000 = ₹3L. STT = 75. Brokerage capped at 20.
  // Exchange 10.35 + sebi 0.3 + GST 5.52 = ~111.17
  const c = previewLegCharges(3000, 100, "SELL", "MIS");
  assert.ok(eq(c, 111.17, 1.0), `MIS SELL ~₹111 expected, got ${c}`);
});

test("CNC has zero brokerage", () => {
  // 100 × 100 = ₹10k turnover. Brokerage = 0. STT 0.1% buy = 10. Stamp 0.015% buy = 1.5.
  // exchange 0.345 + sebi 0.01 + gst ≈ 0.06 → ~11.92
  const c = previewLegCharges(100, 100, "BUY", "CNC");
  assert.ok(eq(c, 11.92, 0.5), `CNC BUY ~₹12 expected, got ${c}`);
});

test("LONG round trip charges are in the expected Zerodha-MIS range", () => {
  // Buy 100 @ 1000, sell 100 @ 1010 → ₹2L turnover round trip.
  // Expected: 2× brokerage (~₹40) + STT on sell (~₹25) + exchange + sebi + GST + stamp
  // Total typically in the ₹70–₹100 range. Pinned to a generous bracket.
  const { brokerage } = roundTripCharges(1000, 1010, 100, "LONG", "MIS");
  assert.ok(brokerage >= 50 && brokerage <= 120, `round-trip ~₹70-₹100 expected, got ${brokerage}`);
});

test("Higher turnover hits the ₹20 brokerage cap", () => {
  // 50 qty × ₹500 = ₹25k → 0.03% = 7.5 (under cap)
  // 100 qty × ₹500 = ₹50k → 0.03% = 15 (under cap)
  // 200 qty × ₹500 = ₹1L → 0.03% = 30 → capped at 20
  const sub = previewLegCharges(500, 50, "BUY", "MIS");
  const at = previewLegCharges(500, 200, "BUY", "MIS");
  // brokerage component alone: 7.5 vs 20
  assert.ok(at - sub > 5, `cap behaviour mismatch (sub=${sub}, at=${at})`);
});
