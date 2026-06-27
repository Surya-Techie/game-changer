// Paper trading engine — the single source of truth for state changes.
//
// All mutations to PaperAccount cash / PaperPosition / PaperTrade /
// PaperOrder go through this module. The HTTP routes and the
// background position manager are both thin callers of these methods.

import mongoose, { Types } from "mongoose";
import { PaperAccount } from "../../models/PaperAccount.js";
import { PaperPosition } from "../../models/PaperPosition.js";
import { PaperTrade } from "../../models/PaperTrade.js";
import { PaperOrder } from "../../models/PaperOrder.js";
import { paperPriceFeed } from "./priceFeed.js";
import { marketFill, slMarketFill, limitFill, type FillSide } from "./slippage.js";
import {
  previewLegCharges,
  roundTripCharges,
} from "./brokerage.js";
import { captureEntrySignal } from "./entrySignal.js";
import { marketStatus, isMarketOpen } from "./marketHours.js";
import { emitPaper } from "./paperEvents.js";
import { logger } from "../../utils/logger.js";

export type ProductType = "MIS" | "CNC";
export type OrderType = "MARKET" | "LIMIT" | "SL_MARKET" | "SL_LIMIT";
export type Side = "BUY" | "SELL";
export type Direction = "LONG" | "SHORT";

const DEFAULT_CAPITAL = 1_000_000;
const MAX_ACCOUNTS_PER_USER = 3;
const MAX_OPEN_POSITIONS = 5;
const CIRCUIT_FILTER_PCT = 10; // limit price must be within ±10% of LTP

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function directionOfOpenSide(side: Side): Direction {
  return side === "BUY" ? "LONG" : "SHORT";
}

function fillSide(side: Side, action: "OPEN" | "CLOSE"): FillSide {
  if (action === "OPEN")
    return side === "BUY" ? "OPEN_LONG" : "OPEN_SHORT";
  return side === "BUY" ? "CLOSE_SHORT" : "CLOSE_LONG";
}

// ─────────────────────────────────────────────────────────────────────
// ACCOUNTS
// ─────────────────────────────────────────────────────────────────────

export async function listAccounts(userId: string) {
  return PaperAccount.find({ userId }).sort({ createdAt: 1 }).lean();
}

export async function createAccount(
  userId: string,
  name: string,
  startingCapital: number
) {
  const existing = await PaperAccount.countDocuments({ userId });
  if (existing >= MAX_ACCOUNTS_PER_USER) {
    throw httpError(400, `Maximum ${MAX_ACCOUNTS_PER_USER} paper accounts per user`);
  }
  const capital = Math.max(10_000, Math.round(startingCapital || DEFAULT_CAPITAL));
  const becomeActive = existing === 0;
  if (becomeActive) {
    await PaperAccount.updateMany({ userId, isActive: true }, { isActive: false });
  }
  const account = await PaperAccount.create({
    userId,
    name: name.trim() || "Default",
    startingCapital: capital,
    currentCash: capital,
    isActive: becomeActive,
  });
  emitPaper(userId, { kind: "account_changed", accountId: String(account._id) });
  return account.toObject();
}

export async function activateAccount(userId: string, accountId: string) {
  const target = await PaperAccount.findOne({ _id: accountId, userId });
  if (!target) throw httpError(404, "Account not found");
  await PaperAccount.updateMany({ userId, isActive: true }, { isActive: false });
  target.isActive = true;
  await target.save();
  emitPaper(userId, { kind: "account_changed", accountId: String(target._id) });
  return target.toObject();
}

export async function resetAccount(userId: string, accountId: string) {
  const account = await PaperAccount.findOne({ _id: accountId, userId });
  if (!account) throw httpError(404, "Account not found");
  // Wipe all paper data scoped to this account.
  await Promise.all([
    PaperPosition.deleteMany({ accountId }),
    PaperOrder.deleteMany({ accountId }),
    PaperTrade.deleteMany({ accountId }),
  ]);
  account.currentCash = account.startingCapital;
  account.resetAt = new Date();
  await account.save();
  emitPaper(userId, { kind: "account_changed", accountId: String(account._id) });
  return account.toObject();
}

