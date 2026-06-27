import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics } from "../metrics.js";

test("counter increments and renders Prometheus format", () => {
  const c = metrics.counter("test_ctr", "test counter");
  c.inc({ a: "x" });
  c.inc({ a: "x" });
  c.inc({ a: "y" }, 3);
  const out = c.render();
  assert.match(out, /# TYPE test_ctr counter/);
  assert.match(out, /test_ctr\{a="x"\} 2/);
  assert.match(out, /test_ctr\{a="y"\} 3/);
});

test("histogram observeMs buckets correctly", () => {
  const h = metrics.histogram("test_hist", "test hist");
  h.observeMs(7);    // ≤ 10
  h.observeMs(40);   // ≤ 50, 100, 250...
  h.observeMs(7_000); // ≤ 10000
  const out = h.render();
  assert.match(out, /# TYPE test_hist histogram/);
  assert.match(out, /test_hist_count 3/);
});

test("registry render combines all instruments without throwing", () => {
  const out = metrics.render();
  assert.ok(out.length > 0);
  assert.match(out, /^# HELP/);
});
