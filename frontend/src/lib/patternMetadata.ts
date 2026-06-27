// ⚠️ REFERENCE FIGURES — NOT MEASURED ON YOUR DATA.
//
// These win rates are textbook/literature reliability estimates for each
// chart pattern (e.g. Bulkowski-style studies). They are static constants,
// NOT computed from this system's detections or backtests. They exist to
// give a rough prior next to a freshly-detected pattern.
//
// For win rates ACTUALLY measured by this engine (with real sample sizes),
// see the Pattern Analytics page / the "Accuracy" tab, which reads the
// pattern-accuracy rollups the backend resolves from live outcomes.
//
// The UI must label these as "ref" — never as measured "accuracy".
export interface PatternMeta {
  /** Reference reliability % from TA literature — NOT measured here. */
  winRate: number;
  direction: "bullish" | "bearish" | "continuation" | "neutral";
  name: string;
}

export const PATTERN_WIN_RATES: Record<string, PatternMeta> = {
  "Head and Shoulders": { name: "Head and Shoulders", winRate: 95.2, direction: "bearish" },
  "Order Block Bullish": { name: "Order Block Bullish", winRate: 86.7, direction: "bullish" },
  "Double Bottom": { name: "Double Bottom", winRate: 84.6, direction: "bullish" },
  "Order Block Bearish": { name: "Order Block Bearish", winRate: 84.2, direction: "bearish" },
  "Three Black Crows": { name: "Three Black Crows", winRate: 81.8, direction: "bearish" },
  "Morning Star": { name: "Morning Star", winRate: 81.3, direction: "bullish" },
  "Liquidity Sweep": { name: "Liquidity Sweep", winRate: 79.0, direction: "neutral" },
  "Descending Triangle": { name: "Descending Triangle", winRate: 78.3, direction: "bearish" },
  "Three White Soldiers": { name: "Three White Soldiers", winRate: 75.0, direction: "bullish" },
  "Bear Flag": { name: "Bear Flag", winRate: 73.7, direction: "bearish" },
  "Wyckoff Spring": { name: "Wyckoff Spring", winRate: 73.7, direction: "bullish" },
  "Evening Star": { name: "Evening Star", winRate: 72.7, direction: "bearish" },
  "Doji": { name: "Doji", winRate: 71.4, direction: "neutral" },
  "Double Top": { name: "Double Top", winRate: 70.0, direction: "bearish" },
  "Inverted Hammer": { name: "Inverted Hammer", winRate: 69.2, direction: "bullish" },
  "Bearish Engulfing": { name: "Bearish Engulfing", winRate: 66.7, direction: "bearish" },
  "Bullish Engulfing": { name: "Bullish Engulfing", winRate: 64.3, direction: "bullish" },
  "Piercing Line": { name: "Piercing Line", winRate: 64.3, direction: "bullish" },
  "Ascending Triangle": { name: "Ascending Triangle", winRate: 64.3, direction: "bullish" },
  "Shooting Star": { name: "Shooting Star", winRate: 61.1, direction: "bearish" },
  "Hammer": { name: "Hammer", winRate: 60.0, direction: "bullish" },
  "Bull Flag": { name: "Bull Flag", winRate: 58.8, direction: "bullish" },
  "Dark Cloud Cover": { name: "Dark Cloud Cover", winRate: 55.6, direction: "bearish" },
  "Hanging Man": { name: "Hanging Man", winRate: 50.0, direction: "bearish" },
  "Inverse Head and Shoulders": { name: "Inverse Head and Shoulders", winRate: 50.0, direction: "bullish" },
};

export interface PatternAdvice {
  winRate: number;
  strengthText: string;
  badgeClass: string;
  textColor: string;
  barColor: string;
  adviceMsg: string;
}

export function getPatternAdvice(patternName: string, fallbackDirection: string = "neutral"): PatternAdvice {
  // Normalize checking
  const match = Object.keys(PATTERN_WIN_RATES).find(
    (k) => k.toLowerCase() === patternName.toLowerCase()
  );
  const meta = match ? PATTERN_WIN_RATES[match] : null;

  const winRate = meta ? meta.winRate : 50.0;
  const direction = meta ? meta.direction : (fallbackDirection.toLowerCase() as PatternMeta["direction"]);

  let strengthText = "";
  let badgeClass = "";
  let textColor = "";
  let barColor = "";
  let adviceMsg = "";

  if (direction === "bullish") {
    strengthText = `~${winRate}% BUY`;
    badgeClass = winRate >= 75
      ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
      : "bg-emerald-500/10 text-emerald-400/90 border-emerald-500/20";
    textColor = "text-emerald-400";
    barColor = "bg-emerald-500";
    adviceMsg = `Bullish pattern detected. Reference reliability ~${winRate}% (TA literature, not measured on your data).`;
  } else if (direction === "bearish") {
    strengthText = `~${winRate}% SELL`;
    badgeClass = winRate >= 75
      ? "bg-rose-500/20 text-rose-400 border-rose-500/30"
      : "bg-rose-500/10 text-rose-400/90 border-rose-500/20";
    textColor = "text-rose-400";
    barColor = "bg-rose-500";
    adviceMsg = `Bearish pattern detected. Reference reliability ~${winRate}% (TA literature, not measured on your data).`;
  } else {
    strengthText = `~${winRate}% NEUTRAL`;
    badgeClass = "bg-slate-500/15 text-slate-400 border-slate-500/20";
    textColor = "text-slate-400";
    barColor = "bg-slate-500";
    adviceMsg = `Neutral pattern detected. Reference reliability ~${winRate}% (TA literature, not measured on your data).`;
  }

  return {
    winRate,
    strengthText,
    badgeClass,
    textColor,
    barColor,
    adviceMsg,
  };
}
