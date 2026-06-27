/**
 * Centralised overlay registry for the dashboard candlestick chart.
 *
 * Premium indicators register their chart overlays through this manager so we
 * can clean them up cleanly when:
 *   • the indicator is toggled off
 *   • the active symbol changes
 *   • the chart is unmounted
 *
 * The Chart component calls `attach(chart, series)` when its `IChartApi` is
 * ready and `detach()` on unmount. Until then, addOverlay() calls are
 * queued and applied once the chart attaches. No direct chart manipulation
 * is performed outside this module.
 *
 * The manager itself is API-agnostic — each overlay's `mount/unmount`
 * functions encapsulate the actual lightweight-charts series creation, so
 * indicator code never imports the chart library directly.
 */

import type { IChartApi, ISeriesApi } from "lightweight-charts";

export type SeriesAny = ISeriesApi<"Line" | "Area" | "Histogram" | "Bar" | "Baseline">;

export interface OverlayDef {
  /** Stable ID, namespaced by indicator. e.g. "vwap:main", "vwap:upper1". */
  id: string;
  /** Which indicator family owns this overlay (used for bulk-remove). */
  owner: string;
  /** Called when the chart is attached and ready. Return cleanup that
   *  removes the series/primitive from the chart. */
  mount(chart: IChartApi, candleSeries: ISeriesApi<"Candlestick">): () => void;
}

interface AttachedState {
  chart: IChartApi;
  candleSeries: ISeriesApi<"Candlestick">;
}

class OverlayManager {
  private attached: AttachedState | null = null;
  /** Live overlays: id → cleanup function returned by their `mount`. */
  private active = new Map<string, () => void>();
  /** Definitions kept around so we can re-mount on chart change. */
  private defs = new Map<string, OverlayDef>();
  /** Listeners for state changes (toolbar/panel can subscribe). */
  private listeners = new Set<() => void>();

  attach(chart: IChartApi, candleSeries: ISeriesApi<"Candlestick">) {
    this.detach();
    this.attached = { chart, candleSeries };
    // Re-mount any overlays whose defs are pending.
    for (const def of this.defs.values()) this.mountInternal(def);
    this.notify();
  }

  detach() {
    if (!this.attached) return;
    for (const cleanup of this.active.values()) {
      try { cleanup(); } catch { /* chart may already be removed */ }
    }
    this.active.clear();
    this.attached = null;
    this.notify();
  }

  isAttached(): boolean {
    return this.attached != null;
  }

  /** Direct accessor for the underlying chart api — needed by overlays that
   *  drive chart-wide state (e.g. markers via setMarkers) instead of
   *  individual series. Returns null when no chart is attached. */
  getChart(): IChartApi | null {
    return this.attached?.chart ?? null;
  }

  getCandleSeries(): ISeriesApi<"Candlestick"> | null {
    return this.attached?.candleSeries ?? null;
  }

  /** Register an overlay. If already attached, mount immediately. */
  add(def: OverlayDef) {
    // Remove any previous overlay with same id first (idempotent).
    this.remove(def.id);
    this.defs.set(def.id, def);
    if (this.attached) this.mountInternal(def);
    this.notify();
  }

  /** Bulk register — useful for indicators that ship many primitives. */
  addMany(defs: OverlayDef[]) {
    for (const d of defs) this.add(d);
  }

  /** Remove a single overlay by id. */
  remove(id: string) {
    const cleanup = this.active.get(id);
    if (cleanup) {
      try { cleanup(); } catch { /* ignore */ }
      this.active.delete(id);
    }
    this.defs.delete(id);
    this.notify();
  }

  /** Remove all overlays for an owner (e.g. when an indicator is toggled off). */
  removeOwner(owner: string) {
    const ids: string[] = [];
    for (const [id, def] of this.defs.entries()) {
      if (def.owner === owner) ids.push(id);
    }
    for (const id of ids) this.remove(id);
  }

  /** Hard reset — drop everything (use on symbol/timeframe switch). */
  clearAll() {
    for (const id of [...this.defs.keys()]) this.remove(id);
  }

  /** List active overlay ids — useful for debugging in the admin panel. */
  list(): Array<{ id: string; owner: string; mounted: boolean }> {
    return [...this.defs.entries()].map(([id, def]) => ({
      id,
      owner: def.owner,
      mounted: this.active.has(id),
    }));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private mountInternal(def: OverlayDef) {
    if (!this.attached) return;
    try {
      const cleanup = def.mount(this.attached.chart, this.attached.candleSeries);
      this.active.set(def.id, cleanup);
    } catch (err) {
      // Never propagate — we don't want a single bad overlay to crash the dashboard.
      // eslint-disable-next-line no-console
      console.error(`overlayManager: mount failed for ${def.id}`, err);
    }
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }
}

/** Module-level singleton — there is exactly one dashboard chart. */
export const overlayManager = new OverlayManager();