export async function getActiveAccount(userId: string) {
  const account = await PaperAccount.findOne({ userId, isActive: true });
  if (account) return account;
  // Auto-create a default account on first paper page visit.
  const exists = await PaperAccount.findOne({ userId });
  if (!exists) {
    const created = await createAccount(userId, "Default", DEFAULT_CAPITAL);
    return PaperAccount.findById(created._id);
  }
  // Re-activate the first one if none are active.
  exists.isActive = true;
  await exists.save();
  return exists;
}

// ─────────────────────────────────────────────────────────────────────
// PORTFOLIO SUMMARY (derived — never cached on the account)
// ─────────────────────────────────────────────────────────────────────

export interface PortfolioSummary {
  accountId: string;
  name: string;
  startingCapital: number;
  cash: number;
  marginUsed: number;
  equity: number;
  unrealisedPnl: number;
  realisedPnlTotal: number;
  dayPnl: number;
  openPositions: number;
  pendingOrders: number;
  netPnl: number;
  netPnlPct: number;
  health: "GOOD" | "CAUTION" | "DANGER";
}

export async function portfolioSummary(userId: string, accountId: string): Promise<PortfolioSummary> {
  const account = await PaperAccount.findOne({ _id: accountId, userId }).lean();
  if (!account) throw httpError(404, "Account not found");

  const [positions, pendingOrders, trades, dayTrades] = await Promise.all([
    PaperPosition.find({ accountId }).lean(),
    PaperOrder.countDocuments({ accountId, status: { $in: ["PENDING", "QUEUED"] } }),
    PaperTrade.aggregate<{ _id: null; total: number }>([
      { $match: { accountId: new Types.ObjectId(accountId) } },
      { $group: { _id: null, total: { $sum: "$netPnl" } } },
    ]),
    PaperTrade.aggregate<{ _id: null; total: number }>([
      {
        $match: {
          accountId: new Types.ObjectId(accountId),
          exitTime: { $gte: startOfTodayIst() },
        },
      },
      { $group: { _id: null, total: { $sum: "$netPnl" } } },
    ]),
  ]);

  const marginUsed = positions.reduce(
    (acc, p) => acc + p.avgEntryPrice * p.qty,
    0
  );
  const positionsValue = positions.reduce(
    (acc, p) => acc + (p.currentPrice ?? p.avgEntryPrice) * p.qty,
    0
  );
  const unrealisedPnl = positions.reduce(
    (acc, p) => acc + (p.unrealisedPnl ?? 0),
    0
  );
  const equity = round2(account.currentCash + positionsValue);
  const realisedPnlTotal = round2(trades[0]?.total ?? 0);
  const dayPnl = round2(dayTrades[0]?.total ?? 0);
  const netPnl = round2(equity - account.startingCapital);
  const netPnlPct = (netPnl / account.startingCapital) * 100;

  const ratio = equity / account.startingCapital;
  const health: PortfolioSummary["health"] =
    ratio >= 0.8 ? "GOOD" : ratio >= 0.5 ? "CAUTION" : "DANGER";

  return {
    accountId: String(account._id),
    name: account.name,
    startingCapital: account.startingCapital,
    cash: round2(account.currentCash),
    marginUsed: round2(marginUsed),
    equity,
    unrealisedPnl: round2(unrealisedPnl),
    realisedPnlTotal,
    dayPnl,
    openPositions: positions.length,
    pendingOrders,
    netPnl,
    netPnlPct: round2(netPnlPct),
    health,
  };
}

function startOfTodayIst(): Date {
  const now = new Date();
  const istKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // IST midnight → 18:30 UTC previous day.
  return new Date(`${istKey}T00:00:00+05:30`);
}

// ─────────────────────────────────────────────────────────────────────
// ORDER PLACEMENT
// ─────────────────────────────────────────────────────────────────────

