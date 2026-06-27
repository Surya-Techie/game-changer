/**
 * Pattern overlay registry — Phase 6.
 *
 * The Dashboard receives `pattern` (and `pattern_signal`) WebSocket events
 * for the active symbol and pushes them into this registry. The registry:
 *
 *  • Adds an arrow marker on the last candle in the pattern (bullish → green
 *    arrow below the bar, bearish → red arrow above the bar, continuation/
 *    neutral → orange dot).
 *  • Creates dashed price lines on the candle series for entry / target / stop
 *    (extended patterns only — single-candle reversals don't carry these).
 *  • Draws the trendline polyline for Western/institutional patterns by
 *    overlaying a line series on the chart (uses overlayManager so it
 *    cleans up automatically on symbol change / unmount).
 *
 * State lives at module scope so the Dashboard can keep multiple patterns
 * active simultaneously (e.g. several timeframes on the same symbol).
 * Symbol-scoped state is wiped via `clearForSymbol()` whenever the active
 * symbol changes — the Dashboard owns that contract.
 */

import type {
  ISeriesApi,
  IPriceLine,
  LineStyle,
  SeriesMarker,
  UTCTimestamp,
  Time,
} from "lightweight-charts";
import { overlayManager } from "./overlayManager";
import type { WsPatternPayload } from "./socket";
import { getPatternAdvice } from "./patternMetadata";


interface ActivePattern {
  key: string;
  payload: WsPatternPayload;
  // Per-pattern price lines so we can remove them individually.
  priceLines: IPriceLine[];
}

const active = new Map<string, ActivePattern>();
let lastAttachedSeries: ISeriesApi<"Candlestick"> | null = null;

function patternKey(p: WsPatternPayload): string {
  // Uniquely identify a pattern instance. We can't lean on patternId alone
  // because the AI service may emit before persistence completed; fall back
  // on (symbol, timeframe, name, last_candle_idx).
  if (p.patternId) return p.patternId;
  const last = p.candle_indices.length ? p.candle_indices[p.candle_indices.length - 1] : -1;
  return `${p.symbol}:${p.timeframe}:${p.pattern_name}:${last}`;
}

function arrowFor(direction: WsPatternPayload["direction"]): {
  position: SeriesMarker<Time>["position"];
  shape: SeriesMarker<Time>["shape"];
  color: string;
} {
  switch (direction) {
    case "bullish":
      return { position: "belowBar", shape: "arrowUp", color: "#22c55e" };
    case "bearish":
      return { position: "aboveBar", shape: "arrowDown", color: "#ef4444" };
    case "continuation":
      return { position: "inBar", shape: "circle", color: "#f59e0b" };
    default:
      return { position: "inBar", shape: "circle", color: "#94a3b8" };
  }
}

function buildMarker(p: WsPatternPayload, time: UTCTimestamp): SeriesMarker<Time> {
  const { position, shape, color } = arrowFor(p.direction);
  const advice = getPatternAdvice(p.pattern_name, p.direction);
  return {
    time,
    position,
    shape,
    color,
    text: `${p.pattern_name} (${advice.strengthText})`,
  };
}

/** Re-emit the full marker list for the currently-attached series. lightweight-charts
 *  doesn't support "add one marker"; it's a setMarkers replace operation. */
function rebuildMarkers(): void {
  const series = overlayManager.getCandleSeries();
  if (!series) return;
  const list: SeriesMarker<Time>[] = [];
  for (const ap of active.values()) {
    // The candle_indices are positional within whatever lookback the AI used,
    // not absolute times. The detected_at (epoch ms) gets us close enough as a
    // fallback so we don't drop the marker entirely if we don't have the bar
    // index → time map handy.
    const t = Math.floor(ap.payload.detected_at / 1000) as UTCTimestamp;
    list.push(buildMarker(ap.payload, t));
  }
  list.sort((a, b) => (a.time as number) - (b.time as number));
  try {
    series.setMarkers(list);
  } catch {
    /* series may have been detached between checks */
  }
}

function priceLineOpts(color: string, title: string): Parameters<ISeriesApi<"Candlestick">["createPriceLine"]>[0] {
  return {
    price: 0, // overridden below
    color,
    lineWidth: 1,
    lineStyle: 2 as LineStyle, // dashed
    axisLabelVisible: true,
    title,
  };
}

