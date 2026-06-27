import axios from "axios";
import { mockFeed } from "./mockFeed.js";
import { logger } from "../utils/logger.js";

export interface DealRow {
  date: string;        // DD-MMM-YYYY (as NSE publishes)
  symbol: string;
  clientName: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  source: "nse" | "mock";
}

interface CacheEntry {
  rows: DealRow[];
  ts: number;
  fromNse: boolean;
}

let cache: CacheEntry | null = null;
const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const NSE_BULK = "https://nsearchives.nseindia.com/content/equities/bulk.csv";

/**
 * Parse the NSE bulk/block deals CSV.
 *
 * Expected header order (NSE has been consistent):
 *   Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks
 */
function parseNseCsv(csv: string): DealRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const rows: DealRow[] = [];
  // Skip header.
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i]!);
    if (cols.length < 7) continue;
    const date = cols[0]!.trim();
    const symbol = cols[1]!.trim();
    const clientName = (cols[3] ?? "").trim();
    const side = (cols[4] ?? "").trim().toUpperCase();
    const qty = Number((cols[5] ?? "0").replace(/,/g, ""));
    const price = Number((cols[6] ?? "0").replace(/,/g, ""));
    if (!symbol || (side !== "BUY" && side !== "SELL") || !Number.isFinite(qty) || !Number.isFinite(price)) continue;
    rows.push({ date, symbol, clientName, side: side as "BUY" | "SELL", qty, price, source: "nse" });
  }
  return rows;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function fetchNseCsv(url: string): Promise<string | null> {
  try {
    const { data } = await axios.get<string>(url, {
      timeout: 8000,
      responseType: "text",
      headers: {
        // NSE blocks default Node UA — pretend to be a browser-ish CSV downloader.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        Accept: "text/csv,application/csv,*/*;q=0.1",
        Referer: "https://www.nseindia.com/",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (typeof data !== "string" || !data.includes(",")) return null;
    return data;
  } catch (err) {
    logger.warn("NSE bulk-deals fetch failed", { url, err: (err as Error).message });
    return null;
  }
}

function generateMock(): DealRow[] {
  const symbols = mockFeed.symbols();
  const today = new Date();
  const dateStr =
    String(today.getDate()).padStart(2, "0") +
    "-" +
    today.toLocaleString("en-US", { month: "short" }).toUpperCase() +
    "-" +
    today.getFullYear();
  const FUNDS = [
    "ABU DHABI INVT AUTHORITY",
    "GOLDMAN SACHS INDIA",
    "MORGAN STANLEY ASIA",
    "SBI MUTUAL FUND",
    "HDFC MUTUAL FUND",
    "ICICI PRUDENTIAL MF",
    "AXIS MUTUAL FUND",
    "NORGES BANK A/C GOVT PENSION",
    "VANGUARD EMERGING MKTS",
    "BLACKROCK INDIA EQUITIES",
  ];
  const out: DealRow[] = [];
  // Deterministic per-day so the panel doesn't flicker across refreshes.
  const seed = today.getUTCFullYear() * 10000 + today.getUTCMonth() * 100 + today.getUTCDate();
  const rng = (n: number) => {
    const x = Math.sin(seed * 9301 + 49297 + n * 17) * 233280;
    return x - Math.floor(x);
  };
  for (let i = 0; i < 14; i++) {
    const symbol = symbols[Math.floor(rng(i) * symbols.length)] ?? "RELIANCE";
    const fund = FUNDS[Math.floor(rng(i + 99) * FUNDS.length)]!;
    const side: "BUY" | "SELL" = rng(i + 7) > 0.5 ? "BUY" : "SELL";
    const qty = Math.floor(50_000 + rng(i + 33) * 950_000);
    const price = Math.round((500 + rng(i + 55) * 3500) * 100) / 100;
    out.push({ date: dateStr, symbol, clientName: fund, side, qty, price, source: "mock" });
  }
  return out;
}

export async function getBulkDeals(force = false): Promise<{
  rows: DealRow[];
  ts: number;
  fromNse: boolean;
  note?: string;
}> {
  if (!force && cache && Date.now() - cache.ts < TTL_MS) {
    return { ...cache };
  }
  const csv = await fetchNseCsv(NSE_BULK);
  if (csv) {
    const rows = parseNseCsv(csv);
    if (rows.length > 0) {
      cache = { rows, ts: Date.now(), fromNse: true };
      logger.info("NSE bulk deals fetched", { rows: rows.length });
      return { ...cache };
    }
  }
  // Fallback to mock.
  const rows = generateMock();
  cache = { rows, ts: Date.now(), fromNse: false };
  return { ...cache, note: "NSE fetch unavailable — using synthetic data. Will retry on next cache expiry." };
}

export function watchlistSymbolsInDeals(watchlistSymbols: string[], rows: DealRow[]): Set<string> {
  const seen = new Set<string>();
  const upper = new Set(watchlistSymbols.map((s) => s.toUpperCase()));
  for (const r of rows) if (upper.has(r.symbol.toUpperCase())) seen.add(r.symbol.toUpperCase());
  return seen;
}
