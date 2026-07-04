import type { CandlestickData, UTCTimestamp } from "lightweight-charts";

export interface RawCandle {
  t: number;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
}

/**
 * Convert raw OHLCV rows to lightweight-charts data, defensively:
 *  - drop rows with null / NaN / infinite OHLC (yfinance emits them for
 *    illiquid sessions — a single one hard-crashes the chart library),
 *  - dedupe by second (last write wins),
 *  - sort ascending by time (out-of-order data also asserts).
 */
export function toCandlestickData(rows: Array<RawCandle | Record<string, unknown>>): CandlestickData[] {
  const byTime = new Map<number, { o: number; h: number; l: number; c: number }>();
  for (const raw of rows ?? []) {
    const r = raw as RawCandle;
    if (r == null || typeof r.t !== "number") continue;
    const { o, h, l, c } = r;
    if (o == null || h == null || l == null || c == null) continue;
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    byTime.set(Math.floor(r.t / 1000), { o, h, l, c });
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sec, v]) => ({
      time: sec as UTCTimestamp,
      open: v.o,
      high: v.h,
      low: v.l,
      close: v.c,
    }));
}
