import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import type { UTCTimestamp } from "lightweight-charts";
import clsx from "clsx";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { useMarketSocket, type WsEvent, type WsPatternPayload, type WsPatternSignalPayload } from "../lib/socket";
import { addPattern, clearAllPatterns, initOnce as initPatternOverlay } from "../lib/patternOverlay";
import { detectPatternsLive, type PatternDoc } from "../lib/patternApi";
import PatternPanel from "../components/PatternPanel";
import { PatternToastStack, usePatternToasts } from "../components/PatternToast";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import { type ChartCandle } from "../components/Chart";
import ChartWithDrawings from "../components/ChartDrawings/ChartWithDrawings";
import SignalCard, { type Signal } from "../components/SignalCard";
import RiskCard from "../components/RiskCard";
import PsychologyCard from "../components/PsychologyCard";
import PortfolioHeader, { type Portfolio } from "../components/PortfolioHeader";
import PositionsPanel, { type Position } from "../components/PositionsPanel";
import TradesPanel, { type Trade, type TradeStats } from "../components/TradesPanel";
import SectorHeatmap from "../components/SectorHeatmap";
import MarketMovers from "../components/MarketMovers";
import NotificationsDrawer, { type Notification } from "../components/NotificationsDrawer";
import AIAssistantCard from "../components/AIAssistantCard";
import PredictionCard from "../components/PredictionCard";
import GainzAlphaCard from "../components/GainzAlphaCard";
import NewsPanel from "../components/NewsPanel";
import CompositeCard from "../components/CompositeCard";
import MTFPanel from "../components/MTFPanel";
import LevelsPanel from "../components/LevelsPanel";
import CandlestickPatternsCard from "../components/CandlestickPatternsCard";
import MarketOverviewPanel from "../components/MarketOverview";
import EconomicCalendarBanner from "../components/EconomicCalendarBanner";
import BulkDealsPanel from "../components/BulkDealsPanel";
import PremiumIndicatorsToolbar from "../components/PremiumIndicatorsToolbar";
import PremiumIndicatorsPanel from "../components/PremiumIndicatorsPanel";
import { usePremiumShortcuts } from "../hooks/usePremiumShortcuts";
import { overlayManager } from "../lib/overlayManager";
import Tabs, { type TabDef } from "../components/Tabs";

const UNIVERSE = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL"];

/** Map an AI-service detection result to the WS payload shape the
 *  patternOverlay registry consumes. The `time` field on trendline_points
 *  from the AI service is epoch ms — but the legacy patternOverlay divides
 *  by 1000 before handing to lightweight-charts, so we pre-validate here
 *  and drop trendline_points whose times look invalid (small ints from
 *  some pandas versions) to avoid drawing a line at the chart origin. */
function patternDocToPayload(symbol: string, tf: string) {
  return (p: PatternDoc): WsPatternPayload => {
    const tps = (p.trendline_points ?? []).filter(
      // Only keep points whose time looks like a real epoch-ms timestamp
      // (year ≥ 2000 ⇒ ≥ 9.4e11). Smaller values are bar indices from
      // older yfinance/pandas paths and would render at 1970 → invisible.
      (pt) => typeof pt.time === "number" && pt.time > 9.4e11,
    );
    return {
      patternId: p._id,
      symbol,
      timeframe: tf,
      pattern_name: p.pattern_name,
      category: p.category,
      direction: p.direction,
      confidence: Math.round(p.confidence_score ?? 0),
      grade: p.grade ?? "C",
      candle_indices: p.candle_indices ?? [],
      trendline_points: tps,
      entry: p.entry_price,
      target: p.target_price,
      stop: p.stop_price,
      rr: p.risk_reward,
      ai_explanation: p.ai_explanation,
      detected_at: p.detected_at ? new Date(p.detected_at).getTime() : Date.now(),
    };
  };
}

