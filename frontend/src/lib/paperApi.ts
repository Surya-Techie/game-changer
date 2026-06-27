// Typed REST helpers for /api/paper/*. All requests inherit Bearer
// auth from the shared axios instance in lib/api.ts.

import { api } from "./api";

export type Direction = "LONG" | "SHORT";
export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL_MARKET" | "SL_LIMIT";
export type ProductType = "MIS" | "CNC";
export type Validity = "DAY" | "IOC" | "GTC";

export interface PaperAccount {
  _id: string;
  name: string;
  startingCapital: number;
  currentCash: number;
  isActive: boolean;
  createdAt?: string;
  resetAt?: string;
}

export interface Portfolio {
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

export interface PaperPosition {
  _id: string;
  accountId: string;
  symbol: string;
  direction: Direction;
  qty: number;
  originalQty: number;
  avgEntryPrice: number;
  currentPrice?: number;
  unrealisedPnl?: number;
  stopLoss?: number;
  takeProfit?: number;
  trailingStopPct?: number;
  maxAdverseExcursion?: number;
  maxFavorableExcursion?: number;
  productType: ProductType;
  strategyTag?: string;
  notes?: string;
  entrySignal?: Record<string, unknown>;
  openedAt: string;
}

export interface PaperOrder {
  _id: string;
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
  productType: ProductType;
  validity: Validity;
  status: "PENDING" | "QUEUED" | "FILLED" | "CANCELLED" | "REJECTED" | "EXPIRED";
  filledPrice?: number;
  filledAt?: string;
  rejectReason?: string;
  strategyTag?: string;
  createdAt: string;
}

export interface PaperTrade {
  _id: string;
  accountId: string;
  symbol: string;
  direction: Direction;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  holdDurationMins: number;
  grossPnl: number;
  brokerage: number;
  netPnl: number;
  pnlPct: number;
  rMultiple?: number;
  exitReason: string;
  productType: ProductType;
  maxAdverseExcursion?: number;
  maxFavorableExcursion?: number;
  strategyTag?: string;
  preTradePlan?: string;
  mistake?: string;
  lesson?: string;
  notes?: string;
  executionStars?: number;
  emotionTagEntry?: string;
  emotionTagExit?: string;
  qualityTag?: string;
  setupType?: string;
  screenshot?: string;
  entrySignal?: Record<string, unknown>;
}

export interface PriceQuote {
  symbol: string;
  price: number;
  ts: number;
  source: string;
  delayed: boolean;
}

export interface MarketStatusResp {
  state: "OPEN" | "PRE_OPEN" | "CLOSED";
  istNow: string;
  istDate: string;
  minutesToOpen?: number;
  minutesToClose?: number;
  isHoliday: boolean;
  isWeekend: boolean;
  nextOpenIso?: string;
}

export interface OrderPreview {
  symbol: string;
  ltp?: number;
  estimatedFill: number;
  marginRequired: number;
  entryCharges: number;
  maxLoss?: number;
  potentialGain?: number;
  rr?: number;
  quality: "GOOD" | "OK" | "POOR" | "MISSING";
  priceSource: string;
  priceDelayed: boolean;
  marketStatus: "OPEN" | "PRE_OPEN" | "CLOSED";
}

export interface Badge {
  id: string;
  icon: string;
  label: string;
  description: string;
  earned: boolean;
  progress?: string;
}

export interface AnalyticsBundle {
  summary: {
    startingCapital: number;
    currentEquity: number;
    totalPnl: number;
    totalPnlPct: number;
    winRate: number;
    profitFactor: number;
    totalTrades: number;
    avgWin: number;
    avgLoss: number;
    payoffRatio: number;
    expectancy: number;
  };
  equityCurve: { date: string; equity: number; tradePnl: number }[];
  dailyPnl: { date: string; pnl: number }[];
  drawdown: { series: { equity: number; ddPct: number }[]; maxDrawdownPct: number };
  distribution: { bins: { from: number; to: number; count: number }[]; min: number; max: number };
  bySymbol: { symbol: string; trades: number; pnl: number; winRate: number }[];
  byHour: { hour: number; trades: number; pnl: number; winRate: number }[];
  byWeekday: { weekday: string; trades: number; pnl: number; winRate: number }[];
  byStrategy: { strategy: string; trades: number; pnl: number; winRate: number; avgWin: number; avgLoss: number; profitFactor: number }[];
  advanced: { sharpe: number; sortino: number; calmar: number; sqn: number; kelly: number; recoveryFactor: number };
  streaks: { maxWinStreak: number; maxLossStreak: number };
  behavior: { avgHoldMinsWin: number; avgHoldMinsLoss: number; overtradingDays: number; revengeTrades: number };
}

// ─── helpers ─────────────────────────────────────────────────────────

export const paperApi = {
  listAccounts: () => api.get<{ accounts: PaperAccount[] }>("/api/paper/accounts").then((r) => r.data),
  createAccount: (name: string, startingCapital: number) =>
    api.post<{ account: PaperAccount }>("/api/paper/accounts", { name, startingCapital }).then((r) => r.data),
  activateAccount: (id: string) =>
    api.patch<{ account: PaperAccount }>(`/api/paper/accounts/${id}/activate`).then((r) => r.data),
  resetAccount: (id: string) =>
    api.post<{ account: PaperAccount }>(`/api/paper/accounts/${id}/reset`).then((r) => r.data),

  portfolio: (accountId?: string) =>
    api.get<{ portfolio: Portfolio }>("/api/paper/portfolio", { params: { accountId } }).then((r) => r.data.portfolio),

  marketStatus: () => api.get<MarketStatusResp>("/api/paper/market-status").then((r) => r.data),
  price: (symbol: string) => api.get<PriceQuote>(`/api/paper/price/${symbol}`).then((r) => r.data),

  placeOrder: (input: {
    accountId?: string;
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
    validity?: Validity;
    strategyTag?: string;
    acceptQueue?: boolean;
  }) => api.post<{ orderId: string; status: string; filledPrice?: number; positionId?: string; queued?: boolean }>("/api/paper/orders", input).then((r) => r.data),
  previewOrder: (input: {
    symbol: string;
    side: Side;
    orderType: OrderType;
    qty: number;
    limitPrice?: number;
    triggerPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    productType?: ProductType;
  }) => api.post<{ preview: OrderPreview }>("/api/paper/orders/preview", input).then((r) => r.data.preview),
  listOrders: (accountId?: string, status?: string) =>
    api.get<{ orders: PaperOrder[] }>("/api/paper/orders", { params: { accountId, status } }).then((r) => r.data.orders),
  modifyOrder: (id: string, patch: Partial<Pick<PaperOrder, "qty" | "limitPrice" | "triggerPrice" | "stopLoss" | "takeProfit" | "trailingStopPct">>) =>
    api.patch<{ order: PaperOrder }>(`/api/paper/orders/${id}`, patch).then((r) => r.data.order),
  cancelOrder: (id: string) =>
    api.delete<{ order: PaperOrder }>(`/api/paper/orders/${id}`).then((r) => r.data.order),

  listPositions: (accountId?: string) =>
    api.get<{ positions: PaperPosition[] }>("/api/paper/positions", { params: { accountId } }).then((r) => r.data.positions),
  closePosition: (id: string, qty?: number) =>
    api.post<{ tradeId: string; netPnl: number; exitPrice: number; isPartial: boolean }>(`/api/paper/positions/${id}/close`, { qty, exitReason: qty ? "PARTIAL_MANUAL" : "MANUAL" }).then((r) => r.data),
  modifyPosition: (id: string, patch: { stopLoss?: number | null; takeProfit?: number | null; trailingStopPct?: number | null; notes?: string; strategyTag?: string }) =>
    api.patch<{ position: PaperPosition }>(`/api/paper/positions/${id}`, patch).then((r) => r.data.position),

  listTrades: (params: { accountId?: string; page?: number; limit?: number; symbol?: string; direction?: Direction; result?: "WIN" | "LOSS"; strategy?: string; since?: string; until?: string }) =>
    api.get<{ trades: PaperTrade[]; total: number; page: number; limit: number }>("/api/paper/trades", { params }).then((r) => r.data),
  updateTradeJournal: (id: string, patch: Partial<Pick<PaperTrade, "preTradePlan" | "mistake" | "lesson" | "notes" | "executionStars" | "emotionTagEntry" | "emotionTagExit" | "qualityTag" | "setupType" | "screenshot">>) =>
    api.patch<{ trade: PaperTrade }>(`/api/paper/trades/${id}`, patch).then((r) => r.data.trade),

  analytics: (accountId?: string) =>
    api.get<AnalyticsBundle>("/api/paper/analytics", { params: { accountId } }).then((r) => r.data),
  achievements: (accountId?: string) =>
    api.get<{ badges: Badge[] }>("/api/paper/achievements", { params: { accountId } }).then((r) => r.data.badges),
  vsBacktest: (accountId?: string) =>
    api.get<{ paper: { totalPnl: number; winRate: number; trades: number; avgHoldMins: number } }>("/api/paper/vs-backtest", { params: { accountId } }).then((r) => r.data),

  weeklyReview: (accountId?: string) =>
    api.get<{
      weekEnding: string;
      trades: number; wins: number; losses: number; winRate: number;
      netPnl: number;
      bestTrade: { symbol: string; netPnl: number } | null;
      worstTrade: { symbol: string; netPnl: number } | null;
      topSymbols: Array<{ symbol: string; pnl: number; trades: number }>;
      template: string;
    }>("/api/paper/weekly-review", { params: { accountId } }).then((r) => r.data),

  tradeReview: (tradeId: string) =>
    api.get<{ review: { headline: string; bullets: string[]; score: string; byAi: boolean } }>(`/api/paper/trades/${tradeId}/review`).then((r) => r.data.review),

  leaderboard: (since?: string, limit = 50) =>
    api.get<{ rows: Array<{ rank: number; userId: string; displayName: string; accountName: string; netPnl: number; returnPct: number; trades: number; winRate: number; maxDrawdownPct: number; isYou?: boolean }>; since: string; limit: number }>(
      "/api/paper/leaderboard", { params: { since, limit } }
    ).then((r) => r.data),

  exportTradesCsv: (fy?: string, accountId?: string) =>
    api.get<string>("/api/paper/trades/export.csv", { params: { fy, accountId }, responseType: "text" }).then((r) => r.data),
};

// Backtest API (re-used for the paper-vs-backtest comparison). Matches
// the existing POST /api/backtest contract (see routes/backtest.ts).
export const backtestApi = {
  run: (params: { symbol: string; capital?: number; riskPerTradePct?: number; minConfidence?: number; bars?: number; warmup?: number }) =>
    api.post<{ summary?: Record<string, number>; trades?: unknown[] }>("/api/backtest", params).then((r) => r.data),
};
