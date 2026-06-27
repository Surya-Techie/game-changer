/* ─── Trading Lab — frontend application ─────────────────────────
 * Vanilla ES module. No build step. Plotly.js loaded via CDN.
 * Communicates with FastAPI backend at /api/*
 * ───────────────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ── Theme colors (mirror style.css custom-props) ───────────────
const T = {
  bg:    "#0a0e14",
  card:  "#141a25",
  grid:  "#1a2436",
  text:  "#d7e0f0",
  mute:  "#8392ad",
  green: "#22c55e",
  red:   "#ef4444",
  yellow:"#fbbf24",
  accent:"#22d39a",
};

const PLOTLY_LAYOUT_BASE = {
  paper_bgcolor: T.bg,
  plot_bgcolor:  T.bg,
  font: { color: T.text, family: "Inter, -apple-system, sans-serif", size: 11 },
  margin: { l: 50, r: 50, t: 10, b: 32 },
  xaxis: { gridcolor: T.grid, linecolor: T.grid, zerolinecolor: T.grid,
           rangeslider: { visible: false } },
  yaxis: { gridcolor: T.grid, linecolor: T.grid, zerolinecolor: T.grid,
           side: "right" },
  hoverlabel: { bgcolor: T.card, bordercolor: T.grid, font: { color: T.text } },
  showlegend: false,
};

// ── tiny helpers ──────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, opts);
    if (!res.ok) {
      const txt = await res.text();
      showToast(`API ${res.status}: ${txt.slice(0,80)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    showToast(`Network: ${e.message}`);
    return null;
  }
}
const fmt = {
  num:   (v, d=2) => (v==null||!isFinite(v)) ? "—" : Number(v).toFixed(d),
  pct:   (v, d=2) => (v==null||!isFinite(v)) ? "—" : (Number(v)*100).toFixed(d) + " %",
  money: (v)      => (v==null||!isFinite(v)) ? "—" : "₹" + Math.round(v).toLocaleString(),
  signed:(v)      => (v==null||!isFinite(v)) ? "—" : (v>=0?"+":"") + Number(v).toFixed(2),
};

// ── boot ───────────────────────────────────────────────────────
let META = null;
const state = {
  page: "pattern",
  trades: [],  // local journal for battle plan
};

(async function init() {
  // wait for Plotly to load
  while (typeof Plotly === "undefined") await new Promise(r => setTimeout(r, 50));

  META = await api("/api/meta");
  if (!META) return;

  // populate selects
  const symbols = [...META.symbols.equity, ...META.symbols.crypto];
  for (const sel of ["paSymbol", "lvSymbol", "btSymbol", "opSymbol"]) {
    const el = document.getElementById(sel);
    el.innerHTML = symbols.map(s => `<option value="${s}">${s}</option>`).join("");
  }
  for (const sel of ["paStrategy", "opStrategy", "bpTrStrat"]) {
    const el = document.getElementById(sel);
    el.innerHTML = META.strategies
      .map(s => `<option value="${s.id}">${s.num}: ${s.label}</option>`).join("");
  }

  $("#sidebarFooter").innerHTML =
    `Capital ${fmt.money(META.config.capital)}<br>` +
    `Target +${(META.config.daily_target*100).toFixed(0)} %  Stop −${(META.config.max_daily_loss*100).toFixed(0)} %`;

  // nav
  $$(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => switchPage(btn.dataset.page));
  });
  switchPage("pattern");

  // wire page actions
  $("#paRun").addEventListener("click", runPattern);
  $("#lvRefresh").addEventListener("click", runLive);
  $("#btRun").addEventListener("click", runBacktest);
  $("#scRun").addEventListener("click", runScreener);
  $("#opRun").addEventListener("click", runOptimizer);
  $("#bpRefresh").addEventListener("click", runBattleRefresh);
  $("#bpTrAdd").addEventListener("click", addTrade);

  // first analysis
  runPattern();
})();

// ── page switching ────────────────────────────────────────────
function switchPage(name) {
  state.page = name;
  $$(".page").forEach(p => p.hidden = (p.dataset.page !== name));
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  const titles = {
    pattern: "Pattern Analysis", live: "Live Signals",
    backtest: "Backtest", screener: "Pre-Market Screener",
    optimizer: "Optimizer", battle: "Daily Battle Plan",
  };
  $("#pageTitle").textContent = titles[name] || name;
  // lazy-init pages on first visit
  if (name === "live"     && !state.liveInit)     { state.liveInit = true; runLive(); }
  if (name === "screener" && !state.scInit)       { state.scInit = true; runScreener(); }
  if (name === "battle"   && !state.bpInit)       { state.bpInit = true; runBattleRefresh(); }
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: PATTERN ANALYSIS — chart matching the reference image
   - candlesticks (green/red)
   - BUY ▲ arrow + "BUY {conf}%" text below the candle
   - SELL ▼ arrow + "SELL {conf}%" text above
   - HOLD ● yellow dots (sampled)
   - dotted horizontal level line
   ══════════════════════════════════════════════════════════════ */
