// Drop-in replacement for <Chart /> on the dashboard. Wraps the
// existing Chart component and overlays:
//   1. Drawing toolbar (left edge)
//   2. Transparent <DrawingCanvas /> for trendlines, fibs, rects, text
//   3. Native lightweight-charts price lines for horizontal lines
//
// The Chart component itself is untouched apart from the optional
// onChartReady / onChartTeardown hooks that hand us the chart api +
// candle series. This keeps the chart code path unchanged for other
// callers (none today, but future-proof).

import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, IPriceLine } from "lightweight-charts";
import Chart, { type ChartCandle } from "../Chart";
import DrawingCanvas from "./DrawingCanvas";
import { useDrawings } from "../../store/drawings";
import type { DrawingShape } from "./types";

interface Props {
  symbol: string;
  candles: ChartCandle[];
  liveCandle?: ChartCandle;
}

export default function ChartWithDrawings({ symbol, candles, liveCandle }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  const [series, setSeries] = useState<ISeriesApi<"Candlestick"> | null>(null);
  const drawings = useDrawings((s) => s.drawingsBySymbol[symbol] ?? []);
  const priceLines = useRef<Map<string, IPriceLine>>(new Map());

  // Sync horizontal-line drawings with native price lines on the
  // candle series. Removing/adding is cheap and avoids re-creating the
  // whole chart on every store change.
  useEffect(() => {
    if (!series) return;
    const hlines = drawings.filter((d): d is Extract<DrawingShape, { kind: "hline" }> => d.kind === "hline");
    const wanted = new Set(hlines.map((d) => d.id));

    // Drop any price line whose drawing has been removed.
    for (const [id, line] of priceLines.current.entries()) {
      if (!wanted.has(id)) {
        try { series.removePriceLine(line); } catch { /* chart may already be gone */ }
        priceLines.current.delete(id);
      }
    }
    // Add new ones / update existing.
    for (const d of hlines) {
      const cur = priceLines.current.get(d.id);
      if (cur) {
        cur.applyOptions({ price: d.price, color: d.color, title: d.label ?? "" });
      } else {
        const line = series.createPriceLine({
          price: d.price,
          color: d.color,
          lineWidth: 1,
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title: d.label ?? "",
        });
        priceLines.current.set(d.id, line);
      }
    }
  }, [drawings, series]);

  // When symbol changes, wipe in-flight price lines (the drawings store
  // is keyed by symbol so the next useEffect tick re-creates the right set).
  useEffect(() => {
    return () => {
      if (series) {
        for (const line of priceLines.current.values()) {
          try { series.removePriceLine(line); } catch { /* ignore */ }
        }
      }
      priceLines.current.clear();
    };
  }, [symbol, series]);

  return (
    <div ref={hostRef} className="relative w-full h-full">
      <Chart
        candles={candles}
        liveCandle={liveCandle}
        onChartReady={(c, s) => {
          setChart(c);
          setSeries(s);
        }}
        onChartTeardown={() => {
          setChart(null);
          setSeries(null);
          priceLines.current.clear();
        }}
      />
      <DrawingCanvas symbol={symbol} chart={chart} series={series} containerRef={hostRef} />
    </div>
  );
}
