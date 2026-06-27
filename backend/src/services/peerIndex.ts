import { candleAggregator } from "./candleAggregator.js";
import { priceBook } from "./priceBook.js";
import { mockFeed } from "./mockFeed.js";
import type { Candle } from "../models/Candle.js";

/**
 * Builds a synthetic peer-index candle series by averaging the OTHER symbols'
 * normalised closes. Used by the PairsTrading layer in the composite strategy
 * so it has a "market proxy" to compute spread against.
 *
 * Normalisation: each peer is rescaled so its first close = 100, then we
 * average across peers. The result is unitless but has consistent OHLCV
 * structure for the composer.
 */
export function buildPeerIndex(targetSymbol: string, limit = 500): Candle[] {
  const peers = mockFeed.symbols().filter((s) => s !== targetSymbol);
  if (peers.length === 0) return [];

  const peerSeries: Candle[][] = peers.map((s) => candleAggregator.getCandles(s, limit));
  // Align on the shortest peer (truncate from left to match length).
  const minLen = Math.min(...peerSeries.map((arr) => arr.length));
  if (minLen < 30) return [];
  const trimmed = peerSeries.map((arr) => arr.slice(-minLen));

  // Normalise each peer to start at 100.
  const baseClose = trimmed.map((arr) => arr[0]!.c);
  const baseHigh = trimmed.map((arr) => arr[0]!.h);
  const baseLow = trimmed.map((arr) => arr[0]!.l);
  const baseOpen = trimmed.map((arr) => arr[0]!.o);

  const out: Candle[] = [];
  for (let i = 0; i < minLen; i++) {
    let o = 0;
    let h = 0;
    let l = 0;
    let c = 0;
    let v = 0;
    let t = 0;
    for (let p = 0; p < trimmed.length; p++) {
      const bar = trimmed[p]![i]!;
      o += (bar.o / baseOpen[p]!) * 100;
      h += (bar.h / baseHigh[p]!) * 100;
      l += (bar.l / baseLow[p]!) * 100;
      c += (bar.c / baseClose[p]!) * 100;
      v += bar.v;
      t = bar.t;
    }
    const n = trimmed.length;
    out.push({ symbol: "PEER_INDEX", t, o: o / n, h: h / n, l: l / n, c: c / n, v });
  }
  return out;
}

/**
 * Computes a current Advance/Decline ratio over the universe by comparing
 * each symbol's latest tick to the first observed price in the running session.
 * If we don't yet have enough divergent prices, returns null and the
 * sentiment layer simply skips the A/D vote.
 */
export function computeAdvanceDeclineRatio(): number | null {
  const snapshot = priceBook.snapshot();
  const symbols = Object.keys(snapshot);
  if (symbols.length === 0) return null;

  let advances = 0;
  let declines = 0;
  for (const s of symbols) {
    const candles = candleAggregator.getCandles(s, 60);
    if (candles.length < 2) continue;
    // Compare current to the close 30 bars ago (or earliest available).
    const ref = candles[Math.max(0, candles.length - 30)]!.c;
    const last = snapshot[s]!;
    if (last > ref) advances++;
    else if (last < ref) declines++;
  }
  if (advances + declines === 0) return null;
  if (declines === 0) return 99.0;
  return advances / declines;
}
