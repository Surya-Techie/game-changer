import { Router } from "express";
import axios from "axios";
import { requireAuth } from "../middleware/auth.js";
import { candleAggregator } from "../services/candleAggregator.js";
import { priceBook } from "../services/priceBook.js";
import { mockFeed } from "../services/mockFeed.js";
import { env } from "../config/env.js";

const router = Router();
router.use(requireAuth);

// ─── Real index adapter (yfinance via ai-service) ────────────────────────
// Yahoo carries the NSE/BSE indices: ^NSEI Nifty50, ^BSESN Sensex,
// ^NSEBANK Bank Nifty, ^INDIAVIX India VIX, plus the CNX sector indices.
// One batch per minute serves every dashboard client.

interface IdxQuote { ltp: number; pct_change: number; prev_close: number }

const INDEX_SYMBOLS: Record<string, string> = {
  nifty: "^NSEI",
  sensex: "^BSESN",
  bankNifty: "^NSEBANK",
  indiaVix: "^INDIAVIX",
  sectorIT: "^CNXIT",
  sectorAuto: "^CNXAUTO",
  sectorPharma: "^CNXPHARMA",
  sectorFMCG: "^CNXFMCG",
  sectorMetal: "^CNXMETAL",
  sectorEnergy: "^CNXENERGY",
};

let idxCache: { at: number; quotes: Record<string, IdxQuote> } = { at: 0, quotes: {} };
const IDX_TTL_MS = 60_000;

async function fetchIndices(): Promise<Record<string, IdxQuote>> {
  if (Date.now() - idxCache.at < IDX_TTL_MS) return idxCache.quotes;
  try {
    const symbols = Object.values(INDEX_SYMBOLS).join(",");
    const { data } = await axios.get(`${env.aiServiceUrl}/nse-live`, {
      params: { symbols },
      timeout: 12_000,
    });
    const raw = (data?.quotes ?? {}) as Record<string, IdxQuote>;
    const byKey: Record<string, IdxQuote> = {};
    for (const [key, ticker] of Object.entries(INDEX_SYMBOLS)) {
      const q = raw[ticker.toUpperCase()];
      if (q && isFinite(q.ltp) && q.ltp > 0) byKey[key] = q;
    }
    // Only refresh the cache timestamp when we actually got something, so a
    // rate-limited window retries next request instead of caching emptiness.
    if (Object.keys(byKey).length > 0) idxCache = { at: Date.now(), quotes: byKey };
    return byKey;
  } catch {
    return idxCache.quotes; // stale > nothing
  }
}

/**
 * Market-overview panel.
 *
 * REAL data:
 *   • A/D ratio computed from our universe
 *   • Market breadth — % of universe above its 20-bar EMA
 *   • Nifty proxy — equal-weighted basket of the universe (mock-feed only)
 *
 * MOCK data (clearly labeled with `source: "mock"`):
 *   • India VIX, Bank Nifty, Sensex, SGX Nifty, FII/DII, PCR
 *
 * Swap-in points: each block in `synthetic` should be replaced by a real
 * adapter (NSE bhavcopy / yfinance / paid feed) once API keys are wired.
 */
