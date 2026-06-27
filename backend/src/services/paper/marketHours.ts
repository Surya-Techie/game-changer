// NSE market hours and holiday calendar, in IST.
// All helpers accept an optional `now` for testability.

const NSE_HOLIDAYS_2025_2026 = new Set([
  // 2025
  "2025-01-26", // Republic Day
  "2025-02-26", // Mahashivratri
  "2025-03-14", // Holi
  "2025-03-31", // Id-ul-Fitr (Ramzan Eid)
  "2025-04-10", // Mahavir Jayanti
  "2025-04-14", // Dr. Ambedkar Jayanti
  "2025-04-18", // Good Friday
  "2025-05-01", // Maharashtra Day
  "2025-06-07", // Eid-ul-Adha
  "2025-08-15", // Independence Day
  "2025-08-27", // Ganesh Chaturthi
  "2025-10-02", // Mahatma Gandhi Jayanti
  "2025-10-21", // Diwali Laxmi Puja (special muhurat trading separate)
  "2025-10-22", // Diwali Balipratipada
  "2025-11-05", // Gurunanak Jayanti
  "2025-12-25", // Christmas
  // 2026
  "2026-01-26",
  "2026-02-15", // Mahashivratri (illustrative)
  "2026-03-03", // Holi (illustrative)
  "2026-04-03", // Good Friday
  "2026-05-01",
  "2026-08-15",
  "2026-10-02",
  "2026-12-25",
]);

/** YYYY-MM-DD in Asia/Kolkata. */
function istDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Minutes since IST midnight (0–1439). */
function istMinuteOfDay(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** 0=Sun ... 6=Sat in IST. */
function istWeekday(d: Date): number {
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

export function isHoliday(d: Date = new Date()): boolean {
  return NSE_HOLIDAYS_2025_2026.has(istDateKey(d));
}

export function isWeekend(d: Date = new Date()): boolean {
  const w = istWeekday(d);
  return w === 0 || w === 6;
}

export function isTradingDay(d: Date = new Date()): boolean {
  return !isWeekend(d) && !isHoliday(d);
}

const OPEN_MIN = 9 * 60 + 15; // 09:15
const CLOSE_MIN = 15 * 60 + 30; // 15:30
const PRE_OPEN_MIN = 9 * 60; // 09:00
const SQUAREOFF_WARN_MIN = 15 * 60 + 20; // 15:20
const SQUAREOFF_RUN_MIN = 15 * 60 + 25; // 15:25
const DAY_ORDER_EXPIRE_MIN = 15 * 60 + 20; // cancel DAY orders just before squareoff

export interface MarketStatus {
  state: "OPEN" | "PRE_OPEN" | "CLOSED";
  istNow: string; // "HH:MM"
  istDate: string; // "YYYY-MM-DD"
  minutesToOpen?: number;
  minutesToClose?: number;
  isHoliday: boolean;
  isWeekend: boolean;
  nextOpenIso?: string;
}

export function marketStatus(now: Date = new Date()): MarketStatus {
  const istDate = istDateKey(now);
  const minute = istMinuteOfDay(now);
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  const istNow = `${hh}:${mm}`;
  const holiday = isHoliday(now);
  const weekend = isWeekend(now);
  const tradingDay = !holiday && !weekend;

  if (tradingDay && minute >= OPEN_MIN && minute < CLOSE_MIN) {
    return {
      state: "OPEN",
      istNow,
      istDate,
      minutesToClose: CLOSE_MIN - minute,
      isHoliday: holiday,
      isWeekend: weekend,
    };
  }
  if (tradingDay && minute >= PRE_OPEN_MIN && minute < OPEN_MIN) {
    return {
      state: "PRE_OPEN",
      istNow,
      istDate,
      minutesToOpen: OPEN_MIN - minute,
      isHoliday: holiday,
      isWeekend: weekend,
    };
  }
  return {
    state: "CLOSED",
    istNow,
    istDate,
    isHoliday: holiday,
    isWeekend: weekend,
    nextOpenIso: nextOpenIso(now),
  };
}

export function isMarketOpen(now: Date = new Date()): boolean {
  return marketStatus(now).state === "OPEN";
}

export function shouldRunEodSquareoff(now: Date = new Date()): boolean {
  const m = istMinuteOfDay(now);
  return isTradingDay(now) && m >= SQUAREOFF_RUN_MIN && m < CLOSE_MIN;
}

export function shouldWarnSquareoff(now: Date = new Date()): boolean {
  const m = istMinuteOfDay(now);
  return isTradingDay(now) && m >= SQUAREOFF_WARN_MIN && m < SQUAREOFF_RUN_MIN;
}

export function shouldExpireDayOrders(now: Date = new Date()): boolean {
  const m = istMinuteOfDay(now);
  return isTradingDay(now) && m >= DAY_ORDER_EXPIRE_MIN && m < CLOSE_MIN;
}

function nextOpenIso(from: Date): string {
  // Walk forward up to 14 days looking for the next trading day's 9:15 IST.
  const d = new Date(from);
  for (let i = 0; i < 14; i++) {
    const candidate = new Date(d.getTime() + i * 86_400_000);
    if (isTradingDay(candidate)) {
      const sameDay =
        istDateKey(candidate) === istDateKey(from) &&
        istMinuteOfDay(from) < OPEN_MIN;
      if (i > 0 || sameDay) {
        // Compose the IST 09:15 instant by formatting then re-parsing.
        const dateKey = istDateKey(candidate);
        // 09:15 IST → 03:45 UTC (IST is +5:30).
        return new Date(`${dateKey}T03:45:00.000Z`).toISOString();
      }
    }
  }
  return new Date(from.getTime() + 86_400_000).toISOString();
}
