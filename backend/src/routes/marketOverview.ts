import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { candleAggregator } from "../services/candleAggregator.js";
import { priceBook } from "../services/priceBook.js";
import { mockFeed } from "../services/mockFeed.js";

const router = Router();
router.use(requireAuth);

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

    // Stable-ish synthetic values (deterministic per hour bucket so the UI
    // doesn't jitter wildly). These get swapped with real feeds later.
    const hourBucket = Math.floor(Date.now() / (1000 * 60 * 60));
    const synthRng = (seed: number) => {
      const x = Math.sin(seed * 9301 + 49297) * 233280;
      return x - Math.floor(x);
    };
    const indiaVix = 13 + synthRng(hourBucket) * 8;     // 13–21
    const pcr = 0.85 + synthRng(hourBucket + 1) * 0.6;  // 0.85–1.45
    const fiiNetCr = (synthRng(hourBucket + 2) - 0.5) * 3000; // ±1500 cr
    const diiNetCr = (synthRng(hourBucket + 3) - 0.5) * 2500;
    const bankNiftyChange = (synthRng(hourBucket + 4) - 0.5) * 2;
    const sensexChange = (synthRng(hourBucket + 5) - 0.5) * 2;
    const sgxNiftyChange = (synthRng(hourBucket + 6) - 0.5) * 1.5;

    res.json({
      ts: Date.now(),
      real: {
        adRatio: Number(adRatio.toFixed(3)),
        advancers,
        decliners,
        breadthPct: Number(breadthPct.toFixed(1)),
        symbolsEvaluated: totalEval,
        niftyProxy: niftyProxy != null ? Number(niftyProxy.toFixed(2)) : null,
        niftyProxyChangePct: niftyChange != null ? Number(niftyChange.toFixed(3)) : null,
      },
      // CLEARLY LABELED MOCK — these are placeholders until real data adapters
      // are wired (NSE bhavcopy / yfinance / paid feed).
      synthetic: {
        source: "mock",
        note: "Demo values. Wire NSE bhavcopy / paid feed in routes/marketOverview.ts to replace.",
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
      sectors: [
        { name: "IT", changePct: synthRng(hourBucket + 10) * 4 - 2 },
        { name: "Banking", changePct: synthRng(hourBucket + 11) * 4 - 2 },
        { name: "Auto", changePct: synthRng(hourBucket + 12) * 4 - 2 },
        { name: "Pharma", changePct: synthRng(hourBucket + 13) * 4 - 2 },
        { name: "FMCG", changePct: synthRng(hourBucket + 14) * 4 - 2 },
        { name: "Metal", changePct: synthRng(hourBucket + 15) * 4 - 2 },
        { name: "Energy", changePct: synthRng(hourBucket + 16) * 4 - 2 },
      ].map((s) => ({ ...s, changePct: Number(s.changePct.toFixed(2)) })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
