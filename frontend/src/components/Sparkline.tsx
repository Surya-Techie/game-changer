interface Props {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
}

export default function Sparkline({ points, width = 80, height = 24, color }: Props) {
  if (points.length < 2) return <div className="text-slate-600 text-[10px]">—</div>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stroke = color ?? (points[points.length - 1]! >= points[0]! ? "#16c784" : "#ea3943");
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - ((p - min) / span) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.2} />
    </svg>
  );
}
