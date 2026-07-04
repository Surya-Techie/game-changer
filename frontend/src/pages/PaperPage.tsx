import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import PaperBanner from "../components/paper/PaperBanner";
import MarketStatusBar from "../components/paper/MarketStatusBar";
import AccountSelector from "../components/paper/AccountSelector";
import PortfolioBar from "../components/paper/PortfolioBar";
import OrderTerminal from "../components/paper/OrderTerminal";
import PositionsTable from "../components/paper/PositionsTable";
import PendingOrdersTable from "../components/paper/PendingOrdersTable";
import TradesTable from "../components/paper/TradesTable";
import { ToastStack, useToastQueue } from "../components/paper/Toast";
import {
  paperApi,
  type PaperAccount,
  type Portfolio,
  type PaperPosition,
  type PaperOrder,
  type PaperTrade,
} from "../lib/paperApi";
import { paperSounds, paperSoundEnabled, setPaperSoundEnabled } from "../lib/paperSounds";
import { useAuth } from "../store/auth";
import { useMarketSocket, type WsPatternSignalPayload } from "../lib/socket";

const UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL",
  "MARUTI", "KOTAKBANK", "BAJFINANCE", "HCLTECH", "WIPRO", "ASIANPAINT", "NESTLEIND", "TITAN", "ADANIENT", "SUNPHARMA",
];

type TabKey = "positions" | "pending" | "today" | "all";

