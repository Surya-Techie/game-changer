// Vertical drawing-tool strip. Sits absolutely-positioned on the left
// edge of the chart container. Tool selection is a global Zustand
// store, so any sibling can read the current tool (the DrawingCanvas
// being the only consumer right now).

import clsx from "clsx";
import { useEffect, useState } from "react";
import { useDrawings } from "../../store/drawings";
import { chartLayoutsApi, type ChartLayoutDoc } from "../../lib/chartLayoutsApi";
import { overlayManager } from "../../lib/overlayManager";
import type { DrawingTool } from "./types";

const TOOLS: { tool: DrawingTool; label: string; icon: string; hint: string }[] = [
  { tool: "select",    label: "Select",          icon: "↖", hint: "Default — chart pans / zooms normally" },
  { tool: "hline",     label: "Horizontal line", icon: "─", hint: "Click on chart to place. Click an existing line to drag it." },
  { tool: "trendline", label: "Trend line",      icon: "╱", hint: "Click and drag — start point to end point" },
  { tool: "fib",       label: "Fibonacci",       icon: "𝓕", hint: "Click and drag from swing high to low (or low to high)" },
  { tool: "rect",      label: "Rectangle",       icon: "▭", hint: "Click and drag to mark a zone" },
  { tool: "text",      label: "Text label",      icon: "T", hint: "Click on chart to add a text annotation" },
  { tool: "erase",     label: "Eraser",          icon: "✕", hint: "Click any drawing to remove it" },
];

interface Props {
  symbol: string;
  overlays?: string[];
}

export default function DrawingToolbar({ symbol, overlays = [] }: Props) {
  const activeTool = useDrawings((s) => s.activeTool);
  const setActiveTool = useDrawings((s) => s.setActiveTool);
  const drawings = useDrawings((s) => s.drawingsBySymbol[symbol] ?? []);
  // replaceAll is used inline below (via getState() to avoid a re-render).
  const clearAll = useDrawings((s) => s.clearAll);

  const [layouts, setLayouts] = useState<ChartLayoutDoc[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState("Default");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    chartLayoutsApi
      .list(symbol)
      .then((rows) => alive && setLayouts(rows))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [symbol]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // Snapshot the currently-mounted overlay owners (vwap / ichimoku / smc / ...)
      // alongside the user-supplied list (which may be empty). Owner is the
      // indicator family name set when the overlay is registered.
      const liveOwners = Array.from(new Set(overlayManager.list().map((o) => o.owner)));
      const mergedOverlays = Array.from(new Set([...(overlays ?? []), ...liveOwners]));
      await chartLayoutsApi.save(symbol, saveName.trim() || "Default", {
        drawings,
        overlays: mergedOverlays,
      });
      setLayouts(await chartLayoutsApi.list(symbol));
      setShowSave(false);
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Save failed";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  async function load(layoutId: string) {
    const layout = layouts.find((l) => l._id === layoutId);
    if (!layout) return;
    useDrawings.getState().replaceAll(symbol, layout.data.drawings ?? []);
    // Surface saved-overlay names so a sibling toolbar (PremiumIndicatorsToolbar)
    // can re-activate them. We can't directly toggle them from here without
    // pulling that whole toolbar's API in — fire a custom event the toolbar
    // can listen to, matching the existing qti:* convention.
    const wanted = layout.data.overlays ?? [];
    if (wanted.length > 0) {
      window.dispatchEvent(new CustomEvent("qti:apply-overlays", { detail: wanted }));
    }
  }

  async function remove(layoutId: string) {
    await chartLayoutsApi.remove(layoutId).catch(() => {});
    setLayouts(await chartLayoutsApi.list(symbol));
  }

  const active = TOOLS.find((t) => t.tool === activeTool) ?? TOOLS[0];
  return (
    <>
    <div className="absolute top-3 left-3 z-20 flex flex-col gap-1 bg-bg-panel-solid/90 backdrop-blur-glass border border-bg-border rounded-md p-1 shadow-glass">
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          onClick={() => setActiveTool(t.tool)}
          title={`${t.label} — ${t.hint}`}
          className={clsx(
            "w-8 h-8 grid place-items-center rounded text-sm transition-colors",
            activeTool === t.tool
              ? "bg-accent-info/20 text-white border border-accent-info"
              : "text-slate-400 hover:bg-bg-elevated hover:text-white"
          )}
        >
          {t.icon}
        </button>
      ))}
      <button
        onClick={() => {
          // Snapshot first so the user can undo via the qti:toast event.
          const snapshot = [...drawings];
          clearAll(symbol);
          window.dispatchEvent(new CustomEvent("qti:toast", {
            detail: {
              kind: "warn",
              text: `Cleared ${snapshot.length} drawing${snapshot.length === 1 ? "" : "s"}`,
              undo: { label: "Undo", run: () => useDrawings.getState().replaceAll(symbol, snapshot) },
            },
          }));
        }}
        title="Clear all drawings"
        className="w-8 h-8 grid place-items-center rounded text-sm text-rose-300 hover:bg-rose-500/20 mt-1"
      >
        ⟲
      </button>
      <div className="border-t border-bg-border my-1" />
      <button
        onClick={() => setShowSave((v) => !v)}
        title="Save layout"
        className="w-8 h-8 grid place-items-center rounded text-sm text-emerald-300 hover:bg-emerald-500/20"
      >
        💾
      </button>

      {showSave && (
        <div className="absolute left-10 top-0 bg-bg-panel-solid border border-bg-border rounded p-2 w-60 space-y-2 shadow-glass">
          <div className="text-[10px] uppercase text-slate-500">Save layout for {symbol}</div>
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1 text-xs text-white"
          />
          <div className="flex gap-1">
            <button onClick={save} disabled={busy} className="flex-1 bg-accent-info/80 text-white text-xs py-1 rounded">
              {busy ? "…" : "Save"}
            </button>
            <button onClick={() => setShowSave(false)} className="text-xs text-slate-400 px-2">
              cancel
            </button>
          </div>
          {err && <div className="text-[10px] text-rose-400">{err}</div>}
          {layouts.length > 0 && (
            <div className="border-t border-bg-border pt-2 space-y-0.5">
              <div className="text-[10px] uppercase text-slate-500 mb-1">Load</div>
              {layouts.map((l) => (
                <div key={l._id} className="flex items-center justify-between text-xs">
                  <button onClick={() => load(l._id)} className="text-slate-300 hover:text-white truncate flex-1 text-left">
                    {l.name}
                  </button>
                  <button onClick={() => remove(l._id)} className="text-[10px] text-rose-400 hover:text-rose-300 ml-2">
                    del
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="text-[10px] text-slate-500">Max 5 per symbol.</div>
        </div>
      )}
    </div>
    {/* Active-tool status bar so users actually know what to do. Hidden
        in default Select mode (nothing to instruct). */}
    {activeTool !== "select" && (
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 bg-bg-panel-solid/90 backdrop-blur-glass border border-accent-info/40 rounded-full text-[11px] text-slate-200 shadow-glass whitespace-nowrap">
        <span className="font-semibold text-accent-info">{active.label}</span>
        <span className="text-slate-500 mx-2">·</span>
        <span>{active.hint}</span>
        <button
          onClick={() => useDrawings.getState().setActiveTool("select")}
          className="ml-3 text-slate-500 hover:text-white text-[10px] uppercase"
        >
          done
        </button>
      </div>
    )}
    </>
  );
}