async function runPattern() {
  const symbol   = $("#paSymbol").value;
  const interval = $("#paInterval").value;
  const days     = Math.max(3, Math.min(30, +$("#paDays").value || 10));
  const strategy = $("#paStrategy").value;
  const source   = $("#paSource").value;   // "ml" or "strategy"
  const showHold = $("#paShowHold").checked;

  $("#chartStatus").textContent = "loading…";
  $("#chartStatus").classList.add("running");

  // ── Pick endpoint based on Source ──
  let url;
  if (source === "pct5") {
    url = `/api/ml-5pct-predict?symbol=${encodeURIComponent(symbol)}` +
          `&interval=${interval}&days=${days}&threshold=0.85`;
  } else if (source === "win") {
    url = `/api/ml-win-predict?symbol=${encodeURIComponent(symbol)}` +
          `&interval=${interval}&days=${days}&threshold=0.65`;
  } else if (source === "ml") {
    url = `/api/ml-predict?symbol=${encodeURIComponent(symbol)}` +
          `&interval=${interval}&days=${days}&threshold=0.5`;
  } else {
    url = `/api/chart-data?symbol=${encodeURIComponent(symbol)}` +
          `&interval=${interval}&days=${days}&strategy=${strategy}`;
  }
  const data = await api(url);
  $("#chartStatus").classList.remove("running");
  if (!data || data.error) {
    $("#chartStatus").textContent = "no data";
    showToast(data?.error || "No data");
    Plotly.purge("paChart");
    $("#mlBanner").hidden = true;
    return;
  }
  $("#chartStatus").textContent = `${data.counts.buy + data.counts.sell} signals`;

  // ── ML banner ──
  if (source === "pct5") {
    const status = await api("/api/ml-5pct-status");
    if (status?.loaded) {
      const m = status.metrics || {};
      const tau = m.recommended_threshold ?? 0.85;
      const row = (m.confidence_curve || []).find(r => r.threshold === tau) || {};
      $("#mlMeta").innerHTML =
        `<b>💰 +${(m.target_pct*100).toFixed(0)}% Hunter</b> · ` +
        `base rate ${(m.base_rate*100).toFixed(1)}% · ` +
        `<b style="color:var(--accent)">${row.accuracy_pct ? row.accuracy_pct.toFixed(1)+'% acc</b>' : '—'} ` +
        `at τ=${tau} · ${row.win_precision ? row.win_precision.toFixed(0)+'% HIT-precision' : ''}`;
      $("#mlBanner").hidden = false;
    } else {
      $("#mlMeta").textContent = "5% model not trained — python -m trading_app.ml.win_predictor --mode 5pct";
      $("#mlBanner").hidden = false;
    }
  } else if (source === "win") {
    const status = await api("/api/ml-win-status");
    if (status?.loaded) {
      const m = status.metrics || {};
      // Find the confidence-curve row at the recommended threshold
      const tau = m.recommended_threshold ?? 0.65;
      const row = (m.confidence_curve || []).find(r => r.threshold === tau) || {};
      const acc = row.accuracy_pct;
      $("#mlMeta").innerHTML =
        `<b>${status.version}</b> · ` +
        `base rate ${(m.base_rate*100).toFixed(1)}% · ` +
        `<b style="color:var(--accent)">${acc ? acc.toFixed(1) + '% accuracy</b>' : '—'} ` +
        `at τ=${tau} · ${(status.features||[]).length} features`;
      $("#mlBanner").hidden = false;
    } else {
      $("#mlMeta").textContent = "win-predictor not trained — run trainer";
      $("#mlBanner").hidden = false;
    }
  } else if (source === "ml") {
    const status = await api("/api/ml-status");
    if (status?.loaded) {
      const m = status.metrics || {};
      $("#mlMeta").textContent =
        `${status.version} · in-sample ${(m.in_sample_accuracy*100).toFixed(1)}% · ` +
        `out-of-sample ${(m.out_of_sample_accuracy*100).toFixed(1)}% · ` +
        `${(status.features||[]).length} features`;
      $("#mlBanner").hidden = false;
    } else {
      $("#mlMeta").textContent = "model not trained";
      $("#mlBanner").hidden = false;
    }
  } else {
    $("#mlBanner").hidden = true;
  }

  // header / metrics
  const stratLabel = META.strategies.find(s => s.id === strategy);
  const headTitle =
      source === "pct5" ? `${symbol} · ${interval} · 💰 +5% Hunter (${data.model_version || "pps-5pct"} · τ=${data.threshold})`
    : source === "win"  ? `${symbol} · ${interval} · 🎯 ML win-filter (${data.model_version || "pps-win"} · τ=${data.threshold})`
    : source === "ml"   ? `${symbol} · ${interval} · 🤖 ML 3-class (${data.model_version || "pps-ml"})`
                        : `${symbol} · ${interval} · ${stratLabel?.num ?? ""}: ${stratLabel?.label ?? strategy}`;
  $("#chartTitle").textContent = headTitle;
  $("#mSymbol").textContent = symbol;
  $("#mLast").textContent   = fmt.num(data.last_price);
  $("#mState").innerHTML =
    data.last_state === "BUY"  ? `<span class="cell-buy">🟢 BUY</span>`
  : data.last_state === "SELL" ? `<span class="cell-sell">🔴 SELL</span>`
  :                              `<span class="cell-hold">⚪ HOLD</span>`;
  $("#mBuy").textContent  = data.counts.buy;
  $("#mSell").textContent = data.counts.sell;
  $("#mHold").textContent = data.counts.hold;

  drawPatternChart(data, showHold);
  drawSignalLog(data);
}

