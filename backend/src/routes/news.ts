import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getSentiment } from "../services/aiClient.js";
import { mockFeed } from "../services/mockFeed.js";

const router = Router();
router.use(requireAuth);

/**
 * Synthetic news feed for the demo. Headlines are deterministic per symbol +
 * day so they're stable across refreshes. Sentiment is computed by the AI
 * service. Swap this generator with a real news adapter (NewsAPI, Finnhub,
 * Alpha Vantage) once an API key is provided.
 */

const HEADLINE_TEMPLATES = [
  (s: string) => `${s} reports record quarterly earnings, beats analyst estimates`,
  (s: string) => `Analysts upgrade ${s} on robust margin growth and bullish outlook`,
  (s: string) => `${s} announces strategic partnership, shares jump in early trade`,
  (s: string) => `Macro headwinds weigh on ${s}, brokerage flags caution`,
  (s: string) => `${s} warns of weak guidance amid slowdown concerns`,
  (s: string) => `${s} board approves dividend; investors cheer the move`,
  (s: string) => `${s} faces regulatory probe; risk to revenue noted`,
  (s: string) => `${s} unveils new product line, market reacts positively`,
  (s: string) => `${s} ratings cut by S&P; debt concerns linger`,
  (s: string) => `Buying interest returns in ${s} after sharp correction`,
];

function pickHeadline(symbol: string, slot: number): string {
  const idx = Math.abs(hash(symbol + ":" + slot)) % HEADLINE_TEMPLATES.length;
  return HEADLINE_TEMPLATES[idx](symbol);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

router.get("/", async (_req, res, next) => {
  try {
    const symbols = mockFeed.symbols();
    const dayBucket = Math.floor(Date.now() / (1000 * 60 * 60 * 4)); // rotates every 4h
    const items: Array<{ id: string; symbol: string; text: string; ts: number }> = [];
    for (const s of symbols) {
      for (let slot = 0; slot < 2; slot++) {
        items.push({
          id: `${s}-${dayBucket}-${slot}`,
          symbol: s,
          text: pickHeadline(s, dayBucket + slot),
          ts: Date.now() - slot * 1000 * 60 * (15 + (hash(s) & 31)),
        });
      }
    }
    const sentiment = (await getSentiment(items.map((it) => ({ id: it.id, text: it.text })))) as
      | { items: Array<{ id: string; label: string; score: number }> }
      | null;
    const map = new Map<string, { label: string; score: number }>(
      (sentiment?.items ?? []).map((s) => [s.id, { label: s.label, score: s.score }])
    );
    res.json({
      news: items
        .map((it) => ({ ...it, ...map.get(it.id) }))
        .sort((a, b) => b.ts - a.ts),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
