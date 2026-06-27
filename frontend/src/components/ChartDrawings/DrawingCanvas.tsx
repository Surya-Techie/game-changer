// Transparent canvas overlay that draws trendlines, fib retracements,
// rectangles, and text annotations on top of the lightweight-charts
// candlestick chart. Horizontal lines are drawn directly by the chart
// via createPriceLine() — they live on the right price scale natively
// and don't need to be on this canvas.
//
// Coordinates: shapes are stored in (epoch-ms, price) so they remain
// anchored across pan/zoom/timeframe changes. On every animation frame
// we project them to pixels using:
//   x = chart.timeScale().timeToCoordinate(time-as-sec)
//   y = candleSeries.priceToCoordinate(price)
//
// We re-render on:
//   1. requestAnimationFrame loop while mounted (cheap; canvas is tiny)
//   2. drawings store change
//   3. window resize
//
// Click-to-create is handled here: when the active tool is one of the
// two-point tools, we capture mousedown (point a) and mouseup (point b)
// and push the resulting shape to the store. For one-point tools
// (hline, text) we push on the first click.

import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { useDrawings } from "../../store/drawings";
import { DEFAULT_FIB_LEVELS, type DrawingShape, type DrawingTool } from "./types";

interface Props {
  symbol: string;
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  // Horizontal lines created by createPriceLine — we keep them in sync
  // separately so the parent can detach them on unmount.
  containerRef: React.RefObject<HTMLDivElement>;
}