export interface PlaceOrderInput {
  accountId: string;
  symbol: string;
  side: Side;
  orderType: OrderType;
  qty: number;
  limitPrice?: number;
  triggerPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  trailingStopPct?: number;
  productType?: ProductType;
  validity?: "DAY" | "IOC" | "GTC";
  strategyTag?: string;
  acceptQueue?: boolean; // user OK with after-hours queueing
}

export interface PlaceOrderResult {
  orderId: string;
  status: string;
  filledPrice?: number;
  positionId?: string;
  queued?: boolean;
}

export async function placeOrder(userId: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const account = await PaperAccount.findOne({ _id: input.accountId, userId });
  if (!account) throw httpError(404, "Account not found");
  if (!input.symbol) throw httpError(400, "Symbol required");
  if (!Number.isInteger(input.qty) || input.qty < 1) throw httpError(400, "qty must be a positive integer");

  const symbol = input.symbol.toUpperCase();
  const productType: ProductType = input.productType ?? "MIS";

  // Validate bracket sanity.
  validateBracket(input);

  // Open positions cap (counts only this account).
  const openCount = await PaperPosition.countDocuments({ accountId: input.accountId });
  if (openCount >= MAX_OPEN_POSITIONS) {
    throw httpError(400, `Max ${MAX_OPEN_POSITIONS} open paper positions per account`);
  }

  // Market-closed check runs FIRST for MARKET orders, before we try to
  // fetch a price — otherwise users get a misleading "price unavailable"
  // error when the real problem is that the market is closed (yfinance
  // returns 0/null when the symbol isn't trading).
  const open = isMarketOpen();
  if (!open && input.orderType === "MARKET" && !input.acceptQueue) {
    throw httpError(
      409,
      "Market is closed (NSE: 9:15 AM - 3:30 PM IST, Mon-Fri). Set acceptQueue=true to queue this order for the next market open."
    );
  }

  // Price + circuit-filter checks (skip for SL orders — they specify trigger).
  const quote = await paperPriceFeed.fetch(symbol);
  if (!quote && input.orderType === "MARKET" && open) {
    throw httpError(400, "Price unavailable for MARKET order (yfinance unreachable). Try again in a moment.");
  }

  if (input.orderType === "LIMIT" && quote && input.limitPrice) {
    const driftPct = Math.abs((input.limitPrice - quote.price) / quote.price) * 100;
    if (driftPct > CIRCUIT_FILTER_PCT) {
      throw httpError(400, `Limit price more than ${CIRCUIT_FILTER_PCT}% from LTP (circuit filter)`);
    }
  }

  // Cash check: margin = entry * qty (estimated; intraday allows leverage
  // but for paper trading we keep 1:1 margin so the user sees realistic cash drain).
  // Skipped for after-hours QUEUED MARKET orders — we don't have a live
  // price yet; cash is re-validated when the queue is flushed at market open.
  const refPrice =
    input.orderType === "LIMIT" ? input.limitPrice :
    input.orderType === "SL_LIMIT" ? input.limitPrice :
    input.orderType === "SL_MARKET" ? input.triggerPrice :
    quote?.price;
  if (refPrice != null) {
    const requiredMargin = refPrice * input.qty;
    if (requiredMargin > account.currentCash + 1) {
      throw httpError(
        400,
        `Insufficient cash (need ₹${round2(requiredMargin).toLocaleString("en-IN")}, have ₹${round2(account.currentCash).toLocaleString("en-IN")})`
      );
    }
  } else if (input.orderType !== "MARKET" || open) {
    // Only require a price for non-queued orders. MARKET orders that
    // are about to fill synchronously really do need a live price.
    throw httpError(400, "Reference price unresolvable. For LIMIT/SL orders please supply a price; otherwise wait for the price feed to come back online.");
  }

  // Capture entry signal snapshot best-effort.
  const entrySignal = await captureEntrySignal(symbol).catch(() => undefined);

  // Decide initial status (market closed + acceptQueue=true → QUEUED).
  let initialStatus: "PENDING" | "QUEUED" = "PENDING";
  if (!open && input.orderType === "MARKET") {
    initialStatus = "QUEUED"; // acceptQueue already enforced above
  }

  const order = await PaperOrder.create({
    accountId: input.accountId,
    userId,
    symbol,
    side: input.side,
    orderType: input.orderType,
    qty: input.qty,
    limitPrice: input.limitPrice,
    triggerPrice: input.triggerPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    trailingStopPct: input.trailingStopPct,
    productType,
    validity: input.validity ?? "DAY",
    status: initialStatus,
    strategyTag: input.strategyTag ?? "",
    entrySignal,
  });

  emitPaper(userId, {
    kind: "order_placed",
    orderId: String(order._id),
    symbol,
    side: input.side,
    qty: input.qty,
    orderType: input.orderType,
  });

  // MARKET orders fill synchronously when market is open.
  if (input.orderType === "MARKET" && open) {
    const filledPrice = marketFill(quote!.price, input.qty, fillSide(input.side, "OPEN"));
    const positionId = await fillAndOpen(account, order, filledPrice);
    return { orderId: String(order._id), status: "FILLED", filledPrice, positionId };
  }

  return {
    orderId: String(order._id),
    status: initialStatus,
    queued: initialStatus === "QUEUED",
  };
}