function drawPatternChart(d, showHold) {
  const traces = [];

  // candles (no internal hover; we put hover on the markers)
  traces.push({
    type: "candlestick",
    x: d.candles.time,
    open: d.candles.open, high: d.candles.high,
    low:  d.candles.low,  close: d.candles.close,
    increasing: { line: { color: T.green, width: 1 }, fillcolor: T.green },
    decreasing: { line: { color: T.red,   width: 1 }, fillcolor: T.red   },
    hoverinfo: "skip",
    showlegend: false,
  });

  // BUY markers: green triangle-up below the candle low
  if (d.buys.length) {
    traces.push({
      type: "scatter", mode: "markers+text",
      x: d.buys.map(b => b.time),
      y: d.buys.map(b => b.low * 0.9985),
      marker: { symbol: "triangle-up", size: 16, color: T.green,
                line: { width: 1.5, color: "#003322" } },
      text: d.buys.map(b => `BUY ${b.confidence}%`),
      textposition: "bottom center",
      textfont: { color: T.green, size: 11, family: "Inter, sans-serif" },
      customdata: d.buys.map(b => [b.price, b.stop, b.target, b.reason, b.confidence]),
      hovertemplate:
        "<b style='color:#22c55e'>BUY %{customdata[4]}%</b><br>" +
        "Time: %{x|%Y-%m-%d %H:%M}<br>" +
        "Price: %{customdata[0]:.2f}<br>" +
        "Stop: %{customdata[1]:.2f}<br>" +
        "Target: %{customdata[2]:.2f}<br>" +
        "Reason: %{customdata[3]}<extra></extra>",
      showlegend: false,
    });
  }

  // SELL markers: red triangle-down above the candle high
  if (d.sells.length) {
    traces.push({
      type: "scatter", mode: "markers+text",
      x: d.sells.map(s => s.time),
      y: d.sells.map(s => s.high * 1.0015),
      marker: { symbol: "triangle-down", size: 16, color: T.red,
                line: { width: 1.5, color: "#330000" } },
      text: d.sells.map(s => `SELL ${s.confidence}%`),
      textposition: "top center",
      textfont: { color: T.red, size: 11, family: "Inter, sans-serif" },
      customdata: d.sells.map(s => [s.price, s.stop, s.target, s.reason, s.confidence]),
      hovertemplate:
        "<b style='color:#ef4444'>SELL %{customdata[4]}%</b><br>" +
        "Time: %{x|%Y-%m-%d %H:%M}<br>" +
        "Price: %{customdata[0]:.2f}<br>" +
        "Stop: %{customdata[1]:.2f}<br>" +
        "Target: %{customdata[2]:.2f}<br>" +
        "Reason: %{customdata[3]}<extra></extra>",
      showlegend: false,
    });
  }

  // HOLD dots (sampled; rendered with text label like the screenshot)
  if (showHold && d.holds.length) {
    traces.push({
      type: "scatter", mode: "markers+text",
      x: d.holds.map(h => h.time),
      y: d.holds.map(h => h.price),
      marker: { symbol: "circle", size: 11, color: T.yellow,
                line: { width: 1, color: "#3b2f08" } },
      text: d.holds.map(_ => "HOLD"),
      textposition: "bottom center",
      textfont: { color: T.yellow, size: 10, family: "Inter, sans-serif" },
      hoverinfo: "x+y",
      showlegend: false,
    });
  }

  // dotted horizontal key-level (like the reference image)
  const shapes = [{
    type: "line", xref: "paper", x0: 0, x1: 1,
    y0: d.key_level, y1: d.key_level,
    line: { color: T.accent, width: 1, dash: "dot" },
  }];

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    shapes,
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, type: "date" },
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, title: "" },
  };

  Plotly.react("paChart", traces, layout,
               { displaylogo: false, responsive: true,
                 modeBarButtonsToRemove: ["lasso2d","select2d","autoScale2d"] });
}

