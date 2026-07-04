import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { SymbolPicker } from "../SymbolSearchInput";
import {
  paperApi,
  type OrderType,
  type Side,
  type ProductType,
  type OrderPreview,
  type PriceQuote,
  type Portfolio,
} from "../../lib/paperApi";
import { paperSounds } from "../../lib/paperSounds";

interface Props {
  symbol: string;
  setSymbol: (s: string) => void;
  portfolio: Portfolio | null;
  universe: string[];
  onPlaced: (msg: string) => void;
  prefill?: {
    side?: Side;
    qty?: number;
    stopLoss?: number;
    takeProfit?: number;
    strategyTag?: string;
  } | null;
  onPrefillConsumed?: () => void;
}

const PRODUCT_LABELS: Record<ProductType, string> = {
  MIS: "Intraday (MIS)",
  CNC: "Delivery (CNC)",
};

export default function OrderTerminal({
  symbol,
  setSymbol,
  portfolio,
  universe,
  onPlaced,
  prefill,
  onPrefillConsumed,
}: Props) {
  const [side, setSide] = useState<Side>("BUY");
  const [orderType, setOrderType] = useState<OrderType>("MARKET");
  const [qty, setQty] = useState<number>(10);
  const [limitPrice, setLimitPrice] = useState<string>("");
  const [triggerPrice, setTriggerPrice] = useState<string>("");
  const [stopLoss, setStopLoss] = useState<string>("");
  const [takeProfit, setTakeProfit] = useState<string>("");
  const [trailingPct, setTrailingPct] = useState<string>("");
  const [productType, setProductType] = useState<ProductType>("MIS");
  const [strategyTag, setStrategyTag] = useState<string>("");

  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Apply prefill (e.g. from AI signal one-click).
  useEffect(() => {
    if (!prefill) return;
    if (prefill.side) setSide(prefill.side);
    if (prefill.qty) setQty(prefill.qty);
    if (prefill.stopLoss != null) setStopLoss(String(prefill.stopLoss));
    if (prefill.takeProfit != null) setTakeProfit(String(prefill.takeProfit));
    if (prefill.strategyTag) setStrategyTag(prefill.strategyTag);
    onPrefillConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // LTP polling — every 15s for the current symbol.
  useEffect(() => {
    let cancelled = false;
    const fetch = () =>
      paperApi.price(symbol).then((q) => !cancelled && setQuote(q)).catch(() => {});
    fetch();
    const id = setInterval(fetch, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  // Debounced order preview.
  const previewTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(async () => {
      try {
        setErr(null);
        const p = await paperApi.previewOrder({
          symbol,
          side,
          orderType,
          qty,
          limitPrice: orderType === "LIMIT" || orderType === "SL_LIMIT" ? num(limitPrice) : undefined,
          triggerPrice: orderType === "SL_MARKET" || orderType === "SL_LIMIT" ? num(triggerPrice) : undefined,
          stopLoss: num(stopLoss),
          takeProfit: num(takeProfit),
          productType,
        });
        setPreview(p);
      } catch (e) {
        const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setErr(msg ?? "Unable to preview order");
        setPreview(null);
      }
    }, 250);
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    };
  }, [symbol, side, orderType, qty, limitPrice, triggerPrice, stopLoss, takeProfit, productType]);

  // Keyboard shortcuts — only when terminal is focused / form area hovered.
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "b" || e.key === "B") setSide("BUY");
      else if (e.key === "s" || e.key === "S") setSide("SELL");
      else if (e.key === "m" || e.key === "M") setOrderType("MARKET");
      else if (e.key === "l" || e.key === "L") setOrderType("LIMIT");
      else if (e.key === "Escape") setConfirmOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function applyQtyPct(pct: number) {
    if (!portfolio || !quote || !quote.price) return;
    const target = portfolio.cash * (pct / 100);
    const q = Math.max(1, Math.floor(target / quote.price));
    setQty(q);
  }

  function applyAtrSl() {
    // Approximate: use 1% of price as default SL distance (real ATR would
    // require fetching indicators — keep this fast/cheap).
    if (!quote) return;
    const distance = quote.price * 0.01;
    if (side === "BUY") setStopLoss((quote.price - distance).toFixed(2));
    else setStopLoss((quote.price + distance).toFixed(2));
  }

  function applyRMult(mult: number) {
    if (!quote) return;
    const sl = num(stopLoss);
    if (sl == null) return;
    const stopDist = Math.abs(quote.price - sl);
    if (side === "BUY") setTakeProfit((quote.price + mult * stopDist).toFixed(2));
    else setTakeProfit((quote.price - mult * stopDist).toFixed(2));
  }

  const directionLabel = side === "BUY" ? "LONG" : "SHORT";

  async function placeOrder() {
    setPlacing(true);
    setErr(null);
    try {
      const result = await paperApi.placeOrder({
        symbol,
        side,
        orderType,
        qty,
        limitPrice: orderType === "LIMIT" || orderType === "SL_LIMIT" ? num(limitPrice) : undefined,
        triggerPrice: orderType === "SL_MARKET" || orderType === "SL_LIMIT" ? num(triggerPrice) : undefined,
        stopLoss: num(stopLoss),
        takeProfit: num(takeProfit),
        trailingStopPct: num(trailingPct),
        productType,
        strategyTag: strategyTag || undefined,
        acceptQueue: true,
      });
      setConfirmOpen(false);
      if (result.status === "FILLED") paperSounds.filled();
      else paperSounds.placed();
      onPlaced(
        result.status === "FILLED"
          ? `${side} ${qty} ${symbol} filled @ ₹${result.filledPrice?.toFixed(2)}`
          : result.queued
          ? `${side} ${qty} ${symbol} queued for next market open`
          : `${orderType} order placed for ${qty} ${symbol}`
      );
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Order failed";
      setErr(msg);
    } finally {
      setPlacing(false);
    }
  }

  const buyTabActive = side === "BUY";
  const qualityColor =
    preview?.quality === "GOOD"
      ? "text-emerald-400"
      : preview?.quality === "OK"
      ? "text-amber-400"
      : preview?.quality === "POOR"
      ? "text-rose-400"
      : "text-slate-500";

  return (
    <div ref={formRef} className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-3 space-y-3">
      {/* Header with help toggle */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Order Terminal</div>
        <details className="text-[10px]">
          <summary className="text-slate-400 hover:text-white cursor-pointer">help</summary>
          <div className="absolute z-30 right-2 mt-1 w-72 bg-bg-panel-solid border border-bg-border rounded p-3 shadow-glass space-y-2 text-slate-300">
            <div><b className="text-white">LONG (B)</b> = buy now to sell later. <b className="text-white">SHORT (S)</b> = sell now to buy back later (intraday).</div>
            <div><b className="text-white">MARKET</b> fills immediately at current LTP. <b className="text-white">LIMIT</b> only fills if price reaches your number. <b className="text-white">SL-MARKET</b> triggers a market order when trigger is touched. <b className="text-white">SL-LIMIT</b> = both, finest control.</div>
            <div><b className="text-white">MIS</b> = intraday (auto squared-off at 3:25 PM IST). <b className="text-white">CNC</b> = delivery (held overnight).</div>
            <div><b className="text-white">SL</b> caps your loss; <b className="text-white">TP</b> locks in profit. Trailing % moves the stop with you on every new favourable bar.</div>
            <div className="text-[10px] text-slate-500">Keyboard: B/S toggle dir · M/L order type · Esc cancel modal</div>
          </div>
        </details>
      </div>

      {/* Symbol + LTP */}
      <div className="flex items-center gap-2">
        <SymbolPicker value={symbol} onSelect={setSymbol} className="flex-1" placeholder="Search any stock…" />
        <div className="text-right">
          <div className="text-xs text-slate-500">LTP</div>
          <div className="text-base font-mono text-white">{quote ? `₹${quote.price.toFixed(2)}` : "—"}</div>
        </div>
      </div>
      {quote?.source !== "YFINANCE" && quote?.source !== "yfinance" && quote?.source && (
        <div className="text-[10px] text-amber-400/80">Price source: {quote.source}{quote.delayed ? " (delayed)" : ""}</div>
      )}

      {/* LONG / SHORT toggle */}
      <div className="grid grid-cols-2 rounded-md overflow-hidden border border-bg-border">
        <button
          onClick={() => setSide("BUY")}
          className={clsx("py-2 text-sm font-semibold transition-colors", buyTabActive ? "bg-accent-buy text-bg" : "bg-bg-elevated/40 text-slate-400 hover:text-white")}
        >
          LONG (B)
        </button>
        <button
          onClick={() => setSide("SELL")}
          className={clsx("py-2 text-sm font-semibold transition-colors", !buyTabActive ? "bg-accent-sell text-white" : "bg-bg-elevated/40 text-slate-400 hover:text-white")}
        >
          SHORT (S)
        </button>
      </div>

      {/* Order type */}
      <div className="grid grid-cols-4 gap-1">
        {(["MARKET", "LIMIT", "SL_MARKET", "SL_LIMIT"] as OrderType[]).map((t) => (
          <button
            key={t}
            onClick={() => setOrderType(t)}
            className={clsx(
              "text-[11px] py-1.5 rounded border",
              orderType === t ? "bg-accent-info/20 border-accent-info text-white" : "bg-bg-elevated/40 border-bg-border text-slate-400 hover:text-white"
            )}
          >
            {t.replace("_", "-")}
          </button>
        ))}
      </div>

      {/* Qty + price */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase text-slate-500">Quantity</label>
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
            className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm text-white font-mono"
          />
          <div className="flex gap-1 mt-1">
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                onClick={() => applyQtyPct(p)}
                className="flex-1 text-[10px] py-1 bg-bg-elevated/60 hover:bg-bg-elevated text-slate-400 hover:text-white rounded"
              >
                {p === 100 ? "MAX" : `${p}%`}
              </button>
            ))}
          </div>
        </div>
        <div>
          {(orderType === "LIMIT" || orderType === "SL_LIMIT") && (
            <>
              <label className="text-[10px] uppercase text-slate-500">Limit Price</label>
              <input
                type="number"
                step="0.05"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm text-white font-mono"
              />
            </>
          )}
          {(orderType === "SL_MARKET" || orderType === "SL_LIMIT") && (
            <>
              <label className="text-[10px] uppercase text-slate-500 mt-1 block">Trigger Price</label>
              <input
                type="number"
                step="0.05"
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm text-white font-mono"
              />
            </>
          )}
          {orderType === "MARKET" && quote && (
            <>
              <label className="text-[10px] uppercase text-slate-500">Estimated Fill</label>
              <div className="bg-bg-elevated/40 border border-bg-border rounded px-2 py-1.5 text-sm text-slate-300 font-mono">
                ≈ ₹{preview?.estimatedFill?.toFixed(2) ?? "—"}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Product type */}
      <div>
        <label className="text-[10px] uppercase text-slate-500">Product</label>
        <div className="grid grid-cols-2 gap-1">
          {(Object.keys(PRODUCT_LABELS) as ProductType[]).map((p) => (
            <button
              key={p}
              onClick={() => setProductType(p)}
              className={clsx(
                "text-[11px] py-1.5 rounded border",
                productType === p ? "bg-accent-info/20 border-accent-info text-white" : "bg-bg-elevated/40 border-bg-border text-slate-400 hover:text-white"
              )}
            >
              {PRODUCT_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* SL / TP */}
      <details className="rounded border border-bg-border" open>
        <summary className="px-2 py-1.5 text-[10px] uppercase text-slate-500 cursor-pointer">Risk Management</summary>
        <div className="px-2 pb-2 pt-1 space-y-2">
          <div>
            <label className="text-[10px] text-slate-500">Stop Loss</label>
            <div className="flex gap-1">
              <input
                type="number"
                step="0.05"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                className="flex-1 bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-white font-mono"
              />
              <button onClick={applyAtrSl} className="text-[10px] px-2 bg-bg-elevated/60 hover:bg-bg-elevated text-slate-300 rounded">
                1%
              </button>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-slate-500">Take Profit</label>
            <div className="flex gap-1">
              <input
                type="number"
                step="0.05"
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value)}
                className="flex-1 bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-white font-mono"
              />
              {[1, 2, 3].map((m) => (
                <button key={m} onClick={() => applyRMult(m)} className="text-[10px] px-2 bg-bg-elevated/60 hover:bg-bg-elevated text-slate-300 rounded">
                  {m}R
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] text-slate-500">Trailing SL %</label>
            <input
              type="number"
              step="0.1"
              placeholder="off"
              value={trailingPct}
              onChange={(e) => setTrailingPct(e.target.value)}
              className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-white font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-slate-500">Strategy Tag</label>
            <input
              value={strategyTag}
              onChange={(e) => setStrategyTag(e.target.value)}
              placeholder="trend / breakout / ai-signal …"
              className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-white"
            />
          </div>
        </div>
      </details>

      {/* Preview block */}
      <div className="bg-bg-elevated/40 border border-bg-border rounded p-2 text-xs font-mono space-y-1">
        <Row label="Margin Required" value={preview ? `₹${preview.marginRequired.toLocaleString("en-IN")}` : "—"} />
        <Row label="Est. Charges (entry)" value={preview ? `₹${preview.entryCharges.toFixed(2)}` : "—"} />
        <Row label="Max Loss" value={preview?.maxLoss != null ? `₹${preview.maxLoss.toLocaleString("en-IN")}` : "set SL"} />
        <Row label="Potential Gain" value={preview?.potentialGain != null ? `₹${preview.potentialGain.toLocaleString("en-IN")}` : "set TP"} />
        <Row label="R:R" value={preview?.rr != null ? `1 : ${preview.rr.toFixed(2)}` : "—"} />
        <Row label="Quality" value={preview?.quality ?? "MISSING"} valueClass={qualityColor} />
      </div>

      {err && <div className="text-xs text-rose-400">{err}</div>}

      <button
        onClick={() => setConfirmOpen(true)}
        disabled={!preview || placing}
        className={clsx(
          "w-full py-2.5 rounded font-semibold text-sm transition-colors",
          buyTabActive
            ? "bg-accent-buy hover:bg-emerald-500 text-bg"
            : "bg-accent-sell hover:bg-rose-500 text-white",
          (!preview || placing) && "opacity-50 cursor-not-allowed"
        )}
      >
        {placing ? "Placing…" : `Place Paper ${directionLabel} Order`}
      </button>

      {confirmOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 grid place-items-center" onClick={() => setConfirmOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-bg-panel-solid border border-bg-border rounded-xl p-5 w-[420px] shadow-glass"
          >
            <div className="text-xs uppercase text-slate-500 mb-2">Confirm Paper Order</div>
            <div className="text-lg text-white font-mono">
              {side === "BUY" ? "BUY" : "SELL"} {qty} {symbol} <span className="text-slate-400">@ {orderType}</span>
            </div>
            {preview && (
              <div className="mt-3 space-y-1 text-sm font-mono">
                <Row label="Est. Fill" value={`₹${preview.estimatedFill.toFixed(2)}`} />
                <Row label="Margin" value={`₹${preview.marginRequired.toLocaleString("en-IN")}`} />
                {num(stopLoss) != null && <Row label="Stop Loss" value={`₹${num(stopLoss)?.toFixed(2)}`} />}
                {num(takeProfit) != null && <Row label="Take Profit" value={`₹${num(takeProfit)?.toFixed(2)}`} />}
                {preview.maxLoss != null && <Row label="Max Loss" value={`-₹${preview.maxLoss.toLocaleString("en-IN")}`} valueClass="text-rose-400" />}
                {preview.potentialGain != null && (
                  <Row label="Potential Gain" value={`+₹${preview.potentialGain.toLocaleString("en-IN")}`} valueClass="text-accent-buy" />
                )}
              </div>
            )}
            <div className="flex gap-2 mt-5">
              <button
                onClick={placeOrder}
                disabled={placing}
                className="flex-1 bg-accent-info hover:bg-blue-500 text-white py-2 rounded font-semibold"
              >
                {placing ? "Placing…" : "Confirm & Place"}
              </button>
              <button onClick={() => setConfirmOpen(false)} className="text-slate-400 hover:text-white px-3">
                Cancel (Esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={clsx("text-white", valueClass)}>{value}</span>
    </div>
  );
}

function num(s: string): number | undefined {
  if (s == null || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