router.get("/", async (_req, res, next) => {
  try {
    const symbols = mockFeed.symbols();
    const snapshot = priceBook.snapshot();

    // A/D ratio + market breadth.
    let advancers = 0;
    let decliners = 0;
    let aboveEma20 = 0;
    let totalEval = 0;
    for (const sym of symbols) {
      const candles = candleAggregator.getCandles(sym, 50);
      if (candles.length < 21) continue;
      totalEval++;
      const ref = candles[Math.max(0, candles.length - 30)]!.c;
      const last = snapshot[sym] ?? candles[candles.length - 1]!.c;
      if (last > ref) advancers++;
      else if (last < ref) decliners++;
      // EMA20 (rough)
      let ema = candles[candles.length - 20]!.c;
      const k = 2 / 21;
      for (let i = candles.length - 19; i < candles.length; i++) ema = candles[i]!.c * k + ema * (1 - k);
      if (last > ema) aboveEma20++;
    }
    const adRatio = decliners === 0 ? (advancers === 0 ? 1 : 99) : advancers / decliners;
    const breadthPct = totalEval > 0 ? (aboveEma20 / totalEval) * 100 : 0;

    // Nifty proxy = mean of universe closes (real, from our candles).
    let niftyProxy: number | null = null;
    let niftyChange: number | null = null;
    if (totalEval > 0) {
      let sumNow = 0;
      let sumRef = 0;
      let count = 0;
      for (const sym of symbols) {
        const candles = candleAggregator.getCandles(sym, 50);
        if (candles.length < 20) continue;
        sumNow += snapshot[sym] ?? candles[candles.length - 1]!.c;
        sumRef += candles[Math.max(0, candles.length - 30)]!.c;
        count++;
      }
      if (count) {
        niftyProxy = sumNow / count;
        niftyChange = ((sumNow - sumRef) / sumRef) * 100;
      }
    }

    // ── Real indices (yfinance) with per-field mock fallback ────────────
    const idx = await fetchIndices();
    const hourBucket = Math.floor(Date.now() / (1000 * 60 * 60));
    const synthRng = (seed: number) => {
      const x = Math.sin(seed * 9301 + 49297) * 233280;
      return x - Math.floor(x);
    };

    const indiaVix = idx.indiaVix?.ltp ?? 13 + synthRng(hourBucket) * 8;
    const bankNiftyChange = idx.bankNifty?.pct_change ?? (synthRng(hourBucket + 4) - 0.5) * 2;
    const sensexChange = idx.sensex?.pct_change ?? (synthRng(hourBucket + 5) - 0.5) * 2;
    // PCR / FII-DII / GIFT Nifty have no free reliable source — still mock.
    const pcr = 0.85 + synthRng(hourBucket + 1) * 0.6;
    const fiiNetCr = (synthRng(hourBucket + 2) - 0.5) * 3000;
    const diiNetCr = (synthRng(hourBucket + 3) - 0.5) * 2500;
    const sgxNiftyChange = (synthRng(hourBucket + 6) - 0.5) * 1.5;

    const sectorDefs: Array<{ name: string; key: string; seed: number }> = [
      { name: "IT", key: "sectorIT", seed: 10 },
      { name: "Banking", key: "bankNifty", seed: 11 },
      { name: "Auto", key: "sectorAuto", seed: 12 },
      { name: "Pharma", key: "sectorPharma", seed: 13 },
      { name: "FMCG", key: "sectorFMCG", seed: 14 },
      { name: "Metal", key: "sectorMetal", seed: 15 },
      { name: "Energy", key: "sectorEnergy", seed: 16 },
    ];
    const sectors = sectorDefs.map((s) => {
      const q = idx[s.key];
      return {
        name: s.name,
        changePct: Number((q?.pct_change ?? synthRng(hourBucket + s.seed) * 4 - 2).toFixed(2)),
        source: q ? "live" : "mock",
      };
    });
    const sectorsLive = sectors.every((s) => s.source === "live");

    res.json({
      ts: Date.now(),
      real: {
        adRatio: Number(adRatio.toFixed(3)),
        advancers,
        decliners,
        breadthPct: Number(breadthPct.toFixed(1)),
        symbolsEvaluated: totalEval,
        // Real Nifty 50 index when Yahoo delivers; equal-weight proxy kept
        // as fallback so the tile never goes blank.
        niftyProxy: idx.nifty ? Number(idx.nifty.ltp.toFixed(2)) : (niftyProxy != null ? Number(niftyProxy.toFixed(2)) : null),
        niftyProxyChangePct: idx.nifty
          ? Number(idx.nifty.pct_change.toFixed(3))
          : (niftyChange != null ? Number(niftyChange.toFixed(3)) : null),
        niftyIsRealIndex: Boolean(idx.nifty),
      },
      // Per-field provenance — the UI shows LIVE/MOCK badges from this.
      sources: {
        indiaVix: idx.indiaVix ? "live" : "mock",
        bankNifty: idx.bankNifty ? "live" : "mock",
        sensex: idx.sensex ? "live" : "mock",
        nifty: idx.nifty ? "live" : "mock",
        sectors: sectorsLive ? "live" : "mixed",
        pcr: "mock",
        fii: "mock",
        sgxNifty: "mock",
      },
      synthetic: {
        source: "mixed",
        note: "PCR / FII-DII / GIFT Nifty are demo values (no free reliable source). Indices and sectors are live Yahoo Finance data when reachable.",
        indiaVix: Number(indiaVix.toFixed(2)),
        indiaVixZone: indiaVix < 15 ? "calm" : indiaVix < 20 ? "caution" : "fear",
        pcr: Number(pcr.toFixed(2)),
        pcrInterpretation: pcr >= 1.2 ? "bullish (high put OI)" : pcr <= 0.8 ? "bearish (low put OI)" : "neutral",
        fiiNetCr: Number(fiiNetCr.toFixed(1)),
        diiNetCr: Number(diiNetCr.toFixed(1)),
        bankNiftyChangePct: Number(bankNiftyChange.toFixed(2)),
        sensexChangePct: Number(sensexChange.toFixed(2)),
        sgxNiftyChangePct: Number(sgxNiftyChange.toFixed(2)),
      },
      sectors,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