function validateBracket(input: PlaceOrderInput) {
  if (input.stopLoss == null && input.takeProfit == null) return;
  // Use ref price for direction check.
  const refPrice =
    input.limitPrice ??
    input.triggerPrice ??
    paperPriceFeed.cached(input.symbol.toUpperCase())?.price;
  if (refPrice == null) return; // can't validate without a price
  const isLong = input.side === "BUY";
  if (input.stopLoss != null) {
    if (isLong && input.stopLoss >= refPrice)
      throw httpError(400, "LONG stop loss must be below entry");
    if (!isLong && input.stopLoss <= refPrice)
      throw httpError(400, "SHORT stop loss must be above entry");
  }
  if (input.takeProfit != null) {
    if (isLong && input.takeProfit <= refPrice)
      throw httpError(400, "LONG take profit must be above entry");
    if (!isLong && input.takeProfit >= refPrice)
      throw httpError(400, "SHORT take profit must be below entry");
  }
}

// ─────────────────────────────────────────────────────────────────────
// FILL — open/extend position and adjust cash
// ─────────────────────────────────────────────────────────────────────

async function fillAndOpen(
  account: mongoose.HydratedDocument<typeof PaperAccount.prototype>,
  order: mongoose.HydratedDocument<typeof PaperOrder.prototype>,
  filledPrice: number
): Promise<string> {
  const direction = directionOfOpenSide(order.side as Side);
  const cost = filledPrice * order.qty;

  // Pyramiding: if a same-direction position already exists for this symbol,
  // blend entries. Otherwise create a new position.
  const existing = await PaperPosition.findOne({
    accountId: account._id,
    symbol: order.symbol,
    direction,
  });

  let position: mongoose.HydratedDocument<typeof PaperPosition.prototype>;
  if (existing) {
    // Risk-management guardrail (Section 3 of spec): don't pile onto a
    // losing position beyond 2× the original size. Inspect the current
    // unrealised P&L — if the position is in the red AND this fill would
    // push qty past 2× originalQty, reject. The user can still close +
    // re-open if they want to override.
    const currentPrice = existing.currentPrice ?? existing.avgEntryPrice;
    const unrealised =
      existing.direction === "LONG"
        ? (currentPrice - existing.avgEntryPrice) * existing.qty
        : (existing.avgEntryPrice - currentPrice) * existing.qty;
    const projectedQty = existing.qty + order.qty;
    if (unrealised < 0 && projectedQty > existing.originalQty * 2) {
      throw httpError(
        400,
        `Pyramid limit: cannot add to a losing position beyond 2× original size (originalQty=${existing.originalQty}, currentQty=${existing.qty}, requested=${order.qty}).`
      );
    }
    const newAvg = round2(
      (existing.avgEntryPrice * existing.qty + filledPrice * order.qty) /
        (existing.qty + order.qty)
    );
    existing.avgEntryPrice = newAvg;
    existing.qty += order.qty;
    existing.originalQty += order.qty;
    if (order.stopLoss != null) existing.stopLoss = order.stopLoss;
    if (order.takeProfit != null) existing.takeProfit = order.takeProfit;
    if (order.trailingStopPct != null) existing.trailingStopPct = order.trailingStopPct;
    await existing.save();
    position = existing;
  } else {
    position = await PaperPosition.create({
      accountId: account._id,
      userId: account.userId,
      symbol: order.symbol,
      direction,
      qty: order.qty,
      originalQty: order.qty,
      avgEntryPrice: filledPrice,
      currentPrice: filledPrice,
      unrealisedPnl: 0,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      trailingStopPct: order.trailingStopPct,
      highWatermark: filledPrice,
      lowWatermark: filledPrice,
      maxAdverseExcursion: filledPrice,
      maxFavorableExcursion: filledPrice,
      productType: order.productType,
      strategyTag: order.strategyTag,
      entrySignal: order.entrySignal,
      openedAt: new Date(),
    });
  }

  // Cash drain.
  account.currentCash = round2(account.currentCash - cost);
  await account.save();

  // Order: mark filled.
  order.status = "FILLED";
  order.filledAt = new Date();
  order.filledPrice = filledPrice;
  order.filledPositionId = position._id as Types.ObjectId;
  await order.save();

  emitPaper(String(account.userId), {
    kind: "order_filled",
    orderId: String(order._id),
    symbol: order.symbol as string,
    side: order.side as Side,
    qty: order.qty,
    filledPrice,
    positionId: String(position._id),
  });
  emitPaper(String(account.userId), {
    kind: "position_opened",
    positionId: String(position._id),
    symbol: position.symbol,
    direction,
    qty: position.qty,
    avgEntryPrice: position.avgEntryPrice,
  });

  return String(position._id);
}

