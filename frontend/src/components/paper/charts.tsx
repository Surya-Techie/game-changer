// Tiny SVG chart primitives for the paper-trading analytics page.
// No external chart deps — consistent with the existing Sparkline approach.

import clsx from "clsx";

interface LineChartProps {
  data: { x: number; y: number }[];
  height?: number;
  baseline?: number;
  positiveColor?: string;
  negativeColor?: string;
  label?: string;
}

export function AreaLineChart({
  data,
  height = 160,
  baseline,
  positiveColor = "#16c784",
  negativeColor = "#ea3943",
  label,
}: LineChartProps) {
  if (data.length === 0) return <Empty height={height} label={label ?? "No data"} />;
  const xs = data.map((d) => d.x);
  const ys = data.map((d) => d.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys, baseline ?? Infinity);
  const yMax = Math.max(...ys, baseline ?? -Infinity);
  const pad = (yMax - yMin) * 0.05 || 1;
  const yLo = yMin - pad;
  const yHi = yMax + pad;
  const w = 600;
  const fx = (x: number) => ((x - xMin) / Math.max(1, xMax - xMin)) * (w - 20) + 10;
  const fy = (y: number) => height - 10 - ((y - yLo) / Math.max(1, yHi - yLo)) * (height - 20);
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"} ${fx(d.x)} ${fy(d.y)}`).join(" ");
  const closing = `L ${fx(data[data.length - 1].x)} ${height - 10} L ${fx(data[0].x)} ${height - 10} Z`;
  const last = data[data.length - 1].y;
  const above = baseline == null || last >= baseline;
  const stroke = above ? positiveColor : negativeColor;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full">
      <defs>
        <linearGradient id="lc-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {baseline != null && (
        <line x1="10" x2={w - 10} y1={fy(baseline)} y2={fy(baseline)} stroke="#3b4660" strokeDasharray="3 3" />
      )}
      <path d={`${path} ${closing}`} fill="url(#lc-grad)" />
      <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" />
    </svg>
  );
}

interface BarsProps {
  data: { label: string; value: number }[];
  height?: number;
  positiveColor?: string;
  negativeColor?: string;
}

export function PnlBars({ data, height = 160, positiveColor = "#16c784", negativeColor = "#ea3943" }: BarsProps) {
  if (data.length === 0) return <Empty height={height} label="No data" />;
  const w = 600;
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const bw = (w - 20) / data.length;
  const mid = height / 2;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full">
      <line x1="10" x2={w - 10} y1={mid} y2={mid} stroke="#3b4660" />
      {data.map((d, i) => {
        const h = (Math.abs(d.value) / max) * (mid - 10);
        const y = d.value >= 0 ? mid - h : mid;
        return (
          <rect
            key={i}
            x={10 + i * bw + 1}
            y={y}
            width={Math.max(1, bw - 2)}
            height={Math.max(1, h)}
            fill={d.value >= 0 ? positiveColor : negativeColor}
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}

interface DistProps {
  bins: { from: number; to: number; count: number }[];
  height?: number;
}

export function DistributionHistogram({ bins, height = 160 }: DistProps) {
  if (bins.length === 0) return <Empty height={height} label="No trades yet" />;
  const w = 600;
  const max = Math.max(1, ...bins.map((b) => b.count));
  const bw = (w - 20) / bins.length;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full">
      {bins.map((b, i) => {
        const h = (b.count / max) * (height - 20);
        const positive = (b.from + b.to) / 2 >= 0;
        return (
          <rect
            key={i}
            x={10 + i * bw + 0.5}
            y={height - 10 - h}
            width={Math.max(1, bw - 1)}
            height={h}
            fill={positive ? "#16c784" : "#ea3943"}
            opacity={0.7}
          />
        );
      })}
      <line x1="10" x2={w - 10} y1={height - 10} y2={height - 10} stroke="#3b4660" />
    </svg>
  );
}

export function HeatGrid({
  cells,
  cols,
  label,
}: {
  cells: { label: string; value: number }[];
  cols: number;
  label?: string;
}) {
  if (cells.length === 0) return <Empty height={120} label={label ?? "No data"} />;
  const max = Math.max(1, ...cells.map((c) => Math.abs(c.value)));
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {cells.map((c, i) => {
        const intensity = Math.abs(c.value) / max;
        const bg = c.value >= 0
          ? `rgba(22, 199, 132, ${0.15 + intensity * 0.6})`
          : `rgba(234, 57, 67, ${0.15 + intensity * 0.6})`;
        return (
          <div
            key={i}
            className="rounded text-[10px] text-white text-center px-1 py-2 font-mono"
            style={{ background: bg }}
            title={`${c.label}: ${c.value >= 0 ? "+" : ""}₹${c.value.toFixed(0)}`}
          >
            <div className="opacity-75">{c.label}</div>
            <div>{c.value >= 0 ? "+" : ""}₹{c.value.toFixed(0)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Empty({ height, label }: { height: number; label: string }) {
  return (
    <div
      className={clsx("flex items-center justify-center text-xs text-slate-500 bg-bg-elevated/30 rounded")}
      style={{ height }}
    >
      {label}
    </div>
  );
}