export default function DashboardPage() {
  const token = useAuth((s) => s.token);
  const qc = useQueryClient();
  usePremiumShortcuts(); // Alt+1..5 → toggle premium indicators

  const [symbols, setSymbols] = useState<string[]>([]);
  const [active, setActive] = useState<string>("");
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [prevPrices, setPrevPrices] = useState<Record<string, number>>({});
  const [references, setReferences] = useState<Record<string, number>>({}); // first observed price per symbol
  const [candleHistory, setCandleHistory] = useState<ChartCandle[]>([]);
  const [liveCandle, setLiveCandle] = useState<ChartCandle | undefined>(undefined);
  const [timeframe, setTimeframe] = useState<string>("1m");
  const timeframeRef = useRef(timeframe);
  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);
  const [signalsBySymbol, setSignalsBySymbol] = useState<Record<string, Signal>>({});
  const [portfolio, setPortfolio] = useState<Portfolio | undefined>(undefined);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeStats, setTradeStats] = useState<TradeStats | undefined>(undefined);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Pattern engine state: per-symbol list of live patterns (capped at 25 each).
  const [patternsBySymbol, setPatternsBySymbol] = useState<Record<string, WsPatternPayload[]>>({});
  const patternToasts = usePatternToasts();

  // Initialise the pattern-overlay re-attach hook once. Idempotent.
  useEffect(() => { initPatternOverlay(); }, []);

  // Watchlists.
  const wlQuery = useQuery({
    queryKey: ["watchlists"],
    queryFn: async () => (await api.get("/api/watchlist")).data.watchlists as Array<{ symbols: string[] }>,
  });

  useEffect(() => {
    const list = wlQuery.data?.[0]?.symbols ?? [];
    if (list.length && symbols.length === 0) {
      setSymbols(list);
      setActive(list[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally re-runs only on the listed deps
  }, [wlQuery.data]);

  // Listen for keyboard-shortcut symbol picks + URL ?symbol=
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("symbol");
    if (fromUrl) setActive(fromUrl.toUpperCase());

    const onPick = (e: Event) => {
      const s = (e as CustomEvent<string>).detail;
      if (s) setActive(s.toUpperCase());
    };
    window.addEventListener("qti:pick-symbol", onPick);
    return () => window.removeEventListener("qti:pick-symbol", onPick);
  }, []);

  // Initial portfolio + positions + trades. We deliberately use
  // Promise.allSettled (not Promise.all) so that a single failed
  // endpoint — e.g. a transient backend restart or a 5xx on /api/trades —
  // doesn't blank out the entire portfolio header. Each piece updates
  // independently when its fetch succeeds.
  //
  // Auto-retry: if the portfolio fetch failed (backend was down) we
  // schedule a retry every 4s until it succeeds. This means as soon as
  // the user starts the backend the dashboard fills itself in without
  // requiring a page reload.
  useEffect(() => {
    if (!token) return;
    let aborted = false;
    let retryTimer: number | undefined;
    let portfolioOk = false;

    async function loadOnce() {
      const [pfRes, psRes, trRes] = await Promise.allSettled([
        api.get("/api/portfolio"),
        api.get("/api/positions?status=OPEN"),
        api.get("/api/trades"),
      ]);
      if (aborted) return;
      if (pfRes.status === "fulfilled") {
        const p = pfRes.value.data;
        setPortfolio({
          capital: p.capital,
          equity: p.equity,
          realisedPnl: p.realisedPnl,
          unrealisedPnl: p.unrealisedPnl,
          dailyPnl: p.dailyPnl,
          openPositions: Array.isArray(p.openPositions) ? p.openPositions.length : (p.openPositions ?? 0),
          autoTradeMode: p.autoTradeMode,
          killSwitch: p.killSwitch,
        });
        portfolioOk = true;
      }
      if (psRes.status === "fulfilled") {
        setPositions(psRes.value.data.positions as Position[]);
      }
      if (trRes.status === "fulfilled") {
        setTrades(trRes.value.data.trades as Trade[]);
        setTradeStats(trRes.value.data.stats as TradeStats);
      }
      if (!portfolioOk && !aborted) {
        retryTimer = window.setTimeout(loadOnce, 4_000);
      }
    }
    void loadOnce();

    return () => {
      aborted = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [token]);

  // Candles when active symbol or timeframe changes.
  useEffect(() => {
    if (!active) return;
    // Wipe any premium overlays from the previous symbol — indicator
    // components re-fetch and re-mount for the new symbol on their own.
    overlayManager.clearAll();
    // Drop the previous symbol's pattern overlays as well; re-apply this
    // symbol's known patterns after the chart re-attaches.
    clearAllPatterns();
    setCandleHistory([]);
    setLiveCandle(undefined);
    let aborted = false;
    (async () => {
      const { data } = await api.get(`/api/market/candles/${active}?timeframe=${timeframe}&limit=200`);
      if (aborted) return;
      setCandleHistory(
        (data.candles as ChartCandle[]).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }))
      );
    })();
    return () => {
      aborted = true;
    };
  }, [active, timeframe]);

  // Latest signal for active symbol.
  useEffect(() => {
    if (!active) return;
    let aborted = false;
    (async () => {
      const { data } = await api.get(`/api/signals/latest/${active}`);
      if (aborted || !data.signal) return;
      setSignalsBySymbol((m) => ({ ...m, [active]: data.signal as Signal }));
    })();
    return () => {
      aborted = true;
    };
  }, [active]);

  // Re-apply this symbol's known live patterns whenever the active symbol
  // changes (and after the chart has reloaded its candle history). A small
  // delay gives Chart.tsx time to attach the new candle series via
  // overlayManager — the patternOverlay.initOnce subscriber will also catch
  // late attaches, but we re-apply here to cover the common case.
  useEffect(() => {
    if (!active) return;
    const list = patternsBySymbol[active] ?? [];
    if (list.length === 0) return;
    const handle = window.setTimeout(() => {
      for (const p of list) addPattern(p);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [active, patternsBySymbol]);

  // Auto-draw patterns on the chart: when the user opens a symbol, run a
  // fresh detection pass against the AI service and overlay each pattern
  // (entry/SL/TP lines + name marker + trendline polyline). This is what
  // makes "the pattern shows up on the chart as it forms" visible without
  // needing to wait for a WebSocket fanout from the engine background loop.
  useEffect(() => {
    if (!active) return;
    let aborted = false;
    (async () => {
      const res = await detectPatternsLive(active, "D1", 120);
      if (aborted || !res || !res.patterns) return;
      const payloads: WsPatternPayload[] = res.patterns
        .filter((p) => Number(p.confidence_score ?? 0) >= 40 && p.entry_price != null)
        .sort((a, b) => Number(b.confidence_score ?? 0) - Number(a.confidence_score ?? 0))
        .slice(0, 3) // keep the chart readable — top-3 by confidence
        .map(patternDocToPayload(active, "D1"));
      // Stage into state so the re-apply effect re-mounts them after
      // symbol swaps, and immediately mount onto the live chart.
      if (payloads.length > 0) {
        setPatternsBySymbol((m) => {
          const existing = m[active] ?? [];
          const byKey = new Map<string, WsPatternPayload>();
          for (const p of existing) byKey.set(p.patternId ?? `${p.pattern_name}:${p.timeframe}:${p.detected_at}`, p);
          for (const p of payloads) byKey.set(p.patternId ?? `${p.pattern_name}:${p.timeframe}:${p.detected_at}`, p);
          return { ...m, [active]: [...byKey.values()].slice(0, 25) };
        });
        // Mount with a tiny delay so the new candle series is attached.
        window.setTimeout(() => {
          if (aborted) return;
          for (const p of payloads) addPattern(p);
        }, 300);
      }
    })();
    return () => { aborted = true; };
  }, [active]);

  // PatternPanel row click → recenter the chart on the relevant candle.
  useEffect(() => {
    function onFocus(e: Event) {
      const payload = (e as CustomEvent<WsPatternPayload>).detail;
      if (!payload) return;
      // If the user picked a pattern for a different symbol, switch.
      if (payload.symbol !== active) {
        setActive(payload.symbol.toUpperCase());
      }
      const chart = overlayManager.getChart();
      if (!chart) return;
      const ts = Math.floor(payload.detected_at / 1000) as UTCTimestamp;
      try {
        // Show ~30 bars on either side of the pattern.
        const halfWindow = 30 * 60; // seconds (≈ 1m bars × 30)
        chart.timeScale().setVisibleRange({
          from: (ts as number - halfWindow) as UTCTimestamp,
          to: (ts as number + halfWindow) as UTCTimestamp,
        });
      } catch {
        /* the chart may not be ready yet — silent skip */
      }
    }
    window.addEventListener("qti:pattern-focus", onFocus as EventListener);
    return () => window.removeEventListener("qti:pattern-focus", onFocus as EventListener);
  }, [active]);

  const lastUpdateRef = useRef(0);
  const { status } = useMarketSocket({
    token,
    symbols: UNIVERSE, // subscribe to whole universe for heatmap + movers
    onEvent: (ev: WsEvent) => {
      if (ev.type === "tick") {
        setPrices((m) => {
          const prev = m[ev.symbol];
          if (prev != null && prev !== ev.price) {
            setPrevPrices((pm) => ({ ...pm, [ev.symbol]: prev }));
          }
          return { ...m, [ev.symbol]: ev.price };
        });
        setReferences((r) => (r[ev.symbol] != null ? r : { ...r, [ev.symbol]: ev.price }));
        return;
      }
      if (ev.type === "candle") {
        if (ev.candle.symbol !== active) return;
        if (timeframeRef.current !== "1m") return;
        const now = Date.now();
        if (now - lastUpdateRef.current < 250) return;
        lastUpdateRef.current = now;
        setLiveCandle({
          t: ev.candle.t,
          o: ev.candle.o,
          h: ev.candle.h,
          l: ev.candle.l,
          c: ev.candle.c,
        });
        return;
      }
      if (ev.type === "signal") {
        const s = ev.signal as unknown as Signal;
        setSignalsBySymbol((m) => ({ ...m, [s.symbol]: s }));
        if (s.action !== "HOLD") {
          pushNotification({
            id: `${s.symbol}-${Date.now()}`,
            ts: Date.now(),
            type: "signal",
            symbol: s.symbol,
            title: `${s.action} signal · ${s.symbol}`,
            body: `Confidence ${(s.confidence * 100).toFixed(0)}%${s.reason ? " — " + s.reason : ""}`,
            tone: s.action === "BUY" ? "buy" : "sell",
          });
        }
        return;
      }
      if (ev.type === "order") {
        const o = (ev as unknown as { order: { symbol: string; side: string; qty: number; filledPrice?: number; status: string } }).order;
        if (o.status === "FILLED") {
          pushNotification({
            id: `order-${o.symbol}-${Date.now()}`,
            ts: Date.now(),
            type: "fill",
            symbol: o.symbol,
            title: `${o.side} ${o.qty} ${o.symbol} filled @ ${o.filledPrice?.toFixed(2) ?? "?"}`,
            tone: o.side === "BUY" ? "buy" : "sell",
          });
        }
        return;
      }
      if (ev.type === "position") {
        const pos = (ev as unknown as { position: Position & { positionId?: string; exitReason?: string; realisedPnl?: number } }).position;
        const id = pos._id ?? pos.positionId;
        if (!id) return;
        const normalised: Position = { ...pos, _id: id };
        if (pos.status === "OPEN") {
          setPositions((curr) => (curr.some((p) => p._id === id) ? curr : [normalised, ...curr]));
          pushNotification({
            id: `pos-open-${id}`,
            ts: Date.now(),
            type: "fill",
            symbol: pos.symbol,
            title: `Opened ${pos.side} ${pos.symbol} ×${pos.qty} @ ${pos.entryPrice.toFixed(2)}`,
            tone: pos.side === "LONG" ? "buy" : "sell",
          });
        } else if (pos.status === "CLOSED") {
          setPositions((curr) => curr.filter((p) => p._id !== id));
          api.get("/api/trades").then(({ data }) => {
            setTrades(data.trades);
            setTradeStats(data.stats);
          });
          pushNotification({
            id: `pos-close-${id}`,
            ts: Date.now(),
            type: "exit",
            symbol: pos.symbol,
            title: `Closed ${pos.symbol} (${pos.exitReason ?? "exit"}) · P&L ₹${(pos.realisedPnl ?? 0).toFixed(2)}`,
            tone: (pos.realisedPnl ?? 0) >= 0 ? "buy" : "sell",
          });
        }
        return;
      }
      if (ev.type === "portfolio") {
        const p = (ev as unknown as { portfolio: Portfolio & { openPositions?: number } }).portfolio;
        setPortfolio((prev) => ({
          ...(prev ?? { capital: 100000, autoTradeMode: "AUTO", killSwitch: false }),
          ...p,
        }));
      }
      if (ev.type === "pattern" || ev.type === "pattern_signal") {
        const payload = ev.pattern as WsPatternPayload | WsPatternSignalPayload;
        const sym = payload.symbol.toUpperCase();
        setPatternsBySymbol((m) => {
          const existing = m[sym] ?? [];
          // Dedupe by patternId or composite key.
          const key = payload.patternId ?? `${payload.pattern_name}:${payload.timeframe}:${payload.detected_at}`;
          const filtered = existing.filter((p) => (p.patternId ?? `${p.pattern_name}:${p.timeframe}:${p.detected_at}`) !== key);
          return { ...m, [sym]: [payload, ...filtered].slice(0, 25) };
        });
        // Push toast for high-confidence (≥80) regardless of which symbol is
        // currently active — clicking the toast switches symbols.
        patternToasts.push(payload);
        // If the pattern is on the currently-active symbol, mount overlays now.
        if (sym === active) addPattern(payload);
        return;
      }
      if (ev.type === "pattern_training_progress") {
        const prog = ev.progress;
        pushNotification({
          id: `train-${prog.job_id}-${prog.percent}`,
          ts: Date.now(),
          type: "signal",
          symbol: "",
          title: `Pattern training ${prog.status}`,
          body: `${prog.message || "—"} (${prog.percent}%)`,
          tone: prog.status === "failed" ? "sell" : "buy",
        });
        return;
      }
    },
  });

  function pushNotification(n: Notification) {
    setNotifications((curr) => [n, ...curr].slice(0, 50));
  }

  const activeSignal = useMemo(() => (active ? signalsBySymbol[active] : undefined), [active, signalsBySymbol]);

  async function changeMode(mode: "OFF" | "SEMI" | "AUTO") {
    const { data } = await api.patch("/api/autotrade", { autoTradeMode: mode });
    setPortfolio((p) =>
      p ? { ...p, autoTradeMode: data.settings.autoTradeMode, killSwitch: data.settings.killSwitch } : p
    );
  }

  async function toggleKillSwitch() {
    const newVal = !portfolio?.killSwitch;
    const { data } = await api.patch("/api/autotrade", { killSwitch: newVal });
    setPortfolio((p) => (p ? { ...p, killSwitch: data.settings.killSwitch } : p));
  }

  async function closePosition(id: string) {
    await api.delete(`/api/positions/${id}`);
    setPositions((curr) => curr.filter((p) => p._id !== id));
    qc.invalidateQueries({ queryKey: ["positions"] });
  }

  // ---------------- Tab definitions -----------------------------------------
  // The right rail used to be a 13-card vertical wall — now grouped into 3
  // semantic tabs so the user picks what they want to look at.

  const signalsTab: TabDef = {
    id: "signals",
    label: "Signals",
    content: (
      <div className="space-y-3">
        <AIAssistantCard signal={activeSignal} />
        <SignalCard signal={activeSignal} />
        <CompositeCard symbol={active} />
        <PremiumIndicatorsPanel symbol={active} />
      </div>
    ),
  };

  const analysisTab: TabDef = {
    id: "analysis",
    label: "Analysis",
    badge: (patternsBySymbol[active]?.length ?? 0) > 0 ? (patternsBySymbol[active]?.length ?? 0) : undefined,
    content: (
      <div className="space-y-3">
        <GainzAlphaCard symbol={active} />
        <PatternPanel symbol={active} livePatterns={patternsBySymbol[active] ?? []} />
        <MTFPanel symbol={active} />
        <CandlestickPatternsCard symbol={active} />
        <LevelsPanel symbol={active} />
        <PredictionCard symbol={active} />
        <NewsPanel symbol={active} />
      </div>
    ),
  };

  const riskTab: TabDef = {
    id: "risk",
    label: "Risk & Trades",
    badge: positions.length > 0 ? positions.length : undefined,
    content: (
      <div className="space-y-3">
        <PositionsPanel positions={positions} prices={prices} onClose={closePosition} onSelect={setActive} />
        <RiskCard signal={activeSignal} />
        <TradesPanel trades={trades} stats={tradeStats} />
        <PsychologyCard />
      </div>
    ),
  };

  const heatmapTab: TabDef = {
    id: "heatmap",
    label: "Heatmap",
    content: (
      <SectorHeatmap symbols={UNIVERSE} prices={prices} references={references} onSelect={setActive} />
    ),
  };

  const moversTab: TabDef = {
    id: "movers",
    label: "Movers",
    content: <MarketMovers symbols={UNIVERSE} prices={prices} references={references} onSelect={setActive} />,
  };

  const bulkDealsTab: TabDef = {
    id: "bulk",
    label: "Bulk Deals",
    content: <BulkDealsPanel />,
  };

  return (
    <div className="h-screen flex bg-app-radial text-slate-200">
      <Sidebar
        symbols={symbols}
        prices={prices}
        prevPrices={prevPrices}
        active={active}
        onSelect={setActive}
      />
      <main className="flex-1 flex flex-col min-w-0">
        <Topbar
          symbol={active}
          price={prices[active]}
          prevPrice={prevPrices[active]}
          wsStatus={status}
          onOpenNotifications={() => setDrawerOpen(true)}
          unreadCount={notifications.length}
        />
        <PortfolioHeader portfolio={portfolio} onChangeMode={changeMode} onToggleKillSwitch={toggleKillSwitch} />

        <div className="flex-1 flex min-h-0">
          {/* ---------- center: chart + bottom tabs ---------- */}
          <section className="flex-1 min-w-0 p-4 overflow-y-auto">
            <div className="space-y-3">
              <EconomicCalendarBanner />
              <MarketOverviewPanel />
              <PremiumIndicatorsToolbar />

              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="rounded-xl border border-bg-border bg-bg-panel-solid/70 backdrop-blur-glass shadow-glass overflow-hidden h-[490px] flex flex-col"
              >
                {/* Timeframe + active symbol display row */}
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-bg-border bg-bg-panel-solid/40">
                  {[
                    { value: "1m", label: "1m" },
                    { value: "5m", label: "5m" },
                    { value: "15m", label: "15m" },
                    { value: "1h", label: "1h" },
                    { value: "1d", label: "1d" },
                    { value: "1y", label: "1y" },
                  ].map((tf) => (
                    <button
                      key={tf.value}
                      onClick={() => setTimeframe(tf.value)}
                      className={clsx(
                        "px-3 py-1.5 rounded-lg text-xs font-mono border transition-all duration-200 min-w-[40px] text-center font-medium",
                        timeframe === tf.value
                          ? "border-indigo-500/80 text-white bg-indigo-500/10 shadow-[0_0_12px_-3px_rgba(99,102,241,0.4)]"
                          : "border-bg-border text-slate-400 hover:text-slate-200 hover:bg-bg-elevated/40"
                      )}
                    >
                      {tf.label}
                    </button>
                  ))}

                  <div className="ml-2 px-4 py-1.5 rounded-lg border border-bg-border bg-bg-elevated/30 text-slate-200 font-mono text-xs uppercase tracking-wider font-semibold">
                    {active}
                  </div>
                </div>

                <div className="flex-1 min-h-0">
                  <ChartWithDrawings symbol={active} candles={candleHistory} liveCandle={liveCandle} />
                </div>
              </motion.div>

              <Tabs tabs={[heatmapTab, moversTab, bulkDealsTab]} defaultId="heatmap" />
            </div>
          </section>

          {/* ---------- right: 3-tab analysis rail ---------- */}
          <section className="w-96 shrink-0 border-l border-bg-border p-4 overflow-y-auto">
            <Tabs tabs={[signalsTab, analysisTab, riskTab]} defaultId="signals" />
          </section>
        </div>
      </main>

      <NotificationsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        notifications={notifications}
        onClear={() => setNotifications([])}
      />

      {/* Animated pattern toasts for high-confidence (≥80%) detections. */}
      <PatternToastStack items={patternToasts.items} onDismiss={patternToasts.dismiss} />
    </div>
  );
}
