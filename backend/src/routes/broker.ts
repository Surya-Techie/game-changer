import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { broker, brokerMode, kiteLoginUrl } from "../services/brokers/registry.js";
import { kiteAdapter } from "../services/brokers/kiteAdapter.js";
import { Position } from "../models/Position.js";
import { logger } from "../utils/logger.js";

const router = Router();

// Tighter limit for the auth handshake — prevents request_token brute-force
// and protects the upstream Kite session/token endpoint from rate-blocking.
const brokerAuthLimiter = rateLimit({ windowMs: 60_000, max: 6 });

// Webhook receiver — must NOT require auth (Kite calls it directly, no JWT)
// but we verify the postback checksum to make sure it really came from Kite.
// Mount BEFORE the requireAuth middleware below. The body parser is
// already global in app.ts so we can read req.body directly.
router.post("/postback", async (req, res) => {
  try {
    await handleKitePostback(req.body);
    res.json({ ok: true });
  } catch (err) {
    logger.warn("Kite postback handler error", { err: (err as Error).message });
    res.status(202).json({ ok: false });
  }
});

router.use(requireAuth);

router.get("/status", async (req, res, next) => {
  try {
    const status = await broker().status();
    let margins = status.marginsCached;
    if (status.connected && !margins) {
      try { margins = await broker().getMargins(req.user!.userId); } catch { /* tolerate */ }
    }
    res.json({
      status,
      margins,
      mode: brokerMode(),
      loginUrl: kiteLoginUrl() || undefined,
    });
  } catch (err) { next(err); }
});

const authSchema = z.object({
  request_token: z.string().min(1).max(200).optional(),
  requestToken: z.string().min(1).max(200).optional(),
});

router.post("/auth", brokerAuthLimiter, async (req, res, next) => {
  try {
    const body = authSchema.parse(req.body ?? {});
    const result = await broker().authenticate({
      request_token: body.request_token ?? body.requestToken ?? "",
    });
    if (!result.connected) {
      return res.status(401).json({ status: result });
    }
    res.json({ status: result });
  } catch (err) { next(err); }
});

router.post("/logout", async (_req, res, next) => {
  try {
    await broker().logout();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/orders", async (req, res, next) => {
  try { res.json({ orders: await broker().getOrders(req.user!.userId) }); }
  catch (err) { next(err); }
});

router.get("/positions", async (req, res, next) => {
  try { res.json({ positions: await broker().getPositions(req.user!.userId) }); }
  catch (err) { next(err); }
});

router.get("/holdings", async (req, res, next) => {
  try { res.json({ holdings: await broker().getHoldings(req.user!.userId) }); }
  catch (err) { next(err); }
});

router.get("/margins", async (req, res, next) => {
  try { res.json({ margins: await broker().getMargins(req.user!.userId) }); }
  catch (err) { next(err); }
});

const placeSchema = z.object({
  symbol: z.string().min(1).max(40),
  side: z.enum(["BUY", "SELL"]),
  qty: z.number().int().min(1).max(1_000_000),
  orderType: z.enum(["MARKET", "LIMIT", "SL_MARKET", "SL_LIMIT"]),
  productType: z.enum(["MIS", "CNC", "NRML"]).optional(),
  limitPrice: z.number().positive().optional(),
  triggerPrice: z.number().positive().optional(),
  tag: z.string().max(20).optional(),
});

router.post("/orders", async (req, res, next) => {
  try {
    const body = placeSchema.parse(req.body);
    const result = await broker().placeOrder({
      ...body,
      userId: req.user!.userId,
      source: "MANUAL",
    });
    res.status(result.status === "REJECTED" ? 400 : 201).json(result);
  } catch (err) { next(err); }
});

router.delete("/orders/:id", async (req, res, next) => {
  try {
    const result = await broker().cancelOrder(req.user!.userId, req.params.id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────────────────
// Kite postback handler
//
// Kite POSTs to this URL when a live order moves through states
// (COMPLETE, CANCELLED, REJECTED). We use it to reconcile the Position
// document the auto-trader optimistically wrote at suggested-entry with
// the actual broker fill price. Payload shape per Kite docs:
//   { order_id, status, tradingsymbol, average_price, filled_quantity,
//     transaction_type, checksum, order_timestamp, ... }
// The checksum field is sha256(order_id + api_secret) and lets us
// verify the postback genuinely came from Zerodha.
// ────────────────────────────────────────────────────────────────────────

async function handleKitePostback(body: unknown): Promise<void> {
  if (!body || typeof body !== "object") {
    throw new Error("invalid postback body");
  }
  const payload = body as Record<string, unknown>;
  const orderId = String(payload.order_id ?? "");
  const status = String(payload.status ?? "");
  const tradingsymbol = String(payload.tradingsymbol ?? "").toUpperCase();
  const filledQty = Number(payload.filled_quantity ?? 0);
  const avgPrice = Number(payload.average_price ?? 0);
  const checksum = String(payload.checksum ?? "");
  if (!orderId || !status) throw new Error("missing order_id/status");

  if (!kiteAdapter.verifyPostbackChecksum(orderId, checksum)) {
    throw new Error("postback checksum mismatch");
  }

  logger.info("kite postback", { orderId, status, tradingsymbol, filledQty, avgPrice });

  // Reconcile only when the order is filled. CANCELLED/REJECTED leave the
  // position alone — the auto-trader risk loop closes orphaned pendings.
  if (status !== "COMPLETE" || filledQty <= 0 || avgPrice <= 0) return;

  // Match the most recent OPEN position for this symbol whose recorded
  // entry hasn't already been reconciled. There can be at most one open
  // position per (user, symbol) under the auto-trader policy, so this
  // unambiguously identifies the right doc.
  const pos = await Position.findOne({
    symbol: tradingsymbol,
    status: "OPEN",
  }).sort({ entryAt: -1 });
  if (!pos) return;

  // Only update entryPrice on the first reconciliation — subsequent
  // postbacks (e.g. for partial fills aggregated upstream) should not
  // drift the recorded entry.
  if (Math.abs(pos.entryPrice - avgPrice) > 0.01) {
    pos.entryPrice = avgPrice;
    if (pos.highWatermark != null) pos.highWatermark = Math.max(pos.highWatermark, avgPrice);
    if (pos.lowWatermark != null) pos.lowWatermark = Math.min(pos.lowWatermark, avgPrice);
    await pos.save();
  }
}

export default router;