// ─────────────────────────────────────────────────────────────────────
// POSITION CLOSE (full or partial)
// ─────────────────────────────────────────────────────────────────────

export interface CloseInput {
  qty?: number; // omit or >= position.qty → full close
  exitReason?:
    | "MANUAL"
    | "SL"
    | "TP"
    | "TRAILING"
    | "SIGNAL_FLIP"
    | "AUTO_SQUAREOFF_EOD"
    | "PARTIAL_MANUAL";
  exitPriceOverride?: number; // used by the position manager for SL/TP fills
}

export async function closePosition(userId: string, positionId: string, input: CloseInput) {
  const position = await PaperPosition.findOne({ _id: positionId, userId });
  if (!position) throw httpError(404, "Position not found");
  const account = await PaperAccount.findById(position.accountId);
  if (!account) throw httpError(404, "Account not found");

  const closeQty = Math.min(input.qty && input.qty > 0 ? input.qty : position.qty, position.qty);
  const isPartial = closeQty < position.qty;

  // Determine exit price.
  let exitPrice: number;
  if (input.exitPriceOverride != null) {
    exitPrice = input.exitPriceOverride;
  } else {
    const quote = await paperPriceFeed.fetch(position.symbol);
    if (!quote) throw httpError(400, "Price unavailable to close");
    exitPrice = marketFill(quote.price, closeQty, fillSide(position.direction === "LONG" ? "SELL" : "BUY", "CLOSE"));
  }

  // Charges + P&L (proportional for partial close).
  const grossPnl =
    position.direction === "LONG"
      ? (exitPrice - position.avgEntryPrice) * closeQty
      : (position.avgEntryPrice - exitPrice) * closeQty;
  const { brokerage } = roundTripCharges(
    position.avgEntryPrice,
    exitPrice,
    closeQty,
    position.direction as Direction,
    position.productType as ProductType
  );
  const netPnl = round2(grossPnl - brokerage);
  const pnlPct =
    (grossPnl / (position.avgEntryPrice * closeQty)) * 100;

  // R multiple (only computable if a stop loss was set).
  let rMultiple: number | undefined;
  if (position.stopLoss != null) {
    const risk = Math.abs(position.avgEntryPrice - position.stopLoss) * closeQty;
    if (risk > 0) rMultiple = round2(netPnl / risk);
  }

  const entryTime = position.openedAt ?? position.createdAt ?? new Date();
  const exitTime = new Date();
  const trade = await PaperTrade.create({
    accountId: position.accountId,
    userId,
    symbol: position.symbol,
    direction: position.direction,
    qty: closeQty,
    entryPrice: position.avgEntryPrice,
    exitPrice,
    entryTime,
    exitTime,
    holdDurationMins: Math.max(0, Math.round((exitTime.getTime() - entryTime.getTime()) / 60_000)),
    grossPnl: round2(grossPnl),
    brokerage,
    netPnl,
    pnlPct: round2(pnlPct),
    rMultiple,
    exitReason: input.exitReason ?? (isPartial ? "PARTIAL_MANUAL" : "MANUAL"),
    productType: position.productType,
    maxAdverseExcursion: position.maxAdverseExcursion,
    maxFavorableExcursion: position.maxFavorableExcursion,
    entrySignal: position.entrySignal,
    strategyTag: position.strategyTag,
  });

  // Return cash: original margin back + P&L net of brokerage.
  const margin = position.avgEntryPrice * closeQty;
  account.currentCash = round2(account.currentCash + margin + netPnl);
  await account.save();

  if (isPartial) {
    position.qty -= closeQty;
    await position.save();
  } else {
    await position.deleteOne();
  }

  emitPaper(userId, {
    kind: "position_closed",
    positionId: String(position._id),
    symbol: position.symbol,
    netPnl,
    exitReason: trade.exitReason,
    exitPrice,
  });

  return { tradeId: String(trade._id), netPnl, exitPrice, isPartial };
}

