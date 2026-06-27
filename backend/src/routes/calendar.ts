import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

interface EconEvent {
  date: string;     // YYYY-MM-DD
  timeLocal: string; // HH:MM IST or ET (label only)
  country: "IN" | "US";
  name: string;
  importance: "HIGH" | "MEDIUM" | "LOW";
  previous?: string;
  forecast?: string;
  actual?: string | null;
}

/**
 * Synthetic economic calendar.
 *
 * This is mock data clearly labeled. For real usage, swap with:
 *   • Trading Economics API (paid)
 *   • Investing.com calendar (scrape)
 *   • Forex Factory CSV export
 * One file change in this route swaps the source.
 */
function generateEvents(now: Date): EconEvent[] {
  const out: EconEvent[] = [];

  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);

  // Deterministic per-day seed so the calendar doesn't jitter on refresh.
  const rng = (seed: number) => {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  // Indian recurring events (rough monthly pattern).
  const indianTemplates = [
    { name: "RBI Repo Rate Decision", impact: "HIGH", time: "10:00 IST", previous: "6.50%", forecast: "6.50%" },
    { name: "CPI Inflation YoY", impact: "HIGH", time: "17:30 IST", previous: "5.10%", forecast: "5.05%" },
    { name: "GDP Growth Rate QoQ", impact: "HIGH", time: "17:30 IST", previous: "8.40%", forecast: "7.60%" },
    { name: "Industrial Production (IIP)", impact: "MEDIUM", time: "17:30 IST", previous: "4.7%", forecast: "5.1%" },
    { name: "WPI Inflation YoY", impact: "MEDIUM", time: "12:00 IST", previous: "0.5%", forecast: "0.8%" },
    { name: "Trade Balance", impact: "LOW", time: "12:00 IST", previous: "-$19.1B", forecast: "-$20.2B" },
    { name: "Manufacturing PMI", impact: "MEDIUM", time: "10:30 IST", previous: "58.4", forecast: "58.0" },
    { name: "Services PMI", impact: "MEDIUM", time: "10:30 IST", previous: "61.8", forecast: "61.5" },
  ];

  const usTemplates = [
    { name: "FOMC Interest Rate Decision", impact: "HIGH", time: "14:00 ET", previous: "5.50%", forecast: "5.50%" },
    { name: "CPI YoY", impact: "HIGH", time: "08:30 ET", previous: "3.1%", forecast: "3.0%" },
    { name: "Non-Farm Payrolls", impact: "HIGH", time: "08:30 ET", previous: "175K", forecast: "190K" },
    { name: "Unemployment Rate", impact: "HIGH", time: "08:30 ET", previous: "3.8%", forecast: "3.8%" },
    { name: "Retail Sales MoM", impact: "MEDIUM", time: "08:30 ET", previous: "0.6%", forecast: "0.4%" },
    { name: "GDP Growth Annualized QoQ", impact: "HIGH", time: "08:30 ET", previous: "3.4%", forecast: "2.0%" },
    { name: "Core PCE Price Index YoY", impact: "HIGH", time: "08:30 ET", previous: "2.8%", forecast: "2.7%" },
    { name: "ISM Manufacturing PMI", impact: "MEDIUM", time: "10:00 ET", previous: "50.3", forecast: "50.1" },
    { name: "Initial Jobless Claims", impact: "LOW", time: "08:30 ET", previous: "212K", forecast: "215K" },
  ];

  for (let day = 0; day < 7; day++) {
    const d = new Date(today.getTime() + day * 86400000);
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat — skip weekends
    if (dow === 0 || dow === 6) continue;
    const dayStr = d.toISOString().slice(0, 10);
    const seed = d.getUTCFullYear() * 10000 + d.getUTCMonth() * 100 + d.getUTCDate();

    // 1–2 Indian events.
    const inCount = rng(seed) > 0.35 ? 2 : 1;
    for (let i = 0; i < inCount; i++) {
      const t = indianTemplates[Math.floor(rng(seed + i * 7) * indianTemplates.length)]!;
      out.push({
        date: dayStr,
        timeLocal: t.time,
        country: "IN",
        name: t.name,
        importance: t.impact as EconEvent["importance"],
        previous: t.previous,
        forecast: t.forecast,
        actual: day === 0 && rng(seed + 100 + i) > 0.5 ? t.forecast : null,
      });
    }

    // 1–2 US events.
    const usCount = rng(seed + 5) > 0.4 ? 2 : 1;
    for (let i = 0; i < usCount; i++) {
      const t = usTemplates[Math.floor(rng(seed + 50 + i * 11) * usTemplates.length)]!;
      out.push({
        date: dayStr,
        timeLocal: t.time,
        country: "US",
        name: t.name,
        importance: t.impact as EconEvent["importance"],
        previous: t.previous,
        forecast: t.forecast,
        actual: day === 0 && rng(seed + 200 + i) > 0.5 ? t.forecast : null,
      });
    }
  }

  // Sort by date, then HIGH first.
  const impactRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  out.sort((a, b) => a.date.localeCompare(b.date) || impactRank[a.importance] - impactRank[b.importance]);
  return out;
}

router.get("/", (_req, res) => {
  const events = generateEvents(new Date());
  const today = new Date().toISOString().slice(0, 10);
  const todayEvents = events.filter((e) => e.date === today);
  res.json({
    source: "mock",
    note: "Synthetic calendar. Swap with Trading Economics / Investing.com / Forex Factory adapter in routes/calendar.ts when a feed key is wired.",
    today,
    todayEvents,
    upcoming: events,
  });
});

router.get("/today", (_req, res) => {
  const events = generateEvents(new Date());
  const today = new Date().toISOString().slice(0, 10);
  res.json({ today, events: events.filter((e) => e.date === today) });
});

export default router;
