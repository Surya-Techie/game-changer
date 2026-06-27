import { useMemo } from "react";
import clsx from "clsx";
import type { PpsPatternId } from "../lib/ppsApi";

/**
 * Filter bar for the PPS signals page. Pure controlled inputs — parent owns
 * the state and re-derives the filtered signal list from `useMemo`.
 */

export type PatternGroup = "all" | "triangles" | "hns" | "doubles";
export type DirectionFilter = "all" | "BUY" | "SELL";

export interface PpsFilters {
  group: PatternGroup;
  minConfidence: number;        // 0..1
  direction: DirectionFilter;
  trendAlignedOnly: boolean;
  showSignals: boolean;         // master toggle for chart markers
}

interface Props {
  value: PpsFilters;
  onChange: (next: PpsFilters) => void;
}

const GROUPS: Array<{ id: PatternGroup; label: string }> = [
  { id: "all", label: "All" },
  { id: "triangles", label: "Triangles" },
  { id: "hns", label: "H&S" },
  { id: "doubles", label: "Double" },
];

const DIRS: Array<{ id: DirectionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "BUY", label: "BUY only" },
  { id: "SELL", label: "SELL only" },
];

/**
 * Map UI group → which raw pattern IDs are admitted. Returned as a Set so
 * callers can `.has()` in O(1) when filtering.
 */
export function patternsInGroup(group: PatternGroup): Set<PpsPatternId> {
  switch (group) {
    case "triangles":
      return new Set<PpsPatternId>(["symmetrical_triangle", "ascending_triangle", "descending_triangle"]);
    case "hns":
      return new Set<PpsPatternId>(["head_shoulders_continuation"]);
    case "doubles":
      return new Set<PpsPatternId>(["double_bottom", "double_top"]);
    case "all":
    default:
      return new Set<PpsPatternId>([
        "symmetrical_triangle",
        "ascending_triangle",
        "descending_triangle",
        "head_shoulders_continuation",
        "double_bottom",
        "double_top",
      ]);
  }
}

export default function PpsSignalFilters({ value, onChange }: Props) {
  const set = (patch: Partial<PpsFilters>) => onChange({ ...value, ...patch });

  return (
    <div className="bg-bg-panel border border-bg-border rounded-xl p-4 flex flex-wrap items-center gap-3 text-sm">
      {/* Pattern group */}
      <div className="flex items-center gap-2">
        <span className="text-slate-500 uppercase text-xs tracking-wider">Pattern</span>
        <div className="flex bg-bg-bg/60 rounded-md p-0.5 border border-bg-border">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => set({ group: g.id })}
              className={clsx(
                "px-3 py-1 rounded text-xs transition-colors",
                value.group === g.id ? "bg-accent-info text-white" : "text-slate-300 hover:bg-bg-border/50"
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* Direction */}
      <div className="flex items-center gap-2">
        <span className="text-slate-500 uppercase text-xs tracking-wider">Direction</span>
        <div className="flex bg-bg-bg/60 rounded-md p-0.5 border border-bg-border">
          {DIRS.map((d) => (
            <button
              key={d.id}
              onClick={() => set({ direction: d.id })}
              className={clsx(
                "px-3 py-1 rounded text-xs transition-colors",
                value.direction === d.id ? "bg-accent-info text-white" : "text-slate-300 hover:bg-bg-border/50"
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Trend aligned */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={value.trendAlignedOnly}
          onChange={(e) => set({ trendAlignedOnly: e.target.checked })}
          className="accent-accent-info"
        />
        <span className="text-slate-300 text-xs">Trend-aligned only</span>
      </label>

      {/* Min confidence */}
      <div className="flex items-center gap-2 flex-1 min-w-[180px]">
        <span className="text-slate-500 uppercase text-xs tracking-wider whitespace-nowrap">
          Min conf {(value.minConfidence * 100).toFixed(0)}%
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value.minConfidence}
          onChange={(e) => set({ minConfidence: Number(e.target.value) })}
          className="flex-1 accent-accent-info"
        />
      </div>

      {/* Show signals master toggle */}
      <button
        onClick={() => set({ showSignals: !value.showSignals })}
        className={clsx(
          "px-3 py-1.5 rounded text-xs font-medium transition-colors border",
          value.showSignals
            ? "bg-accent-buy/15 text-accent-buy border-accent-buy/40"
            : "bg-bg-bg/60 text-slate-400 border-bg-border"
        )}
      >
        {value.showSignals ? "Signals: ON" : "Signals: OFF"}
      </button>
    </div>
  );
}

/**
 * Apply filters to a raw signal array. Pure function — kept here so the
 * page component can call it in `useMemo` and the filter UI exports the
 * same group definition.
 */
export function applyFilters<
  S extends { signal: string; pattern: string | null; confidence: number; trend_aligned: boolean }
>(signals: S[], filters: PpsFilters): S[] {
  const group = patternsInGroup(filters.group);
  return signals.filter((s) => {
    if (s.signal === "HOLD") return false;
    if (filters.direction !== "all" && s.signal !== filters.direction) return false;
    if (filters.trendAlignedOnly && !s.trend_aligned) return false;
    if (s.confidence < filters.minConfidence) return false;
    if (s.pattern && !group.has(s.pattern as PpsPatternId)) return false;
    return true;
  });
}

// Re-export useMemo so the parent can wrap applyFilters easily.
export { useMemo };
