// Zerodha Kite Connect adapter — direct REST integration over axios so we
// don't pin a specific kiteconnect npm version. The HTTP surface here is
// the official Kite Connect v3 contract:
//   https://kite.trade/docs/connect/v3/
//
// Token lifecycle:
//   1. User clicks "Connect Kite" in Settings → redirected to
//      https://kite.zerodha.com/connect/login?v=3&api_key=...
//   2. Kite redirects back to KITE_REDIRECT_URI with ?request_token=xxx
//   3. The frontend posts the request_token to /api/broker/auth
//   4. We POST to /session/token with checksum = sha256(api_key + request_token + api_secret)
//   5. The returned access_token is cached in-process (and optionally
//      mirrored to env) and used as the "token" header for all calls.
//
// Access tokens are valid until ~6am IST next day, so they MUST be
// re-issued daily via re-auth (Kite does not allow token refresh).

import axios, { type AxiosInstance, AxiosError } from "axios";
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type {
  IBrokerAdapter,
  PlaceOrderRequest,
  PlaceOrderResult,
  BrokerStatus,
  BrokerOrder,
  BrokerPosition,
  BrokerHolding,
  BrokerMargins,
} from "./IBrokerAdapter.js";

const BASE_URL = "https://api.kite.trade";

// Map QTI internal symbols → Kite tradingsymbol + exchange. For NSE
// equities the convention is tradingsymbol=SYMBOL, exchange=NSE.
function toKiteSymbol(qtiSymbol: string): { tradingsymbol: string; exchange: string } {
  const sym = qtiSymbol.replace(/\.NS$/i, "").toUpperCase();
  return { tradingsymbol: sym, exchange: "NSE" };
}

// Map our OrderType → Kite order_type. Kite uses: MARKET / LIMIT / SL / SL-M
function toKiteOrderType(t: PlaceOrderRequest["orderType"]): string {
  switch (t) {
    case "MARKET": return "MARKET";
    case "LIMIT": return "LIMIT";
    case "SL_MARKET": return "SL-M";
    case "SL_LIMIT": return "SL";
  }
}

// Translate Kite error codes to friendlier internal messages so the UI
// can surface something actionable instead of leaking provider jargon.
function mapKiteError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = (err as AxiosError<{ message?: string; error_type?: string }>).response?.data;
    const errType = data?.error_type;
    const msg = data?.message ?? err.message;
    switch (errType) {
      case "TokenException": return "Kite session expired. Please re-authenticate from Settings.";
      case "InputException": return `Kite rejected request: ${msg}`;
      case "OrderException": return `Order rejected: ${msg}`;
      case "NetworkException": return "Kite reachability issue. Try again.";
      case "PermissionException": return "Kite permission denied. Check API key scope.";
      case "GeneralException":
      default: return msg || "Unknown Kite error";
    }
  }
  return (err as Error).message ?? "Unknown error";
}

class KiteAdapter implements IBrokerAdapter {
  readonly mode = "kite" as const;
  private accessToken: string | null = null;
  private client: AxiosInstance;
  private cachedStatus: BrokerStatus = { mode: "kite", connected: false };
  private cachedMargins: BrokerMargins | null = null;

  constructor() {
    // Bootstrap from env if a token was already provisioned out-of-band.
    if (env.kiteAccessToken) this.accessToken = env.kiteAccessToken;
    this.client = axios.create({ baseURL: BASE_URL, timeout: 15_000 });
    this.client.interceptors.request.use((config) => {
      config.headers = config.headers ?? {};
      (config.headers as Record<string, string>)["X-Kite-Version"] = "3";
      if (env.kiteApiKey && this.accessToken) {
        (config.headers as Record<string, string>)["Authorization"] =
          `token ${env.kiteApiKey}:${this.accessToken}`;
      }
      return config;
    });
  }

