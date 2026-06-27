// Realistic fill-price math for paper orders.
//
// Matches the Section 3 slippage model from the spec:
//   MARKET: ±0.15% (worse-side fill)
//   LIMIT:  no slippage (fills at limit)
//   SL_MARKET: ±0.20% (gap-risk widening)
//   SL_LIMIT: at limit price (may not fill if price gaps through)
// Large orders (turnover > ₹5L) add an extra 5 bps.

const MARKET_SLIP_BPS = 15;
const SL_MARKET_SLIP_BPS = 20;
const LARGE_TURNOVER_THRESHOLD = 500_000;
const LARGE_TURNOVER_EXTRA_BPS = 5;

export type FillSide = "OPEN_LONG" | "CLOSE_LONG" | "OPEN_SHORT" | "CLOSE_SHORT";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function applyBpsWorse(price: number, qty: number, bps: number, side: FillSide): number {
  const extra =
    price * qty > LARGE_TURNOVER_THRESHOLD ? LARGE_TURNOVER_EXTRA_BPS : 0;
  const slip = (price * (bps + extra)) / 10_000;
  // Worse-side: buy fills higher, sell fills lower.
  const isBuy = side === "OPEN_LONG" || side === "CLOSE_SHORT";
  return round2(isBuy ? price + slip : price - slip);
}

export function marketFill(refPrice: number, qty: number, side: FillSide): number {
  return applyBpsWorse(refPrice, qty, MARKET_SLIP_BPS, side);
}

export function slMarketFill(triggerPrice: number, qty: number, side: FillSide): number {
  return applyBpsWorse(triggerPrice, qty, SL_MARKET_SLIP_BPS, side);
}

export function limitFill(limitPrice: number): number {
  return round2(limitPrice);
}
