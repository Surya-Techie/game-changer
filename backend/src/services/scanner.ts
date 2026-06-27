import { candleAggregator } from "./candleAggregator.js";
import { priceBook } from "./priceBook.js";
import { mockFeed } from "./mockFeed.js";
import { getIndicators } from "./aiClient.js";
import { runComposite } from "./compositeClient.js";
import { buildPeerIndex, computeAdvanceDeclineRatio } from "./peerIndex.js";
import { Signal } from "../models/Signal.js";

export interface ScanCondition {
  field: string;            // e.g. "rsi14", "macdHist", "composite_score", "volume_ratio"
  operator: "<" | "<=" | ">" | ">=" | "==" | "!=";
  value: number;
}

export interface ScanRequest {
  conditions: ScanCondition[];
  combinator: "AND" | "OR";
  universe?: string[];      // defaults to mockFeed.symbols()
  includeComposite?: boolean;
}

export interface ScanRow {
  symbol: string;
  price: number;
  changePct: number;
  rsi14: number | null;
  macdHist: number | null;
  supertrendDir: number | null;
  adx14: number | null;
  volumeRatio: number | null;
  compositeScore?: number;
  recommendation?: string;
  signal?: string;
  signalConfidence?: number;
  matched: boolean;
}

function compare(a: number, op: ScanCondition["operator"], b: number): boolean {
  switch (op) {
    case "<":  return a < b;
    case "<=": return a <= b;
    case ">":  return a > b;
    case ">=": return a >= b;
    case "==": return a === b;
    case "!=": return a !== b;
  }
}

async function buildRowForSymbol(symbol: string, includeComposite: boolean): Promise<ScanRow> {
  const candles = candleAggregator.getCandles(symbol, 500);
  const last = priceBook.price(symbol) ?? (candles[candles.length - 1]?.c ?? 0);
  const ref = candles[Math.max(0, candles.length - 30)]?.c ?? last;
  const changePct = ref > 0 ? ((last - ref) / ref) * 100 : 0;

  // Volume ratio (current vs 20-bar average).
  let volumeRatio: number | null = null;
  if (candles.length >= 20) {
    const last20 = candles.slice(-20);
    const avg = last20.reduce((s, c) => s + c.v, 0) / 20;
    const cur = candles[candles.length - 1]!.v;
    if (avg > 0) volumeRatio = cur / avg;
  }

  // Indicator snapshot.
  let rsi14: number | null = null;
  let macdHist: number | null = null;
  let supertrendDir: number | null = null;
  let adx14: number | null = null;
  if (candles.length >= 50) {
    const ind = await getIndicators(symbol, candles, ["rsi", "macd", "supertrend"]);
    const inds = ind as Record<string, Array<number | null>> | null;
    if (inds) {
      const last = <T,>(arr?: Array<T | null>): T | null => {
        if (!arr || !arr.length) return null;
        for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as T;
        return null;
      };
      rsi14 = last(inds["rsi14"] as Array<number | null>);
      macdHist = last(inds["macdHist"] as Array<number | null>);
      supertrendDir = last(inds["supertrendDir"] as Array<number | null>);
    }
  }

  // Latest signal for this symbol (if any).
  const sig = await Signal.findOne({ symbol }).sort({ createdAt: -1 }).lean();

  let compositeScore: number | undefined;
  let recommendation: string | undefined;
  if (includeComposite && candles.length >= 60) {
    const peer = buildPeerIndex(symbol, 500);
    const adRatio = computeAdvanceDeclineRatio();
    const r = await runComposite({
      symbol,
      candles,
      peer_candles: peer.length ? peer : undefined,
      sentiment: { ad_ratio: adRatio },
    });
    if (r) {
      compositeScore = r.composite_score;
      recommendation = r.recommendation;
      const trendInd = r.signals.trend?.metadata?.adx;
      if (typeof trendInd === "number") adx14 = trendInd;
    }
  }

  return {
    symbol,
    price: last,
    changePct,
    rsi14,
    macdHist,
    supertrendDir,
    adx14,
    volumeRatio,
    compositeScore,
    recommendation,
    signal: sig?.action,
    signalConfidence: sig?.confidence,
    matched: false,
  };
}

export async function runScan(req: ScanRequest): Promise<{ rows: ScanRow[]; matched: ScanRow[] }> {
  const universe = req.universe?.length ? req.universe : mockFeed.symbols();
  const rows = await Promise.all(universe.map((s) => buildRowForSymbol(s, req.includeComposite ?? false)));

  function valueOf(row: ScanRow, field: string): number | null {
    switch (field) {
      case "rsi14": return row.rsi14;
      case "macdHist": return row.macdHist;
      case "supertrendDir": return row.supertrendDir;
      case "adx14": return row.adx14;
      case "volume_ratio": return row.volumeRatio;
      case "composite_score": return row.compositeScore ?? null;
      case "price": return row.price;
      case "change_pct": return row.changePct;
      case "signal_confidence": return row.signalConfidence ?? null;
      default: return null;
    }
  }

  for (const row of rows) {
    const results = req.conditions.map((c) => {
      const v = valueOf(row, c.field);
      if (v == null) return false;
      return compare(v, c.operator, c.value);
    });
    row.matched =
      req.combinator === "OR" ? results.some(Boolean) : results.every(Boolean);
  }

  return { rows, matched: rows.filter((r) => r.matched) };
}

export const PRESET_SCANS: Record<string, ScanRequest> = {
  composite_strong_buy: {
    combinator: "AND",
    includeComposite: true,
    conditions: [{ field: "composite_score", operator: ">=", value: 70 }],
  },
  rsi_oversold: {
    combinator: "AND",
    conditions: [{ field: "rsi14", operator: "<", value: 30 }],
  },
  rsi_overbought: {
    combinator: "AND",
    conditions: [{ field: "rsi14", operator: ">", value: 70 }],
  },
  volume_breakout: {
    combinator: "AND",
    conditions: [
      { field: "volume_ratio", operator: ">=", value: 2.0 },
      { field: "change_pct", operator: ">=", value: 1.0 },
    ],
  },
  supertrend_buy: {
    combinator: "AND",
    conditions: [{ field: "supertrendDir", operator: ">", value: 0 }],
  },
  momentum_leaders: {
    combinator: "AND",
    includeComposite: true,
    conditions: [
      { field: "adx14", operator: ">", value: 30 },
      { field: "change_pct", operator: ">", value: 0 },
    ],
  },
  macd_bullish: {
    combinator: "AND",
    conditions: [{ field: "macdHist", operator: ">", value: 0 }],
  },
  macd_bearish: {
    combinator: "AND",
    conditions: [{ field: "macdHist", operator: "<", value: 0 }],
  },
};
