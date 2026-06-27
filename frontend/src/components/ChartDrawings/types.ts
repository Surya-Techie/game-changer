// Drawing shape definitions. Coordinates are stored in price + epoch-ms,
// NOT pixels — so drawings remain attached to the same bar/level even
// after timeframe changes, pan/zoom, or candle history refresh.

export type DrawingTool =
  | "select"
  | "hline"
  | "trendline"
  | "fib"
  | "rect"
  | "text"
  | "erase";

export type DrawingShape =
  | { id: string; kind: "hline"; price: number; color: string; label?: string }
  | {
      id: string;
      kind: "trendline";
      a: { t: number; p: number };
      b: { t: number; p: number };
      color: string;
    }
  | {
      id: string;
      kind: "fib";
      a: { t: number; p: number };
      b: { t: number; p: number };
      // Default: 0 / 23.6 / 38.2 / 50 / 61.8 / 78.6 / 100
      levels?: number[];
    }
  | {
      id: string;
      kind: "rect";
      a: { t: number; p: number };
      b: { t: number; p: number };
      color: string;
    }
  | {
      id: string;
      kind: "text";
      pos: { t: number; p: number };
      text: string;
      color: string;
    };

export const DEFAULT_FIB_LEVELS = [0, 23.6, 38.2, 50, 61.8, 78.6, 100];