  async status(): Promise<BrokerStatus> {
    if (!env.kiteApiKey) {
      this.cachedStatus = { mode: "kite", connected: false, lastError: "KITE_API_KEY not configured" };
      return this.cachedStatus;
    }
    if (!this.accessToken) {
      this.cachedStatus = { mode: "kite", connected: false, lastError: "Not authenticated. Click Connect Kite in Settings." };
      return this.cachedStatus;
    }
    try {
      const res = await this.client.get("/user/profile");
      const userIdHint = (res.data?.data?.user_id as string | undefined) ?? undefined;
      this.cachedStatus = {
        mode: "kite",
        connected: true,
        userIdHint,
        marginsCached: this.cachedMargins ?? undefined,
      };
      return this.cachedStatus;
    } catch (err) {
      this.cachedStatus = { mode: "kite", connected: false, lastError: mapKiteError(err) };
      return this.cachedStatus;
    }
  }

  async authenticate(payload?: Record<string, string>): Promise<BrokerStatus> {
    if (!env.kiteApiKey || !env.kiteApiSecret) {
      this.cachedStatus = { mode: "kite", connected: false, lastError: "KITE_API_KEY/KITE_API_SECRET missing" };
      return this.cachedStatus;
    }
    const requestToken = payload?.request_token ?? payload?.requestToken;
    if (!requestToken) {
      this.cachedStatus = { mode: "kite", connected: false, lastError: "Missing request_token" };
      return this.cachedStatus;
    }
    const checksum = crypto
      .createHash("sha256")
      .update(`${env.kiteApiKey}${requestToken}${env.kiteApiSecret}`)
      .digest("hex");
    try {
      const res = await axios.post(
        `${BASE_URL}/session/token`,
        new URLSearchParams({
          api_key: env.kiteApiKey,
          request_token: requestToken,
          checksum,
        }).toString(),
        {
          headers: {
            "X-Kite-Version": "3",
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      const token = res.data?.data?.access_token as string | undefined;
      if (!token) throw new Error("Kite did not return an access_token");
      this.accessToken = token;
      logger.info("Kite session established", { userIdHint: res.data?.data?.user_id });
      return this.status();
    } catch (err) {
      const msg = mapKiteError(err);
      this.cachedStatus = { mode: "kite", connected: false, lastError: msg };
      return this.cachedStatus;
    }
  }

  async logout(): Promise<void> {
    if (!this.accessToken || !env.kiteApiKey) {
      this.accessToken = null;
      return;
    }
    try {
      await this.client.delete("/session/token", {
        params: { api_key: env.kiteApiKey, access_token: this.accessToken },
      });
    } catch (err) {
      logger.warn("Kite logout call failed (clearing local token anyway)", {
        err: mapKiteError(err),
      });
    } finally {
      this.accessToken = null;
      this.cachedStatus = { mode: "kite", connected: false };
    }
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    if (!this.accessToken) return { brokerOrderId: "", status: "REJECTED", message: "Kite not authenticated" };
    const { tradingsymbol, exchange } = toKiteSymbol(req.symbol);
    const body = new URLSearchParams();
    body.append("tradingsymbol", tradingsymbol);
    body.append("exchange", exchange);
    body.append("transaction_type", req.side);
    body.append("order_type", toKiteOrderType(req.orderType));
    body.append("quantity", String(req.qty));
    body.append("product", req.productType ?? "MIS");
    body.append("validity", "DAY");
    if (req.limitPrice != null) body.append("price", String(req.limitPrice));
    if (req.triggerPrice != null) body.append("trigger_price", String(req.triggerPrice));
    if (req.tag) body.append("tag", req.tag.slice(0, 20));
    try {
      const res = await this.client.post("/orders/regular", body.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const orderId = res.data?.data?.order_id as string;
      return { brokerOrderId: orderId, status: "PENDING" };
    } catch (err) {
      return { brokerOrderId: "", status: "REJECTED", message: mapKiteError(err) };
    }
  }

  async cancelOrder(_userId: string, brokerOrderId: string) {
    if (!this.accessToken) return { ok: false, message: "Kite not authenticated" };
    try {
      await this.client.delete(`/orders/regular/${encodeURIComponent(brokerOrderId)}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: mapKiteError(err) };
    }
  }

  async getOrders(_userId: string): Promise<BrokerOrder[]> {
    if (!this.accessToken) return [];
    try {
      const res = await this.client.get("/orders");
      const raw = (res.data?.data ?? []) as Array<Record<string, unknown>>;
      return raw.map((o) => ({
        brokerOrderId: String(o.order_id ?? ""),
        symbol: String(o.tradingsymbol ?? ""),
        side: (o.transaction_type as "BUY" | "SELL") ?? "BUY",
        orderType: ((o.order_type as string) === "LIMIT" ? "LIMIT" : "MARKET") as "LIMIT" | "MARKET",
        qty: Number(o.quantity ?? 0),
        filledQty: Number(o.filled_quantity ?? 0),
        status: String(o.status ?? ""),
        avgPrice: Number(o.average_price ?? 0) || undefined,
        placedAt: String(o.order_timestamp ?? new Date().toISOString()),
      }));
    } catch (err) {
      logger.warn("Kite getOrders failed", { err: mapKiteError(err) });
      return [];
    }
  }

  async getPositions(_userId: string): Promise<BrokerPosition[]> {
    if (!this.accessToken) return [];
    try {
      const res = await this.client.get("/portfolio/positions");
      const raw = (res.data?.data?.net ?? []) as Array<Record<string, unknown>>;
      return raw.map((p) => ({
        symbol: String(p.tradingsymbol ?? ""),
        qty: Number(p.quantity ?? 0),
        avgPrice: Number(p.average_price ?? 0),
        ltp: Number(p.last_price ?? 0) || undefined,
        pnl: Number(p.pnl ?? 0) || undefined,
        product: (p.product as "MIS" | "CNC" | "NRML" | undefined) ?? undefined,
      }));
    } catch (err) {
      logger.warn("Kite getPositions failed", { err: mapKiteError(err) });
      return [];
    }
  }

  async getHoldings(_userId: string): Promise<BrokerHolding[]> {
    if (!this.accessToken) return [];
    try {
      const res = await this.client.get("/portfolio/holdings");
      const raw = (res.data?.data ?? []) as Array<Record<string, unknown>>;
      return raw.map((h) => ({
        symbol: String(h.tradingsymbol ?? ""),
        qty: Number(h.quantity ?? 0),
        avgPrice: Number(h.average_price ?? 0),
        ltp: Number(h.last_price ?? 0) || undefined,
        pnl: Number(h.pnl ?? 0) || undefined,
      }));
    } catch (err) {
      logger.warn("Kite getHoldings failed", { err: mapKiteError(err) });
      return [];
    }
  }

  async getMargins(_userId: string): Promise<BrokerMargins> {
    if (!this.accessToken) return { available: 0, used: 0, net: 0, currency: "INR" };
    try {
      const res = await this.client.get("/user/margins/equity");
      const data = res.data?.data ?? {};
      const margins: BrokerMargins = {
        available: Number(data?.available?.cash ?? 0),
        used: Number(data?.utilised?.debits ?? 0),
        net: Number(data?.net ?? 0),
        currency: "INR",
      };
      this.cachedMargins = margins;
      return margins;
    } catch (err) {
      logger.warn("Kite getMargins failed", { err: mapKiteError(err) });
      return { available: 0, used: 0, net: 0, currency: "INR" };
    }
  }

  /** Kite login URL — used by Settings page to redirect the user. */
  loginUrl(): string {
    if (!env.kiteApiKey) return "";
    const params = new URLSearchParams({ v: "3", api_key: env.kiteApiKey });
    return `https://kite.zerodha.com/connect/login?${params.toString()}`;
  }

  /** Validate the SHA-256 checksum Kite sends with every postback
   * (= sha256(order_id + api_secret)). Returns false when not in kite
   * mode or when the secret is missing so we fail closed. */
  verifyPostbackChecksum(orderId: string, checksum: string): boolean {
    if (!env.kiteApiSecret || !orderId || !checksum) return false;
    const expected = crypto
      .createHash("sha256")
      .update(`${orderId}${env.kiteApiSecret}`)
      .digest("hex");
    return timingSafeEqualHex(expected, checksum);
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export const kiteAdapter = new KiteAdapter();
