// Broker abstraction so the auto-trader can target either the in-process
// mock (paperBroker / mockFeed) or a real broker (Zerodha Kite) behind
// the BROKER_MODE env flag. The mock implementation must produce the
// exact same behaviour as the previous direct paperBroker.submitMarket()
// call so that all existing tests, paper-trading flows, and dashboards
// remain unaffected when BROKER_MODE=mock.
//
// Every method returns plain JSON-safe values so adapters can be swapped
// without changes to callers. Adapters MUST NOT mutate Mongoose documents
// directly — they only execute orders and surface broker-side state.

export type OrderType = "MARKET" | "LIMIT" | "SL_MARKET" | "SL_LIMIT";
export type ProductType = "MIS" | "CNC" | "NRML";
export type OrderSide = "BUY" | "SELL";

export interface PlaceOrderRequest {
  userId: string;
  symbol: string;            // QTI symbol — adapters map to broker form (e.g. ".NS" suffix)
  side: OrderSide;
  qty: number;
  orderType: OrderType;
  productType?: ProductType;
  limitPrice?: number;
  triggerPrice?: number;
  tag?: string;              // 20-char user tag for the order
  source: "MANUAL" | "AUTO";
  sourceSignalId?: string;
}

export interface PlaceOrderResult {
  brokerOrderId: string;     // broker-side identifier (mock returns local id)
  status: "FILLED" | "PENDING" | "REJECTED";
  filledPrice?: number;
  filledQty?: number;
  message?: string;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;
  avgPrice: number;
  ltp?: number;
  pnl?: number;
  product?: ProductType;
}

export interface BrokerOrder {
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  qty: number;
  filledQty: number;
  status: string;
  avgPrice?: number;
  placedAt: string;
}

export interface BrokerHolding {
  symbol: string;
  qty: number;
  avgPrice: number;
  ltp?: number;
  pnl?: number;
}

export interface BrokerMargins {
  available: number;         // total free margin (₹)
  used: number;              // utilised (₹)
  net: number;               // equity - used
  currency: string;          // "INR"
}

export interface BrokerStatus {
  mode: "mock" | "kite";
  connected: boolean;
  lastError?: string;
  userIdHint?: string;       // anonymised broker user id, if any
  marginsCached?: BrokerMargins;
}

export interface IBrokerAdapter {
  readonly mode: "mock" | "kite";

  /** Returns connection health + cached margin if available. */
  status(): Promise<BrokerStatus>;

  /** Authenticate / refresh tokens. Mock adapter is always authed. */
  authenticate(payload?: Record<string, string>): Promise<BrokerStatus>;

  /** Sever the broker session (mock is a no-op). */
  logout(): Promise<void>;

  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
  cancelOrder(userId: string, brokerOrderId: string): Promise<{ ok: boolean; message?: string }>;

  getOrders(userId: string): Promise<BrokerOrder[]>;
  getPositions(userId: string): Promise<BrokerPosition[]>;
  getHoldings(userId: string): Promise<BrokerHolding[]>;
  getMargins(userId: string): Promise<BrokerMargins>;
}