// ─────────────────────────────────────────────────────────────────────
// PENDING ORDERS — modify / cancel
// ─────────────────────────────────────────────────────────────────────

export async function cancelOrder(userId: string, orderId: string) {
  const order = await PaperOrder.findOne({ _id: orderId, userId });
  if (!order) throw httpError(404, "Order not found");
  if (!["PENDING", "QUEUED"].includes(order.status as string)) {
    throw httpError(400, `Cannot cancel order in status ${order.status}`);
  }
  order.status = "CANCELLED";
  await order.save();
  emitPaper(userId, { kind: "order_cancelled", orderId: String(order._id) });
  return order.toObject();
}

export async function modifyOrder(
  userId: string,
  orderId: string,
  patch: Partial<Pick<PlaceOrderInput, "qty" | "limitPrice" | "triggerPrice" | "stopLoss" | "takeProfit" | "trailingStopPct">>
) {
  const order = await PaperOrder.findOne({ _id: orderId, userId });
  if (!order) throw httpError(404, "Order not found");
  if (!["PENDING", "QUEUED"].includes(order.status as string)) {
    throw httpError(400, `Cannot modify order in status ${order.status}`);
  }
  if (patch.qty != null) {
    if (!Number.isInteger(patch.qty) || patch.qty < 1) throw httpError(400, "qty must be a positive integer");
    order.qty = patch.qty;
  }
  if (patch.limitPrice !== undefined) order.limitPrice = patch.limitPrice;
  if (patch.triggerPrice !== undefined) order.triggerPrice = patch.triggerPrice;
  if (patch.stopLoss !== undefined) order.stopLoss = patch.stopLoss;
  if (patch.takeProfit !== undefined) order.takeProfit = patch.takeProfit;
  if (patch.trailingStopPct !== undefined) order.trailingStopPct = patch.trailingStopPct;
  await order.save();
  return order.toObject();
}

// ─────────────────────────────────────────────────────────────────────
// POSITION — modify (SL/TP/trailing)
// ─────────────────────────────────────────────────────────────────────