export default function DrawingCanvas({ symbol, chart, series, containerRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawings = useDrawings((s) => s.drawingsBySymbol[symbol] ?? []);
  const activeTool = useDrawings((s) => s.activeTool);
  const addDrawing = useDrawings((s) => s.addDrawing);
  const removeDrawing = useDrawings((s) => s.removeDrawing);
  const replaceAll = useDrawings((s) => s.replaceAll);
  const [dragStart, setDragStart] = useState<{ t: number; p: number } | null>(null);
  const [textPrompt, setTextPrompt] = useState<{ t: number; p: number } | null>(null);
  // Drag-an-existing-hline state (separate from "draw a new shape" drag).
  const [hlineDrag, setHlineDrag] = useState<{ id: string; offsetPx: number } | null>(null);

  // Resize canvas to its container.
  useEffect(() => {
    const c = canvasRef.current;
    const host = containerRef.current;
    if (!c || !host) return;
    const ro = new ResizeObserver(() => {
      c.width = host.clientWidth;
      c.height = host.clientHeight;
    });
    ro.observe(host);
    c.width = host.clientWidth;
    c.height = host.clientHeight;
    return () => ro.disconnect();
  }, [containerRef]);

  // Render loop. Cheap — we only redraw the shapes (no candles, no axis).
  useEffect(() => {
    if (!chart || !series) return;
    let raf = 0;
    function tick() {
      draw();
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, drawings]);

  function project(t: number, p: number): { x: number; y: number } | null {
    if (!chart || !series) return null;
    const timeSec = Math.floor(t / 1000) as unknown as Time;
    const x = chart.timeScale().timeToCoordinate(timeSec);
    const y = series.priceToCoordinate(p);
    if (x == null || y == null) return null;
    return { x, y };
  }

  function fromPixel(ev: { clientX: number; clientY: number }): { t: number; p: number } | null {
    if (!chart || !series || !canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const timeSec = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (timeSec == null || price == null) return null;
    // timeSec is in seconds (UTCTimestamp). Convert to ms for storage.
    return { t: (timeSec as number) * 1000, p: price as number };
  }

  function draw() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const d of drawings) {
      renderShape(ctx, d);
    }
  }

  function renderShape(ctx: CanvasRenderingContext2D, d: DrawingShape) {
    switch (d.kind) {
      case "hline":
        // hlines are drawn by createPriceLine() on the chart itself; no
        // canvas draw needed. (We keep them in the drawings store so
        // they get saved / loaded with layouts.)
        return;
      case "trendline": {
        const a = project(d.a.t, d.a.p);
        const b = project(d.b.t, d.b.p);
        if (!a || !b) return;
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        return;
      }
      case "fib": {
        const a = project(d.a.t, d.a.p);
        const b = project(d.b.t, d.b.p);
        if (!a || !b) return;
        const left = Math.min(a.x, b.x);
        const right = Math.max(a.x, b.x);
        const top = Math.min(a.y, b.y);
        const bot = Math.max(a.y, b.y);
        const levels = d.levels ?? DEFAULT_FIB_LEVELS;
        const high = Math.max(d.a.p, d.b.p);
        const low = Math.min(d.a.p, d.b.p);
        const range = high - low;
        for (const lv of levels) {
          const price = high - (lv / 100) * range;
          const yy = project(d.a.t, price)?.y;
          if (yy == null) continue;
          const _ = top; const __ = bot; void _; void __;
          ctx.strokeStyle = "rgba(245, 158, 11, 0.6)";
          ctx.lineWidth = 1;
          ctx.setLineDash(lv === 0 || lv === 100 ? [] : [4, 3]);
          ctx.beginPath();
          ctx.moveTo(left, yy);
          ctx.lineTo(right, yy);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(245, 158, 11, 0.9)";
          ctx.font = "10px JetBrains Mono, monospace";
          ctx.fillText(`${lv.toFixed(1)}% · ₹${price.toFixed(2)}`, right + 4, yy + 3);
        }
        return;
      }
      case "rect": {
        const a = project(d.a.t, d.a.p);
        const b = project(d.b.t, d.b.p);
        if (!a || !b) return;
        ctx.fillStyle = "rgba(59, 130, 246, 0.12)";
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 1;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(a.x - b.x);
        const h = Math.abs(a.y - b.y);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        return;
      }
      case "text": {
        const p = project(d.pos.t, d.pos.p);
        if (!p) return;
        ctx.fillStyle = d.color;
        ctx.font = "11px Inter, sans-serif";
        ctx.fillText(d.text, p.x + 4, p.y - 4);
        return;
      }
    }
  }

  // Mouse handling — start/end shapes depending on active tool.
  function onMouseDown(e: React.MouseEvent) {
    if (activeTool === "select") return; // chart owns the events
    const pt = fromPixel(e);
    if (!pt) return;
    if (activeTool === "hline") {
      // First check if the click landed on an existing hline — if so,
      // grab it for drag instead of placing a new one. This is how the
      // user adjusts an existing SL/TP after the fact.
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect && series) {
        const y = e.clientY - rect.top;
        let bestId: string | null = null;
        let best = 8;
        for (const d of drawings) {
          if (d.kind !== "hline") continue;
          const yy = series.priceToCoordinate(d.price) as number | null;
          if (yy == null) continue;
          const dist = Math.abs(yy - y);
          if (dist < best) { best = dist; bestId = d.id; }
        }
        if (bestId) {
          setHlineDrag({ id: bestId, offsetPx: 0 });
          return;
        }
      }
      addDrawing(symbol, {
        id: id(), kind: "hline", price: pt.p, color: "#f59e0b",
      });
      return;
    }
    if (activeTool === "text") {
      setTextPrompt(pt);
      return;
    }
    if (activeTool === "erase") {
      // Click to delete the nearest shape within 8px.
      const target = pickShape(e, drawings);
      if (target) removeDrawing(symbol, target);
      return;
    }
    if (activeTool === "trendline" || activeTool === "fib" || activeTool === "rect") {
      setDragStart(pt);
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!hlineDrag) return;
    const pt = fromPixel(e);
    if (!pt) return;
    // Update the hline price in real time as the user drags. Replace
    // the whole shape list to trigger a render + DrawingLayer's
    // createPriceLine().applyOptions() path.
    replaceAll(
      symbol,
      drawings.map((d) =>
        d.kind === "hline" && d.id === hlineDrag.id ? { ...d, price: pt.p } : d
      )
    );
  }

  function onMouseUp(e: React.MouseEvent) {
    if (hlineDrag) {
      setHlineDrag(null);
      return;
    }
    if (!dragStart) return;
    const pt = fromPixel(e);
    if (!pt) {
      setDragStart(null);
      return;
    }
    if (activeTool === "trendline") {
      addDrawing(symbol, { id: id(), kind: "trendline", a: dragStart, b: pt, color: "#3b82f6" });
    } else if (activeTool === "fib") {
      addDrawing(symbol, { id: id(), kind: "fib", a: dragStart, b: pt });
    } else if (activeTool === "rect") {
      addDrawing(symbol, { id: id(), kind: "rect", a: dragStart, b: pt, color: "#3b82f6" });
    }
    setDragStart(null);
  }

  function pickShape(e: React.MouseEvent, list: DrawingShape[]): string | null {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let bestId: string | null = null;
    let best = 12;
    for (const d of list) {
      const dist = shapeDistance(d, x, y);
      if (dist != null && dist < best) {
        best = dist;
        bestId = d.id;
      }
    }
    return bestId;
  }

  function shapeDistance(d: DrawingShape, x: number, y: number): number | null {
    switch (d.kind) {
      case "hline": {
        const yy = series?.priceToCoordinate(d.price);
        return yy != null ? Math.abs((yy as number) - y) : null;
      }
      case "trendline":
      case "fib":
      case "rect": {
        const a = project(d.a.t, d.a.p);
        const b = project(d.b.t, d.b.p);
        if (!a || !b) return null;
        if (d.kind === "rect") {
          const x0 = Math.min(a.x, b.x);
          const y0 = Math.min(a.y, b.y);
          const x1 = Math.max(a.x, b.x);
          const y1 = Math.max(a.y, b.y);
          if (x >= x0 - 6 && x <= x1 + 6 && y >= y0 - 6 && y <= y1 + 6) return 4;
          return null;
        }
        return distPointToSegment(x, y, a.x, a.y, b.x, b.y);
      }
      case "text": {
        const p = project(d.pos.t, d.pos.p);
        if (!p) return null;
        return Math.hypot(p.x - x, p.y - y);
      }
    }
  }

  function submitText(text: string) {
    if (!textPrompt) return;
    if (text.trim().length) {
      addDrawing(symbol, {
        id: id(), kind: "text", pos: textPrompt, text: text.trim(), color: "#e2e8f0",
      });
    }
    setTextPrompt(null);
  }

  // Pointer events: intercepted whenever the user is drawing a new shape
  // OR mid-drag of an existing hline. In pure "select" idle state we
  // leave the canvas transparent to events so the underlying chart still
  // pans / zooms. To grab an hline for drag, the user switches to the
  // dedicated "hline" tool (which we re-purpose as a one-shot grab —
  // first click on an existing hline = drag; click on empty area =
  // place a new one, matching how the original tool already worked).
  const interactive = activeTool !== "select" || hlineDrag != null;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{
          pointerEvents: interactive ? "auto" : "none",
          cursor: hlineDrag ? "ns-resize" : cursorFor(activeTool),
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
      {textPrompt && (
        <div
          className="absolute z-50 bg-bg-panel-solid border border-bg-border rounded p-2 shadow-glass"
          style={{
            left: (project(textPrompt.t, textPrompt.p)?.x ?? 0) + 6,
            top: (project(textPrompt.t, textPrompt.p)?.y ?? 0) - 30,
          }}
        >
          <input
            autoFocus
            placeholder="Annotation…"
            className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-xs text-white"
            onKeyDown={(e) => {
              if (e.key === "Enter") submitText((e.target as HTMLInputElement).value);
              if (e.key === "Escape") setTextPrompt(null);
            }}
          />
        </div>
      )}
    </>
  );
}

function id(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function cursorFor(t: DrawingTool): string {
  switch (t) {
    case "select": return "default";
    case "erase": return "not-allowed";
    case "text": return "text";
    default: return "crosshair";
  }
}

function distPointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
