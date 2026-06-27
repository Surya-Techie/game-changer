/*
 * chart.js — TradingView Lightweight Charts v4 signal overlay.
 *
 * Drop-in usage:
 *   <div id="chart"></div>
 *   <button id="signals-toggle">Signals: ON</button>
 *   <div id="signal-tooltip" class="signal-tooltip" style="display:none;"></div>
 *   <script src="https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js"></script>
 *   <script src="/static/chart.js"></script>
 *
 * The Flask endpoint `/api/chart/<symbol>` returns:
 *   { ohlcv: [{time,open,high,low,close,volume}], signals: [{time,signal,confidence,patterns}] }
 *
 * Markers are time-sorted before being handed to the chart, per the v4
 * contract (out-of-order markers are silently dropped).
 */

(function () {
  "use strict";

  // ─── Configuration ─────────────────────────────────────────────────────
  const SYMBOL = (window.QTI_SYMBOL || document.body.dataset.symbol || "RELIANCE").toUpperCase();
  const CHART_HOST_ID = "chart";
  const TOOLTIP_ID = "signal-tooltip";
  const TOGGLE_ID = "signals-toggle";

  const COLOR = {
    up: "#16c784",
    down: "#ea3943",
    buy: "#6daa45",
    sell: "#dd6974",
    hold: "#e8af34",
    bg: "#0a0d12",
    text: "#cdccca",
    grid: "#1f2a3d",
  };

  // ─── State ─────────────────────────────────────────────────────────────
  let chart = null;
  let candleSeries = null;
  let markersHandle = null;          // v5: returned by createSeriesMarkers
  let signalsByTime = new Map();     // time(string) → signal object
  let signalsVisible = true;
  let lastMarkers = [];

  // ─── Boot ──────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    mountChart();
    void loadChartData(SYMBOL);
    wireToggleButton();
  });

  function mountChart() {
    const host = document.getElementById(CHART_HOST_ID);
    if (!host) {
      console.error(`signal-overlay: missing #${CHART_HOST_ID} container`);
      return;
    }
    chart = LightweightCharts.createChart(host, {
      layout: {
        background: { type: "solid", color: COLOR.bg },
        textColor: COLOR.text,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: COLOR.grid },
        horzLines: { color: COLOR.grid },
      },
      timeScale: { borderColor: COLOR.grid, timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: COLOR.grid },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: COLOR.up,
      downColor: COLOR.down,
      wickUpColor: COLOR.up,
      wickDownColor: COLOR.down,
      borderVisible: false,
    });

    // Crosshair → tooltip wiring.
    chart.subscribeCrosshairMove((param) => onCrosshair(param, host));
  }

  // ─── Data load ─────────────────────────────────────────────────────────
  async function loadChartData(symbol) {
    try {
      const res = await fetch(`/api/chart/${encodeURIComponent(symbol)}`);
      if (!res.ok) {
        console.error("signal-overlay: chart endpoint returned", res.status);
        return;
      }
      const body = await res.json();
      renderCandles(body.ohlcv || []);
      renderSignals(body.signals || []);
    } catch (err) {
      console.error("signal-overlay: failed to load chart data", err);
    }
  }

  function renderCandles(ohlcv) {
    if (!candleSeries) return;
    const data = ohlcv.map((c) => ({
      time: toChartTime(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));
    candleSeries.setData(data);
    chart.timeScale().fitContent();
  }

  // ─── Signals → markers ─────────────────────────────────────────────────
  function renderSignals(signals) {
    signalsByTime.clear();
    const markers = [];
    for (const s of signals) {
      if (!s || !s.time) continue;
      const t = toChartTime(s.time);
      const confPct = Math.round((Number(s.confidence) || 0) * 100);
      let m;
      if (s.signal === "BUY") {
        m = { time: t, position: "belowBar", shape: "arrowUp", color: COLOR.buy, text: `BUY ${confPct}%` };
      } else if (s.signal === "SELL") {
        m = { time: t, position: "aboveBar", shape: "arrowDown", color: COLOR.sell, text: `SELL ${confPct}%` };
      } else {
        m = { time: t, position: "inBar", shape: "circle", color: COLOR.hold, text: "HOLD" };
      }
      markers.push(m);
      // Index by the chart-time form (a number for seconds-since-epoch) so
      // the crosshair lookup is O(1) without any time-zone coercion.
      signalsByTime.set(String(t), s);
    }
    // MANDATORY: time-ascending sort before createSeriesMarkers.
    markers.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? -1 : 1));
    lastMarkers = markers;
    applyMarkers(signalsVisible ? markers : []);
  }

  function applyMarkers(markers) {
    if (!candleSeries) return;
    // Prefer the v5 standalone helper when available; gracefully fall back
    // to the v4 instance method so the same code works on both library lines.
    if (typeof LightweightCharts.createSeriesMarkers === "function") {
      try {
        // The v5 helper returns a handle; subsequent calls replace its set.
        if (markersHandle && typeof markersHandle.setMarkers === "function") {
          markersHandle.setMarkers(markers);
        } else {
          markersHandle = LightweightCharts.createSeriesMarkers(candleSeries, markers);
        }
        return;
      } catch (err) {
        // Fall through to the legacy path on any v5 surface mismatch.
        console.warn("signal-overlay: createSeriesMarkers failed, falling back to setMarkers", err);
      }
    }
    if (typeof candleSeries.setMarkers === "function") {
      candleSeries.setMarkers(markers);
    }
  }

  // ─── Crosshair tooltip ─────────────────────────────────────────────────
  function onCrosshair(param, host) {
    const tip = document.getElementById(TOOLTIP_ID);
    if (!tip) return;
    if (!param || !param.point || !param.time) {
      tip.style.display = "none";
      return;
    }
    const sig = signalsByTime.get(String(param.time));
    if (!sig) {
      tip.style.display = "none";
      return;
    }
    const confPct = Math.round((Number(sig.confidence) || 0) * 100);
    const label = sig.signal === "BUY"
      ? `<span class="signal-buy">BUY</span>`
      : sig.signal === "SELL"
        ? `<span class="signal-sell">SELL</span>`
        : `<span class="signal-hold">HOLD</span>`;
    const patternsList = (sig.patterns || [])
      .map((n) => `<li>${escapeHtml(n)}</li>`)
      .join("");

    tip.innerHTML = `
      <div class="signal-tooltip__head">${label} · <b>${confPct}%</b></div>
      ${patternsList ? `<ul class="signal-tooltip__patterns">${patternsList}</ul>` : ""}
    `;
    // Position near the crosshair but inside the host rect.
    const rect = host.getBoundingClientRect();
    const x = clamp(param.point.x + 14, 0, rect.width - 240);
    const y = clamp(param.point.y + 14, 0, rect.height - 100);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.style.display = "block";
  }

  // ─── Toggle button ─────────────────────────────────────────────────────
  function wireToggleButton() {
    const btn = document.getElementById(TOGGLE_ID);
    if (!btn) return;
    btn.addEventListener("click", () => {
      signalsVisible = !signalsVisible;
      btn.textContent = `Signals: ${signalsVisible ? "ON" : "OFF"}`;
      btn.classList.toggle("signals-off", !signalsVisible);
      applyMarkers(signalsVisible ? lastMarkers : []);
      if (!signalsVisible) {
        const tip = document.getElementById(TOOLTIP_ID);
        if (tip) tip.style.display = "none";
      }
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────
  function toChartTime(value) {
    // Lightweight Charts accepts both UTCTimestamp (seconds) and "YYYY-MM-DD".
    // We normalise ISO strings → UTCTimestamp (seconds) so the crosshair
    // event's `time` matches our index keys exactly.
    if (typeof value === "number") return Math.floor(value);
    if (typeof value === "string") {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
    }
    return value;
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Expose a tiny global so other scripts can re-render after symbol changes.
  window.signalOverlay = { reload: (sym) => loadChartData((sym || SYMBOL).toUpperCase()) };
})();