export default function PaperPage() {
  const [params, setParams] = useSearchParams();
  const initialSymbol = (params.get("symbol") || "RELIANCE").toUpperCase();
  // Phase 11 — accept both ?side= and ?action= so the Scanner's "Paper Trade"
  // link (?action=BUY&entry=…&target=…&stop=…) works alongside the existing
  // ?side=BUY&qty=…&sl=…&tp=… contract.
  const prefillSide = ((params.get("side") || params.get("action") || "").toUpperCase()) as "BUY" | "SELL" | "";
  const prefillQty = Number(params.get("qty") || 0);
  const prefillSL = Number(params.get("sl") || params.get("stop") || 0);
  const prefillTP = Number(params.get("tp") || params.get("target") || 0);
  const prefillTag = params.get("tag") || (params.get("patternId") ? `pattern:${params.get("patternId")}` : "");

  const [symbol, setSymbol] = useState<string>(initialSymbol);
  const [accounts, setAccounts] = useState<PaperAccount[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [orders, setOrders] = useState<PaperOrder[]>([]);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [tab, setTab] = useState<TabKey>("positions");
  const [soundOn, setSoundOn] = useState<boolean>(paperSoundEnabled());
  const [showWelcome, setShowWelcome] = useState<boolean>(
    typeof window !== "undefined" && localStorage.getItem("qti.paper.welcome.dismissed") !== "1"
  );
  const { toasts, push } = useToastQueue();
  const token = useAuth((s) => s.token);
  // Phase 11 — live pattern_signal banner. Holds the most recent
  // pattern_signal event for the current symbol so the user can one-click
  // the setup into the order form.
  const [livePatternSignal, setLivePatternSignal] = useState<WsPatternSignalPayload | null>(null);

  const prefill = useMemo(
    () => ({
      side: (prefillSide === "BUY" || prefillSide === "SELL") ? prefillSide : undefined,
      qty: prefillQty > 0 ? Math.floor(prefillQty) : undefined,
      stopLoss: prefillSL > 0 ? prefillSL : undefined,
      takeProfit: prefillTP > 0 ? prefillTP : undefined,
      strategyTag: prefillTag || undefined,
    }),
    [prefillSide, prefillQty, prefillSL, prefillTP, prefillTag]
  );
  const hasPrefill = Boolean(prefill.side || prefill.qty || prefill.stopLoss || prefill.takeProfit);

  const refreshAll = useCallback(async () => {
    const accountsRes = await paperApi.listAccounts();
    setAccounts(accountsRes.accounts);
    const active = accountsRes.accounts.find((a) => a.isActive) ?? accountsRes.accounts[0] ?? null;
    if (active) {
      setActiveId(active._id);
      const [p, pos, ord, tr] = await Promise.all([
        paperApi.portfolio(active._id),
        paperApi.listPositions(active._id),
        paperApi.listOrders(active._id, "PENDING,QUEUED"),
        paperApi.listTrades({ accountId: active._id, limit: 50 }),
      ]);
      setPortfolio(p);
      setPositions(pos);
      setOrders(ord);
      setTrades(tr.trades);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Lighter periodic refresh — covers any WS events we miss.
  useEffect(() => {
    const id = setInterval(() => void refreshAll(), 30_000);
    return () => clearInterval(id);
  }, [refreshAll]);

  // Global toast bridge: any component can dispatch a `qti:toast` event
  // with { kind, text, undo? } and it'll surface here (no prop drilling).
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { kind?: "info" | "success" | "warn" | "error"; text?: string; undo?: { label?: string; run: () => void } } | undefined;
      if (!detail?.text) return;
      push(detail.kind ?? "info", detail.text, { undo: detail.undo });
    }
    window.addEventListener("qti:toast", handler);
    return () => window.removeEventListener("qti:toast", handler);
  }, [push]);

  // Use the shared market socket (auto-reconnect, heartbeat) so paper
  // notifications survive network blips. The shared hook funnels paper
  // events into the same WsEvent stream as ticks/signals/orders.
  useMarketSocket({
    token,
    symbols: [symbol],
    onEvent: (data) => {
      // Phase 11 — live pattern_signal banner. Only the current symbol.
      if (data.type === "pattern_signal") {
        const p = data.pattern;
        if (p.symbol.toUpperCase() === symbol.toUpperCase()) {
          setLivePatternSignal(p);
        }
        return;
      }
      if (data.type !== "paper" || !data.event) return;
      const ev = data.event as { kind: string; [k: string]: unknown };
      switch (ev.kind) {
        case "order_filled": {
          push("success", `${ev.side as string} ${ev.qty as number} ${ev.symbol as string} filled @ ₹${(ev.filledPrice as number)?.toFixed(2)}`);
          paperSounds.filled();
          void refreshAll();
          break;
        }
        case "order_rejected": {
          push("error", `Order rejected: ${ev.reason as string}`);
          void refreshAll();
          break;
        }
        case "sl_hit": {
          push("error", `🔴 SL hit — ${ev.symbol as string} closed @ ₹${(ev.exitPrice as number)?.toFixed(2)} (₹${(ev.loss as number)?.toFixed(0)})`);
          paperSounds.slHit();
          void refreshAll();
          break;
        }
        case "tp_hit": {
          push("success", `✅ Target hit — ${ev.symbol as string} closed @ ₹${(ev.exitPrice as number)?.toFixed(2)} (+₹${(ev.profit as number)?.toFixed(0)})`);
          paperSounds.tpHit();
          void refreshAll();
          break;
        }
        case "trailing_sl_updated": {
          push("info", `Trailing SL → ₹${(ev.newStop as number)?.toFixed(2)} (${ev.symbol as string})`);
          break;
        }
        case "squareoff_warning": {
          push("warn", `⚠️ Auto-squareoff in ${ev.minutesLeft as number} min — ${ev.openMis as number} MIS positions will be closed`);
          paperSounds.warn();
          break;
        }
        case "position_closed":
        case "position_opened":
          void refreshAll();
          break;
        case "market_open":
          push("info", "🟢 Market opened — queued orders will be processed");
          break;
        case "market_close":
          push("warn", "🔴 Market closed");
          break;
      }
    },
  });

  function clearPrefillFromUrl() {
    if (hasPrefill) {
      const next = new URLSearchParams(params);
      ["side", "qty", "sl", "tp", "tag"].forEach((k) => next.delete(k));
      setParams(next, { replace: true });
    }
  }

  const todayTrades = trades.filter((t) => isSameIstDay(new Date(t.exitTime), new Date()));

  return (
    <div className="min-h-full flex flex-col bg-app-radial text-slate-200">
      <PaperBanner />
      <Topbar symbol={symbol} wsStatus="open" />
      <div className="flex-1 flex">
        <Sidebar symbols={[]} prices={{}} prevPrices={{}} active={symbol} onSelect={(s) => setSymbol(s)} />
        <main className="flex-1 p-4 space-y-4 min-w-0">
          {/* First-visit welcome card. Dismissed permanently via localStorage. */}
          {showWelcome && (
            <div className="bg-gradient-to-r from-accent-info/15 via-bg-panel-solid/60 to-accent-buy/10 border border-accent-info/40 rounded-xl p-4 flex items-start gap-4">
              <div className="text-3xl">📄</div>
              <div className="flex-1 space-y-1 text-sm">
                <div className="text-white font-semibold">Welcome to paper trading</div>
                <div className="text-slate-300">
                  You get a virtual ₹10,00,000 account. Trades use real NSE prices (yfinance, 15-min delayed)
                  but no real money. Use the <b className="text-white">Order Terminal</b> on the left to place
                  trades; positions appear in the table below with live P&amp;L.
                </div>
                <div className="text-xs text-slate-500">
                  Tip: Visit <a href="/paper/analytics" className="text-accent-info">Analytics</a> for performance metrics,
                  <a href="/paper/journal" className="text-accent-info ml-1">Journal</a> for trade reflection.
                  Press <kbd className="bg-bg-elevated px-1 rounded text-[10px] font-mono">?</kbd> for shortcuts.
                </div>
              </div>
              <button
                onClick={() => {
                  localStorage.setItem("qti.paper.welcome.dismissed", "1");
                  setShowWelcome(false);
                }}
                className="text-slate-400 hover:text-white text-xs"
              >
                ✕ dismiss
              </button>
            </div>
          )}

          {/* Header strip: account + portfolio + market status */}
          <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-3 flex flex-wrap gap-4 items-center justify-between">
            <div className="flex items-center gap-3">
              <AccountSelector accounts={accounts} activeId={activeId} onChange={refreshAll} />
              <MarketStatusBar />
            </div>
            <div className="flex items-center gap-4">
              <PortfolioBar portfolio={portfolio} />
              <button
                onClick={() => {
                  const next = !soundOn;
                  setPaperSoundEnabled(next);
                  setSoundOn(next);
                }}
                className="text-xs text-slate-400 hover:text-white border border-bg-border rounded px-2 py-1"
                title="Toggle paper sounds"
              >
                {soundOn ? "🔊" : "🔇"} sounds
              </button>
            </div>
          </div>

          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-12 lg:col-span-5 space-y-3">
              {livePatternSignal && livePatternSignal.symbol.toUpperCase() === symbol.toUpperCase() && (
                <PatternSignalBanner
                  payload={livePatternSignal}
                  onUse={() => {
                    const next = new URLSearchParams(params);
                    next.set("symbol", livePatternSignal.symbol.toUpperCase());
                    next.set("side", livePatternSignal.signal_action);
                    if (livePatternSignal.target != null) next.set("tp", String(livePatternSignal.target));
                    if (livePatternSignal.stop != null) next.set("sl", String(livePatternSignal.stop));
                    if (livePatternSignal.patternId) next.set("patternId", livePatternSignal.patternId);
                    setParams(next, { replace: true });
                    setLivePatternSignal(null);
                  }}
                  onDismiss={() => setLivePatternSignal(null)}
                />
              )}
              <OrderTerminal
                symbol={symbol}
                setSymbol={setSymbol}
                portfolio={portfolio}
                universe={UNIVERSE}
                onPlaced={(m) => {
                  push("success", m);
                  void refreshAll();
                }}
                prefill={prefill}
                onPrefillConsumed={clearPrefillFromUrl}
              />
            </div>
            <div className="col-span-12 lg:col-span-7">
              <RightSidePlaceholder symbol={symbol} />
            </div>
          </div>

          {/* Bottom tabs */}
          <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl">
            <div className="flex border-b border-bg-border">
              {(["positions", "pending", "today", "all"] as TabKey[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2 text-xs uppercase tracking-wider ${
                    tab === t ? "text-white border-b-2 border-accent-info" : "text-slate-400 hover:text-white"
                  }`}
                >
                  {t === "positions" && `Open positions (${positions.length})`}
                  {t === "pending" && `Pending orders (${orders.length})`}
                  {t === "today" && `Today's trades (${todayTrades.length})`}
                  {t === "all" && `All trades (${trades.length})`}
                </button>
              ))}
            </div>
            <div className="p-1">
              {tab === "positions" && (
                <PositionsTable positions={positions} onMutate={refreshAll} onSelectSymbol={setSymbol} />
              )}
              {tab === "pending" && <PendingOrdersTable orders={orders} onMutate={refreshAll} />}
              {tab === "today" && <TradesTable trades={todayTrades} showTotals />}
              {tab === "all" && <TradesTable trades={trades} showTotals />}
            </div>
          </div>
        </main>
      </div>
      <ToastStack toasts={toasts} />
    </div>
  );
}

function RightSidePlaceholder({ symbol }: { symbol: string }) {
  return (
    <div className="h-full min-h-[400px] bg-bg-panel-solid/60 border border-bg-border rounded-xl p-4 flex items-center justify-center text-slate-500 text-sm">
      <div className="text-center space-y-2">
        <div className="text-white font-mono">{symbol}</div>
        <div>Chart panel — the dashboard's full TradingView chart is available at <a href={`/?symbol=${symbol}`} className="text-accent-info hover:underline">dashboard</a>.</div>
        <div className="text-xs">Open positions for {symbol} appear in the table below.</div>
      </div>
    </div>
  );
}

function isSameIstDay(a: Date, b: Date): boolean {
  const k = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  return k(a) === k(b);
}

// Phase 11 — banner above the OrderTerminal that surfaces a live AI
// pattern_signal and lets the user one-click prefill the order form.
function PatternSignalBanner({
  payload,
  onUse,
  onDismiss,
}: {
  payload: WsPatternSignalPayload;
  onUse: () => void;
  onDismiss: () => void;
}) {
  const sideColor =
    payload.signal_action === "BUY"
      ? "border-accent-buy/40 bg-accent-buy/5"
      : "border-accent-sell/40 bg-accent-sell/5";
  const arrow = payload.signal_action === "BUY" ? "▲" : "▼";
  return (
    <div className={`relative border rounded-xl p-3 ${sideColor}`}>
      <div className="flex items-start gap-3">
        <div className="text-2xl">🔶</div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">AI Pattern Signal</div>
          <div className="text-sm text-white mt-0.5">
            <span className={payload.signal_action === "BUY" ? "text-accent-buy" : "text-accent-sell"}>
              {arrow} {payload.pattern_name}
            </span>{" "}
            <span className="text-slate-400">({payload.confidence}% · {payload.grade})</span> — <b>{payload.signal_action}</b>
          </div>
          <div className="text-xs text-slate-400 mt-1 font-mono">
            {payload.entry != null && <>Entry ₹{payload.entry.toFixed(2)}</>}
            {payload.target != null && <> · 🎯 ₹{payload.target.toFixed(2)}</>}
            {payload.stop != null && <> · 🛑 ₹{payload.stop.toFixed(2)}</>}
            {payload.rr != null && <> · RR {payload.rr.toFixed(2)}</>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            onClick={onUse}
            className="bg-accent-info text-white text-xs font-semibold rounded-md px-3 py-1.5"
          >
            Use Pattern Setup
          </button>
          <button onClick={onDismiss} className="text-[11px] text-slate-500 hover:text-white">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
