import { create } from "zustand";
import type { DrawingShape, DrawingTool } from "../components/ChartDrawings/types";

interface DrawingsState {
  activeTool: DrawingTool;
  drawingsBySymbol: Record<string, DrawingShape[]>;
  // Symbol that drawings apply to (kept here so the canvas can react to
  // symbol changes without re-mounting).
  setActiveTool: (t: DrawingTool) => void;
  addDrawing: (symbol: string, shape: DrawingShape) => void;
  removeDrawing: (symbol: string, id: string) => void;
  clearAll: (symbol: string) => void;
  replaceAll: (symbol: string, shapes: DrawingShape[]) => void;
}

export const useDrawings = create<DrawingsState>((set) => ({
  activeTool: "select",
  drawingsBySymbol: {},
  setActiveTool: (t) => set({ activeTool: t }),
  addDrawing: (symbol, shape) =>
    set((s) => ({
      drawingsBySymbol: {
        ...s.drawingsBySymbol,
        [symbol]: [...(s.drawingsBySymbol[symbol] ?? []), shape],
      },
    })),
  removeDrawing: (symbol, id) =>
    set((s) => ({
      drawingsBySymbol: {
        ...s.drawingsBySymbol,
        [symbol]: (s.drawingsBySymbol[symbol] ?? []).filter((d) => d.id !== id),
      },
    })),
  clearAll: (symbol) =>
    set((s) => ({
      drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: [] },
    })),
  replaceAll: (symbol, shapes) =>
    set((s) => ({
      drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: shapes },
    })),
}));
