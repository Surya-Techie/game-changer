import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type UTCTimestamp,
} from "lightweight-charts";
import { overlayManager } from "../lib/overlayManager";
import { usePrefs } from "../store/prefs";

export interface ChartCandle {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
}

interface Props {
  candles: ChartCandle[];
  liveCandle?: ChartCandle;
  // Optional hook so a sibling drawing layer can access the chart api
  // without us having to expose the refs through component context.
  // Called once after the chart is created, and again with a teardown
  // signal when the chart is being removed (cleanup-on-unmount pattern).
  onChartReady?: (chart: IChartApi, candleSeries: ISeriesApi<"Candlestick">) => void;
  onChartTeardown?: () => void;
}

export default function Chart({ candles, liveCandle, onChartReady, onChartTeardown }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const theme = usePrefs((s) => s.theme);

  useEffect(() => {
    if (!containerRef.current) return;

    // Theme-aware palette. The light theme inverts background + text but
    // keeps the green/red candle colors so chart semantics stay obvious.
    const palette = theme === "light"
      ? { bg: "#ffffff", text: "#334155", grid: "#e2e8f0", border: "#cbd5e1" }
      : { bg: "#0a0d12", text: "#94a3b8", grid: "#1f2a3d", border: "#1f2a3d" };

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: palette.bg },
        textColor: palette.text,
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      rightPriceScale: {
        borderColor: palette.border,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: false,
        minBarSpacing: 5, // Prevent candles from becoming minute and small when zooming out
        barSpacing: 8,    // Set a comfortable default candle spacing
      },
      crosshair: { mode: 1 },
      autoSize: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#16c784",
      downColor: "#ea3943",
      wickUpColor: "#16c784",
      wickDownColor: "#ea3943",
      borderVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Premium indicator overlays mount through this manager so we can
    // clean them up cleanly on unmount or symbol switch.
    overlayManager.attach(chart, series);
    onChartReady?.(chart, series);

    const onResize = () => chart.applyOptions({});
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      overlayManager.detach();
      onChartTeardown?.();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // Full reset when the symbol's candle history changes.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const data: CandlestickData[] = candles.map((c) => ({
      time: Math.floor(c.t / 1000) as UTCTimestamp,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }));
    series.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Live update for the in-progress candle.
  useEffect(() => {
    if (!liveCandle || !seriesRef.current) return;
    seriesRef.current.update({
      time: Math.floor(liveCandle.t / 1000) as UTCTimestamp,
      open: liveCandle.o,
      high: liveCandle.h,
      low: liveCandle.l,
      close: liveCandle.c,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [liveCandle?.t, liveCandle?.c, liveCandle?.h, liveCandle?.l]);

  return <div ref={containerRef} className="w-full h-full" />;
}