/** Add (or replace) a pattern on the chart. Idempotent on key. */
export function addPattern(payload: WsPatternPayload): void {
  const key = patternKey(payload);
  // If a stale instance exists, remove it first so price lines don't double up.
  removePattern(key);

  const series = overlayManager.getCandleSeries();
  if (!series) {
    // No chart attached yet — store the payload and try again when the
    // overlayManager re-attaches (the subscriber set up in initOnce()
    // takes care of that).
    active.set(key, { key, payload, priceLines: [] });
    return;
  }

  const priceLines: IPriceLine[] = [];
  const advice = getPatternAdvice(payload.pattern_name, payload.direction);
  if (payload.entry != null) {
    priceLines.push(series.createPriceLine({
      ...priceLineOpts("#3b82f6", `🔶 ${payload.pattern_name} · ${advice.strengthText}`),
      price: payload.entry,
      lineWidth: 2,
      lineStyle: 0 as LineStyle, // solid for the entry/anchor
    }));
  }
  if (payload.target != null) {
    priceLines.push(series.createPriceLine({
      ...priceLineOpts("#22c55e", `🎯 Target ₹${payload.target.toFixed(2)}`),
      price: payload.target,
    }));
  }
  if (payload.stop != null) {
    priceLines.push(series.createPriceLine({
      ...priceLineOpts("#ef4444", `🛑 Stop ₹${payload.stop.toFixed(2)}`),
      price: payload.stop,
    }));
  }

  active.set(key, { key, payload, priceLines });


  // Trendline polyline (Western + institutional). overlayManager handles cleanup.
  if (payload.trendline_points && payload.trendline_points.length >= 2) {
    overlayManager.add({
      id: `pattern:${key}:trendline`,
      owner: "pattern",
      mount(chart) {
        const series = chart.addLineSeries({
          color: arrowFor(payload.direction).color,
          lineWidth: 2,
          lineStyle: 2 as LineStyle,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        const points = payload.trendline_points
          .map((p) => ({
            time: Math.floor(p.time / 1000) as UTCTimestamp,
            value: p.price,
          }))
          .sort((a, b) => (a.time as number) - (b.time as number))
          .filter((p, i, arr) => i === 0 || p.time !== arr[i - 1].time);
        series.setData(points);
        return () => {
          try { chart.removeSeries(series); } catch { /* removed */ }
        };
      },
    });
  }

  rebuildMarkers();
}

/** Remove one pattern by key (or patternId, since they're the same when present). */
export function removePattern(key: string): void {
  const ap = active.get(key);
  if (!ap) return;
  const series = overlayManager.getCandleSeries();
  if (series) {
    for (const line of ap.priceLines) {
      try { series.removePriceLine(line); } catch { /* series gone */ }
    }
  }
  overlayManager.remove(`pattern:${key}:trendline`);
  active.delete(key);
  rebuildMarkers();
}

/** Remove every pattern overlay tracked by this module. Called on symbol change. */
export function clearAllPatterns(): void {
  for (const key of [...active.keys()]) removePattern(key);
  // Belt-and-braces: drop any trendline overlays owned by us in case the
  // active map drifted from the overlayManager state.
  overlayManager.removeOwner("pattern");
  const series = overlayManager.getCandleSeries();
  if (series) {
    try { series.setMarkers([]); } catch { /* */ }
  }
}

/** List currently-mounted pattern payloads (for the Dashboard right rail). */
export function listActive(): WsPatternPayload[] {
  return [...active.values()]
    .map((ap) => ap.payload)
    .sort((a, b) => b.confidence - a.confidence);
}

// ─── Chart re-attach handling ────────────────────────────────────────────
// When the chart is recreated (theme change, symbol change), price lines we
// created previously go with it. We need to re-mount them onto the fresh
// series. overlayManager.subscribe() fires after attach/detach.

let initialised = false;
export function initOnce(): void {
  if (initialised) return;
  initialised = true;
  overlayManager.subscribe(() => {
    const series = overlayManager.getCandleSeries();
    if (!series) {
      lastAttachedSeries = null;
      return;
    }
    if (series === lastAttachedSeries) return;
    lastAttachedSeries = series;
    // The set of patterns survives — re-mount each one onto the new series.
    const snapshot = [...active.values()].map((ap) => ap.payload);
    for (const ap of active.values()) ap.priceLines = []; // they're orphaned on the old series
    for (const p of snapshot) addPattern(p); // idempotent: replaces in place.
    rebuildMarkers();
  });
}
