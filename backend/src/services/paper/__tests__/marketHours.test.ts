import { test } from "node:test";
import assert from "node:assert/strict";
import { marketStatus, isMarketOpen, isHoliday, isWeekend } from "../marketHours.js";

// Construct an IST instant: 09:30 IST on Monday 2026-05-18 (Mon, not a holiday).
// IST = UTC + 5:30, so 09:30 IST = 04:00 UTC same day.
const istMonday0930 = new Date("2026-05-18T04:00:00.000Z");
const istMonday1531 = new Date("2026-05-18T10:01:00.000Z");
const istSaturday1000 = new Date("2026-05-16T04:30:00.000Z");
const independenceDay2025 = new Date("2025-08-15T05:00:00.000Z");

test("market is OPEN at 09:30 IST on a Monday", () => {
  const s = marketStatus(istMonday0930);
  assert.equal(s.state, "OPEN");
  assert.equal(isMarketOpen(istMonday0930), true);
});

test("market is CLOSED at 15:31 IST", () => {
  const s = marketStatus(istMonday1531);
  assert.equal(s.state, "CLOSED");
});

test("Saturday is weekend → CLOSED", () => {
  assert.equal(isWeekend(istSaturday1000), true);
  assert.equal(marketStatus(istSaturday1000).state, "CLOSED");
});

test("Independence Day is a hardcoded NSE holiday", () => {
  assert.equal(isHoliday(independenceDay2025), true);
  assert.equal(marketStatus(independenceDay2025).state, "CLOSED");
});

test("PRE_OPEN window between 09:00 and 09:15 IST", () => {
  const preOpen = new Date("2026-05-18T03:35:00.000Z"); // 09:05 IST
  const s = marketStatus(preOpen);
  assert.equal(s.state, "PRE_OPEN");
  assert.ok((s.minutesToOpen ?? 0) > 0 && (s.minutesToOpen ?? 0) <= 15);
});