function drawSignalLog(d) {
  const rows = [];
  for (const b of d.buys)  rows.push({ ...b, side: "BUY" });
  for (const s of d.sells) rows.push({ ...s, side: "SELL" });
  rows.sort((a,b) => a.time.localeCompare(b.time));
  const tbody = $("#paLog tbody");
  tbody.innerHTML = rows.length === 0
    ? `<tr><td colspan="8" class="muted">No signals fired in this window.</td></tr>`
    : rows.map(r => {
        const rr = (r.stop && r.target)
          ? (Math.abs(r.target - r.price) / Math.abs(r.price - r.stop)).toFixed(2)
          : "—";
        const cls = r.side === "BUY" ? "cell-buy" : "cell-sell";
        return `<tr>
          <td>${r.time.slice(0,16).replace("T"," ")}</td>
          <td class="${cls}">${r.side === "BUY" ? "🟢 BUY" : "🔴 SELL"}</td>
          <td class="${cls}">${r.confidence}%</td>
          <td>${fmt.num(r.price)}</td>
          <td>${fmt.num(r.stop)}</td>
          <td>${fmt.num(r.target)}</td>
          <td>${rr}</td>
          <td class="muted">${r.reason}</td>
        </tr>`;
      }).join("");
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: LIVE SIGNALS
   ══════════════════════════════════════════════════════════════ */
async function runLive() {
  const symbol   = $("#lvSymbol").value;
  const interval = $("#lvInterval").value;
  const r = await api(`/api/live-signals?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
  if (!r || r.error) return;
  const tb = $("#lvTable tbody");
  tb.innerHTML = r.rows.map(row => {
    const c = row.state === "BUY" ? "cell-buy" :
              row.state === "SELL" ? "cell-sell" : "cell-hold";
    const badge = row.state === "BUY" ? "🟢 BUY" :
                  row.state === "SELL" ? "🔴 SELL" : "⚪ HOLD";
    return `<tr>
      <td>${row.strategy}</td>
      <td class="${c}">${badge}</td>
      <td class="${c}">${row.confidence ? row.confidence + "%" : "—"}</td>
      <td>${fmt.num(row.entry)}</td>
      <td>${fmt.num(row.stop)}</td>
      <td>${fmt.num(row.target)}</td>
      <td class="muted">${row.reason || ""}</td>
    </tr>`;
  }).join("");
  $("#lvUpdated").textContent =
    `Last update: ${new Date().toLocaleTimeString()} · last price ${fmt.num(r.last_price)}`;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: BACKTEST
   ══════════════════════════════════════════════════════════════ */
async function runBacktest() {
  const body = {
    symbol:   $("#btSymbol").value,
    interval: $("#btInterval").value,
    days:     Math.max(5, Math.min(30, +$("#btDays").value || 15)),
    strategies: [],
  };
  $("#btRun").disabled = true;
  const r = await api("/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  $("#btRun").disabled = false;
  if (!r) return;

  // table
  const tb = $("#btTable tbody");
  tb.innerHTML = r.rows
    .sort((a,b) => (b.total_return ?? 0) - (a.total_return ?? 0))
    .map(row => `<tr>
      <td>${row.strategy}</td>
      <td>${row.trades}</td>
      <td>${fmt.pct(row.win_rate)}</td>
      <td class="${row.total_return>=0?'cell-buy':'cell-sell'}">${fmt.pct(row.total_return)}</td>
      <td>${fmt.num(row.sharpe)}</td>
      <td>${fmt.num(row.profit_factor)}</td>
      <td class="cell-sell">${fmt.pct(row.max_drawdown)}</td>
      <td>${row.days_5pct}</td>
    </tr>`).join("");

  // equity curves
  const traces = Object.entries(r.equity).map(([name, v]) => ({
    type: "scatter", mode: "lines",
    name, x: v.time, y: v.equity,
    line: { width: 1.5 },
    hovertemplate: `<b>${name}</b><br>%{x|%Y-%m-%d %H:%M}<br>₹%{y:,.0f}<extra></extra>`,
  }));
  const layout = {
    ...PLOTLY_LAYOUT_BASE, showlegend: true,
    legend: { orientation: "h", y: -0.15, font: { size: 10 } },
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, title: "Equity (₹)" },
    height: 460,
  };
  Plotly.react("btChart", traces, layout, { displaylogo: false, responsive: true });
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: SCREENER
   ══════════════════════════════════════════════════════════════ */
async function runScreener() {
  const n = +$("#scN").value || 5;
  const r = await api(`/api/screener?n=${n}`);
  if (!r) return;
  const tb = $("#scTable tbody");
  tb.innerHTML = r.rows.length === 0
    ? `<tr><td colspan="7" class="muted">No data.</td></tr>`
    : r.rows.map(row => `<tr>
        <td>${row.symbol}</td>
        <td>${fmt.num(row.last_close)}</td>
        <td class="${row.gap_pct>=0?'cell-buy':'cell-sell'}">${fmt.pct(row.gap_pct)}</td>
        <td>${fmt.num(row.vol_ratio)}</td>
        <td>${fmt.pct(row.atr_pct)}</td>
        <td class="muted">${row.recommended}</td>
        <td><b>${fmt.num(row.confidence,1)} / 10</b></td>
      </tr>`).join("");
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: OPTIMIZER
   ══════════════════════════════════════════════════════════════ */
async function runOptimizer() {
  const strategy = $("#opStrategy").value;
  // sensible mini-grids per strategy
  const grids = {
    OpeningRangeBreakout: { orb_minutes: [10,15,20], volume_confirm_mult: [1.5,2.0,2.5] },
    SupertrendEMAScalp:   { supertrend_period: [5,7,10], supertrend_mult: [2.0,3.0] },
    VWAPMomentumScalp:    { rsi_period: [7,9,14], target_pct: [0.01,0.015,0.02] },
    VolumeBreakout:       { consolidation_bars: [15,20,25], volume_mult: [2.0,2.5,3.0] },
    MasterConfluence:     { min_score: [4,5,6], atr_stop_mult: [1.0,1.5,2.0] },
  };
  const grid = grids[strategy] || grids.OpeningRangeBreakout;
  const body = {
    symbol: $("#opSymbol").value,
    interval: "5m",
    days: +$("#opDays").value || 15,
    strategy,
    grid,
  };
  $("#opRun").disabled = true;
  const r = await api("/api/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  $("#opRun").disabled = false;
  if (!r) return;

  const wf = r.walk_forward;
  $("#opSharpe").textContent  = fmt.num(wf.test_metrics.sharpe);
  $("#opTestRet").textContent = fmt.pct(wf.test_metrics.total_return);
  $("#opTestN").textContent   = wf.test_metrics.total_trades;
  $("#opParams").textContent  = Object.entries(wf.best_params)
                                   .map(([k,v]) => `${k}=${v}`).join("  ");

  // dynamic table
  if (r.grid.length) {
    const cols = Object.keys(grid).concat(["sharpe","total_return","total_trades","win_rate"]);
    $("#opHead").innerHTML = cols.map(c => `<th>${c}</th>`).join("");
    $("#opTable tbody").innerHTML = r.grid.slice(0, 20).map(row => {
      return "<tr>" + cols.map(c => {
        const v = row[c];
        if (c === "total_return" || c === "win_rate") return `<td>${fmt.pct(v)}</td>`;
        if (c === "sharpe")                            return `<td>${fmt.num(v)}</td>`;
        return `<td>${v ?? "—"}</td>`;
      }).join("") + "</tr>";
    }).join("");
  }
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: BATTLE PLAN
   ══════════════════════════════════════════════════════════════ */
function runBattleRefresh() {
  api("/api/screener?n=5").then(r => {
    if (!r) return;
    $("#bpTable tbody").innerHTML = r.rows.map(row => `<tr>
      <td>${row.symbol}</td>
      <td>${fmt.num(row.last_close)}</td>
      <td class="${row.gap_pct>=0?'cell-buy':'cell-sell'}">${fmt.pct(row.gap_pct)}</td>
      <td>${fmt.num(row.vol_ratio)}</td>
      <td>${fmt.pct(row.atr_pct)}</td>
      <td class="muted">${row.recommended}</td>
      <td><b>${fmt.num(row.confidence,1)} / 10</b></td>
    </tr>`).join("");
  });
  redrawBattleStats();
}

function addTrade() {
  const sym   = $("#bpTrSym").value.trim() || "SYM";
  const strat = $("#bpTrStrat").value;
  const pnl   = +$("#bpTrPnl").value || 0;
  state.trades.push({ time: new Date(), sym, strat, pnl });
  $("#bpTrPnl").value = 0;
  redrawBattleStats();
}

function redrawBattleStats() {
  const cap = META.config.capital;
  const totalPnl = state.trades.reduce((a,t) => a + t.pnl, 0);
  const pct      = totalPnl / cap;
  const target   = META.config.daily_target;
  const maxLoss  = META.config.max_daily_loss;

  // pnl card
  $("#bpPnl").innerHTML = (totalPnl>=0 ? "+" : "−") + "₹" +
    Math.abs(Math.round(totalPnl)).toLocaleString() +
    `<span class="muted small" style="font-weight:400">  (${fmt.signed(pct*100)} %)</span>`;
  $("#bpPnl").style.color = totalPnl > 0 ? T.green : totalPnl < 0 ? T.red : T.text;

  // progress bar
  const progress = Math.max(0, Math.min(1, totalPnl / (cap * target)));
  $("#bpProgress").style.width = (progress * 100).toFixed(1) + "%";
  $("#bpProgressLabel").textContent = (progress * 100).toFixed(1) + " % of +5 % target";

  // remaining risk
  const remaining = Math.max(0, cap * maxLoss + totalPnl);
  $("#bpRisk").textContent = "₹" + Math.round(remaining).toLocaleString();

  // status
  let status = "🟢 LIVE";
  if (pct >=  target)  status = "🛑 +5% HALTED";
  if (pct <= -maxLoss) status = "🛑 -2% HALTED";
  const consecLoss = state.trades.slice(-3).every(t => t.pnl < 0);
  if (state.trades.length >= 3 && consecLoss) status = "🛑 3 consec losses";
  $("#bpStatus").textContent = status;

  // trade log
  $("#bpTrLog tbody").innerHTML = state.trades.slice().reverse().map(t => `<tr>
    <td>${t.time.toLocaleTimeString()}</td>
    <td>${t.sym}</td>
    <td>${t.strat}</td>
    <td class="${t.pnl>=0?'cell-buy':'cell-sell'}">₹${(t.pnl>=0?"+":"")}${Math.round(t.pnl).toLocaleString()}</td>
  </tr>`).join("");
}