export async function modifyPosition(
  userId: string,
  positionId: string,
  patch: { stopLoss?: number | null; takeProfit?: number | null; trailingStopPct?: number | null; notes?: string; strategyTag?: string }
) {
  const position = await PaperPosition.findOne({ _id: positionId, userId });
  if (!position) throw httpError(404, "Position not found");
  if (patch.stopLoss !== undefined) position.stopLoss = patch.stopLoss ?? undefined;
  if (patch.takeProfit !== undefined) position.takeProfit = patch.takeProfit ?? undefined;
  if (patch.trailingStopPct !== undefined) position.trailingStopPct = patch.trailingStopPct ?? undefined;
  if (patch.notes !== undefined) position.notes = patch.notes;
  if (patch.strategyTag !== undefined) position.strategyTag = patch.strategyTag;
  await position.save();
  return position.toObject();
}

// ─────────────────────────────────────────────────────────────────────
// ORDER PREVIEW (for the order-entry terminal)
// ─────────────────────────────────────────────────────────────────────

export interface OrderPreviewInput {
  symbol: string;
  side: Side;
  orderType: OrderType;
  qty: number;
  limitPrice?: number;
  triggerPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  productType: ProductType;
}

export async function previewOrder(input: OrderPreviewInput) {
  const symbol = input.symbol.toUpperCase();
  const quote = await paperPriceFeed.fetch(symbol);
  const refPrice =
    input.orderType === "LIMIT" || input.orderType === "SL_LIMIT"
      ? input.limitPrice
      : input.orderType === "SL_MARKET"
      ? input.triggerPrice
      : quote?.price;
  if (refPrice == null) throw httpError(400, "Price unavailable");

  const estFill =
    input.orderType === "MARKET"
      ? marketFill(refPrice, input.qty, fillSide(input.side, "OPEN"))
      : input.orderType === "SL_MARKET"
      ? slMarketFill(refPrice, input.qty, fillSide(input.side, "OPEN"))
      : limitFill(refPrice);

  const marginRequired = round2(estFill * input.qty);
  const entryCharges = previewLegCharges(estFill, input.qty, input.side, input.productType);
  let maxLoss: number | undefined;
  let potentialGain: number | undefined;
  let rr: number | undefined;
  let quality: "GOOD" | "OK" | "POOR" | "MISSING" = "MISSING";
  if (input.stopLoss != null) {
    const stopDist = Math.abs(estFill - input.stopLoss);
    maxLoss = round2(stopDist * input.qty + entryCharges);
  }
  if (input.takeProfit != null) {
    const tpDist = Math.abs(input.takeProfit - estFill);
    potentialGain = round2(tpDist * input.qty - entryCharges);
  }
  if (maxLoss && potentialGain) {
    rr = round2(potentialGain / maxLoss);
    quality = rr >= 2 ? "GOOD" : rr >= 1 ? "OK" : "POOR";
  }

  return {
    symbol,
    ltp: quote?.price,
    estimatedFill: estFill,
    marginRequired,
    entryCharges,
    maxLoss,
    potentialGain,
    rr,
    quality,
    priceSource: quote?.source ?? "MISSING",
    priceDelayed: quote?.delayed ?? true,
    marketStatus: marketStatus().state,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers for background manager
// ─────────────────────────────────────────────────────────────────────

export async function distinctActiveSymbols(): Promise<string[]> {
  const [a, b] = await Promise.all([
    PaperPosition.distinct("symbol"),
    PaperOrder.distinct("symbol", { status: { $in: ["PENDING", "QUEUED"] } }),
  ]);
  return Array.from(new Set([...a, ...b].map((s) => String(s).toUpperCase())));
}

export { paperPriceFeed, slMarketFill, marketFill, limitFill, round2 };

// ─────────────────────────────────────────────────────────────────────
// Small typed error helper for routes
// ─────────────────────────────────────────────────────────────────────

interface HttpError extends Error {
  status: number;
}
function httpError(status: number, message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.status = status;
  return e;
}

// Avoid an unused-import warning when logger isn't called in this file build.
void logger;
