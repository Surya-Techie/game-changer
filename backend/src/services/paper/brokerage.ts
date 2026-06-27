// Zerodha-style brokerage simulation.
// Intraday (MIS): ~₹40-45 round trip for ~₹1L turnover.
// Delivery (CNC): zero brokerage on Zerodha; STT/exchange/GST still apply.

type Side = "BUY" | "SELL";
type ProductType = "MIS" | "CNC";

interface LegInput {
  price: number;
  qty: number;
  side: Side;
  productType: ProductType;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function legBrokerage(turnover: number, productType: ProductType): number {
  if (productType === "CNC") return 0;
  // 0.03% of turnover capped at ₹20.
  return Math.min(20, turnover * 0.0003);
}

function legCharges(input: LegInput): number {
  const turnover = input.price * input.qty;
  const brokerage = legBrokerage(turnover, input.productType);

  // STT: 0.025% on sell side for MIS, 0.1% both sides for CNC.
  let stt = 0;
  if (input.productType === "MIS" && input.side === "SELL") stt = turnover * 0.00025;
  if (input.productType === "CNC") stt = turnover * 0.001;

  // Exchange transaction charges (NSE equity): 0.00345% of turnover.
  const exchange = turnover * 0.0000345;

  // SEBI charges: ₹10 per crore = 1e-6 of turnover.
  const sebi = turnover * 0.000001;

  // GST: 18% on (brokerage + exchange + sebi).
  const gst = (brokerage + exchange + sebi) * 0.18;

  // Stamp duty: 0.003% on buy side (MIS), 0.015% on buy side (CNC).
  let stamp = 0;
  if (input.side === "BUY") {
    stamp = input.productType === "CNC" ? turnover * 0.00015 : turnover * 0.00003;
  }

  return brokerage + stt + exchange + sebi + gst + stamp;
}

export interface RoundTripBreakdown {
  brokerage: number;
  total: number;
}

/**
 * Total charges for a round trip (entry + exit). Used at close time
 * to compute net P&L. For previewing a single leg before order
 * placement, use `previewLegCharges`.
 */
export function roundTripCharges(
  entryPrice: number,
  exitPrice: number,
  qty: number,
  direction: "LONG" | "SHORT",
  productType: ProductType
): RoundTripBreakdown {
  // LONG: BUY entry, SELL exit. SHORT: SELL entry, BUY exit.
  const entrySide: Side = direction === "LONG" ? "BUY" : "SELL";
  const exitSide: Side = direction === "LONG" ? "SELL" : "BUY";

  const a = legCharges({ price: entryPrice, qty, side: entrySide, productType });
  const b = legCharges({ price: exitPrice, qty, side: exitSide, productType });
  return { brokerage: round2(a + b), total: round2(a + b) };
}

export function previewLegCharges(
  price: number,
  qty: number,
  side: Side,
  productType: ProductType
): number {
  return round2(legCharges({ price, qty, side, productType }));
}
