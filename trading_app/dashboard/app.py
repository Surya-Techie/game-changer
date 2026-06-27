"""
Trading Lab 📈 — Streamlit dashboard (5 pages).

Run:
    streamlit run trading_app/dashboard/app.py
"""
from __future__ import annotations

import sys
from datetime import datetime, time, timedelta
from pathlib import Path

# allow `python -m streamlit run ...` from project root
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np
import pandas as pd
import streamlit as st
import plotly.graph_objects as go

from trading_app import config
from trading_app.data.fetcher import fetch, to_ist
from trading_app.strategies import (
    ALL_STRATEGIES, STRAT_MAP, NUMBERED_STRATEGIES,
    OpeningRangeBreakout, VWAPMomentumScalp, GapAndGo,
    SupertrendEMAScalp, RSIDivergenceReversal, VolumeBreakout,
    MasterConfluence,
    SymmetricalTriangle, AscendingTriangle,
    RisingWedgeShort, DoubleTopMinor,
)
from trading_app.backtester.engine import Backtester
from trading_app.backtester.optimizer import grid_search, walk_forward
from trading_app.backtester.metrics import monte_carlo
from trading_app.screener.screener import top_picks
from trading_app.risk.risk_manager import IntradayRiskManager

# ── page setup ─────────────────────────────────────────────────
st.set_page_config(
    layout="wide",
    page_title="Trading Lab 📈",
    initial_sidebar_state="expanded",
)
T = config.THEME
st.markdown(f"""
<style>
.stApp {{ background-color:{T['bg']}; color:{T['text']}; }}
.metric-card {{ background:{T['card']}; padding:14px; border-radius:8px;
              border:1px solid #21262d; }}
.accent {{ color:{T['accent']}; font-weight:600; }}
h1, h2, h3 {{ color:{T['accent']}; }}
.stProgress > div > div {{ background-color:{T['accent']}; }}
</style>
""", unsafe_allow_html=True)


# (STRAT_MAP & NUMBERED_STRATEGIES come from trading_app.strategies)


# ── helper ─────────────────────────────────────────────────────
def _plotly_dark(fig):
    fig.update_layout(
        template="plotly_dark",
        paper_bgcolor=T["bg"],
        plot_bgcolor=T["card"],
        font=dict(color=T["text"]),
        margin=dict(l=10, r=10, t=40, b=10),
    )
    return fig


@st.cache_data(show_spinner=False, ttl=300)
def _cached_fetch(symbol, interval, days):
    df = fetch(symbol, interval=interval, days=days)
    return to_ist(df) if not df.empty else df


# ── sidebar nav ────────────────────────────────────────────────
PAGES = ["1 · Strategy Selector",
         "2 · Backtest Results",
         "3 · Live Signals",
         "4 · Optimizer",
         "5 · Daily Battle Plan",
         "6 · Pattern Analysis 🎯"]
page = st.sidebar.radio("Navigate", PAGES)
st.sidebar.markdown("---")
st.sidebar.caption(f"Capital: ₹{config.CAPITAL:,}  Target: +{config.DAILY_PROFIT_TARGET*100:.0f}%")


# ═════════════════════════════════════════════════════════════
# PAGE 1 — STRATEGY SELECTOR
# ═════════════════════════════════════════════════════════════
if page == PAGES[0]:
    st.title("📈 Strategy Selector & Backtest")

    c1, c2, c3 = st.columns(3)
    symbol = c1.selectbox(
        "Symbol", config.NSE_STOCKS + config.CRYPTO, index=0
    )
    interval = c2.selectbox("Timeframe", ["5m", "15m", "1h", "1d"], index=0)
    days = c3.slider("Lookback (days)", 5, 30, 15)

    st.markdown("**Pick strategies (or use all):**")
    cols = st.columns(4)
    selected = []
    for i, name in enumerate(STRAT_MAP):
        if cols[i % 4].checkbox(name, value=(i < 7)):
            selected.append(name)

    if st.button("▶ Run Backtest", use_container_width=True):
        df = _cached_fetch(symbol, interval, days)
        if df.empty or len(df) < 50:
            st.error("Not enough data.")
            st.stop()
        st.session_state["bt_df"]       = df
        st.session_state["bt_symbol"]   = symbol
        st.session_state["bt_strats"]   = selected
        results = {}
        prog = st.progress(0.0)
        for i, name in enumerate(selected):
            strat = STRAT_MAP[name]()
            sig   = strat.run(df)
            results[name] = Backtester().run(df, sig)
            prog.progress((i + 1) / max(len(selected), 1))
        st.session_state["bt_results"] = results
        st.success(f"Backtested {len(selected)} strategies on {len(df)} bars.")
        st.info("➡️ Switch to **Backtest Results** page to view.")


# ═════════════════════════════════════════════════════════════
# PAGE 2 — BACKTEST RESULTS
# ═════════════════════════════════════════════════════════════
elif page == PAGES[1]:
    st.title("📊 Backtest Results")

    if "bt_results" not in st.session_state:
        st.warning("Run a backtest from Page 1 first.")
        st.stop()

    results = st.session_state["bt_results"]
    df      = st.session_state["bt_df"]
    symbol  = st.session_state["bt_symbol"]

    # ── comparison table ──
    rows = []
    for name, r in results.items():
        m = r["metrics"]
        rows.append({
            "Strategy":     name,
            "Trades":       m["total_trades"],
            "Win %":        round(m["win_rate"]*100, 1),
            "Return %":     round(m["total_return"]*100, 2),
            "Sharpe":       round(m["sharpe"], 2),
            "Profit Factor": round(m["profit_factor"], 2),
            "Max DD %":     round(m["max_drawdown"]*100, 2),
            "5%-Days":      m["days_5pct"],
        })
    cmp = pd.DataFrame(rows).sort_values("Return %", ascending=False)
    st.dataframe(cmp, use_container_width=True, hide_index=True)

    # ── equity curves ──
    st.subheader("Equity Curves")
    fig = go.Figure()
    for name, r in results.items():
        fig.add_trace(go.Scatter(
            x=r["equity"].index, y=r["equity"].values,
            mode="lines", name=name, line=dict(width=2),
        ))
    fig.add_hline(y=config.CAPITAL, line_dash="dot",
                  line_color=T["text"], annotation_text="Start")
    fig.update_layout(height=420, yaxis_title="Equity (₹)")
    st.plotly_chart(_plotly_dark(fig), use_container_width=True)

    # ── drilldown ──
    pick = st.selectbox("Drill into strategy", list(results.keys()))
    r = results[pick]
    trades = r["trades"]
    eq     = r["equity"]
    peak   = eq.cummax()
    dd     = (eq - peak) / peak

    c1, c2 = st.columns(2)
    with c1:
        st.subheader("Drawdown")
        figd = go.Figure(go.Scatter(
            x=dd.index, y=dd.values*100, fill="tozeroy",
            line=dict(color=T["red"]),
        ))
        figd.update_layout(height=300, yaxis_title="DD %")
        st.plotly_chart(_plotly_dark(figd), use_container_width=True)

    with c2:
        st.subheader("Monte Carlo (500 runs)")
        mc = monte_carlo(trades, runs=500, capital=config.CAPITAL)
        st.metric("5th pct equity",   f"₹{mc['p5_final']:,.0f}")
        st.metric("Median final",     f"₹{mc['median_final']:,.0f}")
        st.metric("95th pct equity",  f"₹{mc['p95_final']:,.0f}")

    if not trades.empty:
        st.subheader("Trade Log")
        st.dataframe(
            trades[["entry_time","exit_time","side","entry_price",
                    "exit_price","qty","pnl","pnl_pct","reason_in","reason_out"]],
            use_container_width=True, hide_index=True,
        )


# ═════════════════════════════════════════════════════════════
# PAGE 3 — LIVE SIGNALS
# ═════════════════════════════════════════════════════════════
elif page == PAGES[2]:
    st.title("🔴 Live Signals (1-min delayed)")
    st.caption("Auto-refresh every 60 s. Data via yfinance.")

    c1, c2 = st.columns([2, 1])
    sym = c1.selectbox("Symbol", config.NSE_STOCKS + config.CRYPTO)
    interval = c2.selectbox("Timeframe", ["5m", "15m"], index=0)

    df = _cached_fetch(sym, interval, days=5)
    if df.empty:
        st.error("No data.")
        st.stop()

    last = df.iloc[-1]
    st.metric("Last Price",
              f"{last['close']:.2f}",
              f"{(last['close']/df['close'].iloc[-2] - 1)*100:.2f}%")

    st.subheader("Signal Board")
    rows = []
    for name, cls in STRAT_MAP.items():
        s   = cls()
        sig = s.run(df).iloc[-1]
        v   = int(sig["signal"])
        badge = "🟢 BUY" if v == 1 else "🔴 SELL" if v == -1 else "⚪ HOLD"
        rows.append({
            "Strategy":   name,
            "Signal":     badge,
            "Entry":      round(last["close"], 2) if v != 0 else "-",
            "Stop":       round(sig["stop"], 2)   if v != 0 and pd.notna(sig["stop"]) else "-",
            "Target":     round(sig["target"], 2) if v != 0 and pd.notna(sig["target"]) else "-",
            "Reason":     sig["reason"] or "—",
        })
    st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

    st.caption(f"Last update: {datetime.now():%Y-%m-%d %H:%M:%S}")
    # auto-refresh
    st.markdown(
        "<script>setTimeout(() => window.location.reload(), 60000);</script>",
        unsafe_allow_html=True,
    )


# ═════════════════════════════════════════════════════════════
# PAGE 4 — OPTIMIZER
# ═════════════════════════════════════════════════════════════
elif page == PAGES[3]:
    st.title("⚙️ Parameter Optimizer")

    c1, c2, c3 = st.columns(3)
    sym  = c1.selectbox("Symbol", config.NSE_STOCKS + config.CRYPTO)
    strat_name = c2.selectbox("Strategy", list(STRAT_MAP.keys()))
    days = c3.slider("Days", 5, 30, 15)

    strat_cls = STRAT_MAP[strat_name]
    default   = strat_cls().params

    st.markdown("**Grid (comma-separated values):**")
    grid_inputs = {}
    cols = st.columns(min(len(default), 4) or 1)
    for i, (k, v) in enumerate(default.items()):
        if isinstance(v, (int, float)):
            text = cols[i % len(cols)].text_input(k, value=str(v))
            try:
                vals = [type(v)(x.strip()) for x in text.split(",") if x.strip()]
                grid_inputs[k] = vals
            except Exception:
                pass

    if st.button("Run Grid Search", use_container_width=True):
        df = _cached_fetch(sym, "5m", days)
        if df.empty:
            st.error("No data.")
            st.stop()
        gs = grid_search(strat_cls, df, grid_inputs, target="sharpe")
        st.session_state["gs"] = gs

    if "gs" in st.session_state:
        gs = st.session_state["gs"]
        st.dataframe(gs.head(20), use_container_width=True)
        # heatmap on first two params
        param_cols = [c for c in gs.columns if c in grid_inputs]
        if len(param_cols) >= 2:
            piv = gs.pivot_table(index=param_cols[0], columns=param_cols[1],
                                 values="sharpe", aggfunc="mean")
            fig = go.Figure(go.Heatmap(
                z=piv.values, x=piv.columns, y=piv.index, colorscale="Viridis",
            ))
            fig.update_layout(title="Sharpe Heatmap")
            st.plotly_chart(_plotly_dark(fig), use_container_width=True)

        if st.button("Walk-Forward Best Params"):
            df = _cached_fetch(sym, "5m", days)
            wf = walk_forward(strat_cls, df, grid_inputs)
            st.json({"best_params": wf["best_params"],
                     "test_metrics": wf["test_metrics"]})


# ═════════════════════════════════════════════════════════════
# PAGE 5 — DAILY BATTLE PLAN
# ═════════════════════════════════════════════════════════════
elif page == PAGES[4]:
    st.title("⚔️ Daily Battle Plan")

    # ── pre-market screener ──
    st.subheader("🎯 Top-5 Pre-Market Picks")
    if st.button("Refresh Screener", use_container_width=False):
        st.session_state.pop("picks", None)

    if "picks" not in st.session_state:
        with st.spinner("Scanning universe…"):
            try:
                picks = top_picks(n=5)
            except Exception as e:
                picks = pd.DataFrame()
                st.error(f"Screener error: {e}")
        st.session_state["picks"] = picks
    picks = st.session_state.get("picks", pd.DataFrame())

    if not picks.empty:
        display = picks[["symbol","last_close","gap_pct","vol_ratio",
                         "atr_pct","sr_high","sr_low","recommended","confidence"]].copy()
        display["gap_pct"]   = (display["gap_pct"] * 100).round(2)
        display["atr_pct"]   = (display["atr_pct"] * 100).round(2)
        display["vol_ratio"] = display["vol_ratio"].round(2)
        display["confidence"] = display["confidence"].round(1)
        st.dataframe(display, use_container_width=True, hide_index=True)
    else:
        st.info("No screener data yet. Click Refresh.")

    st.markdown("---")

    # ── live P&L tracker (session-local) ──
    if "rm" not in st.session_state:
        st.session_state["rm"] = IntradayRiskManager()
    rm: IntradayRiskManager = st.session_state["rm"]

    st.subheader("📊 Daily P&L Tracker")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Daily P&L (₹)", f"{rm.daily_pnl:,.0f}",
              f"{rm.daily_pnl_pct()*100:.2f}%")
    c2.metric("Open Trades",   rm.open_trades)
    c3.metric("Consec Losses", rm.consec_losses)
    c4.metric("Status", "🛑 HALTED" if rm.halted else "🟢 LIVE")

    st.markdown("**🎯 Progress to +5% goal**")
    st.progress(rm.progress_to_target(),
                text=f"{rm.progress_to_target()*100:.1f}% of ₹{config.CAPITAL*config.DAILY_PROFIT_TARGET:,.0f}")

    st.markdown(f"**🛡 Remaining risk budget:** ₹{rm.remaining_risk_budget():,.0f}")
    if rm.halted:
        st.error(f"Trading halted: {rm.halted_reason}")

    # ── quick trade log entry ──
    with st.expander("➕ Log a trade"):
        ct1, ct2, ct3, ct4 = st.columns(4)
        sym_in = ct1.text_input("Symbol", "RELIANCE")
        strat_in = ct2.selectbox("Strategy", list(STRAT_MAP.keys()))
        pnl_in = ct3.number_input("P&L (₹)", -10000.0, 10000.0, 0.0, step=50.0)
        if ct4.button("Add"):
            rm.on_close(pnl_in, strategy=strat_in, symbol=sym_in, timestamp=datetime.now())
            st.rerun()

    # ── trade journal ──
    if rm.trades_today:
        st.subheader("📓 Today's Trade Journal")
        tj = pd.DataFrame([t.__dict__ for t in rm.trades_today])
        st.dataframe(tj, use_container_width=True, hide_index=True)

        # win rate by strategy
        wr = tj.groupby("strategy").apply(
            lambda g: pd.Series({
                "trades": len(g),
                "win%":   (g["pnl"] > 0).mean() * 100,
                "pnl":    g["pnl"].sum(),
            }),
            include_groups=False
        )
        st.subheader("Win Rate by Strategy")
        st.dataframe(wr.round(1), use_container_width=True)

        # heatmap by hour
        tj["hour"] = pd.to_datetime(tj["timestamp"]).dt.hour
        hb = tj.groupby("hour")["pnl"].sum().reset_index()
        fig = go.Figure(go.Bar(x=hb["hour"], y=hb["pnl"],
                               marker_color=T["accent"]))
        fig.update_layout(title="P&L by Hour", xaxis_title="Hour (IST)",
                          yaxis_title="₹")
        st.plotly_chart(_plotly_dark(fig), use_container_width=True)


# ═════════════════════════════════════════════════════════════
# PAGE 6 — PATTERN ANALYSIS
#          (click a strategy → see BUY/SELL/HOLD markers on candles)
# ═════════════════════════════════════════════════════════════
elif page == PAGES[5]:
    st.title("🎯 Pattern Analysis")
    st.caption("Pick any of the 11 strategies. The chart below overlays every "
               "BUY ▲ and SELL ▼ signal directly on the candles.")

    # ── inputs (single row, matches Page 1's look) ──
    c1, c2, c3, c4 = st.columns(4)
    pa_symbol  = c1.selectbox(
        "Symbol",
        config.NSE_STOCKS + config.CRYPTO,
        index=0,
        key="pa_sym",
    )
    pa_interval = c2.selectbox(
        "Timeframe", ["5m", "15m", "1h", "1d"], index=0, key="pa_int"
    )
    pa_days = c3.slider("Lookback (days)", 3, 30, 10, key="pa_days")
    pa_choice = c4.selectbox(
        "Strategy",
        [f"{num}: {label}" for (num, _, label) in NUMBERED_STRATEGIES],
        index=0,
        key="pa_strat",
    )
    # parse the chosen strategy
    chosen_idx = [f"{n}: {l}" for (n, _, l) in NUMBERED_STRATEGIES].index(pa_choice)
    chosen_num, chosen_cls_name, chosen_label = NUMBERED_STRATEGIES[chosen_idx]
    show_hold = st.checkbox(
        "Also show HOLD dots on every bar", value=False, key="pa_hold"
    )

    # ── fetch & run ──
    df = _cached_fetch(pa_symbol, pa_interval, pa_days)
    if df is None or df.empty or len(df) < 50:
        st.error("Not enough data for this symbol/timeframe.")
        st.stop()

    StratCls = STRAT_MAP[chosen_cls_name]
    strat    = StratCls()
    sig      = strat.run(df)

    # join price + signals
    plot_df = df.join(sig, how="left").copy()
    plot_df["signal"] = plot_df["signal"].fillna(0).astype(int)

    # ── tally ──
    n_buy   = int((plot_df["signal"] ==  1).sum())
    n_sell  = int((plot_df["signal"] == -1).sum())
    n_hold  = int((plot_df["signal"] ==  0).sum())
    last_sig = plot_df["signal"].iloc[-1]
    last_lab = "🟢 BUY" if last_sig == 1 else "🔴 SELL" if last_sig == -1 else "⚪ HOLD"

    m1, m2, m3, m4 = st.columns(4)
    m1.metric("🟢 BUY signals",  n_buy)
    m2.metric("🔴 SELL signals", n_sell)
    m3.metric("⚪ HOLD bars",    n_hold)
    m4.metric("Last bar",        last_lab)

    # ── build the candle chart ──
    fig = go.Figure()

    # candles
    fig.add_trace(go.Candlestick(
        x=plot_df.index,
        open=plot_df["open"],
        high=plot_df["high"],
        low=plot_df["low"],
        close=plot_df["close"],
        name=pa_symbol,
        increasing=dict(line=dict(color=T["accent"]), fillcolor=T["accent"]),
        decreasing=dict(line=dict(color=T["red"]),    fillcolor=T["red"]),
        showlegend=False,
    ))

    # BUY markers (green ▲ below the bar's low)
    buys = plot_df[plot_df["signal"] == 1]
    if not buys.empty:
        fig.add_trace(go.Scatter(
            x=buys.index,
            y=buys["low"] * 0.998,
            mode="markers+text",
            marker=dict(symbol="triangle-up", size=14, color="#00ff88",
                        line=dict(width=1, color="white")),
            text=["BUY"] * len(buys),
            textposition="bottom center",
            textfont=dict(size=9, color="#00ff88"),
            name="BUY",
            customdata=np.column_stack([
                buys["stop"].fillna(0).values,
                buys["target"].fillna(0).values,
                buys["reason"].astype(str).values,
            ]),
            hovertemplate=(
                "<b>BUY</b><br>"
                "Time: %{x|%Y-%m-%d %H:%M}<br>"
                "Price: %{y:.2f}<br>"
                "Stop: %{customdata[0]:.2f}<br>"
                "Target: %{customdata[1]:.2f}<br>"
                "Reason: %{customdata[2]}<extra></extra>"
            ),
        ))

    # SELL markers (red ▼ above the bar's high)
    sells = plot_df[plot_df["signal"] == -1]
    if not sells.empty:
        fig.add_trace(go.Scatter(
            x=sells.index,
            y=sells["high"] * 1.002,
            mode="markers+text",
            marker=dict(symbol="triangle-down", size=14, color="#ff4d4d",
                        line=dict(width=1, color="white")),
            text=["SELL"] * len(sells),
            textposition="top center",
            textfont=dict(size=9, color="#ff4d4d"),
            name="SELL",
            customdata=np.column_stack([
                sells["stop"].fillna(0).values,
                sells["target"].fillna(0).values,
                sells["reason"].astype(str).values,
            ]),
            hovertemplate=(
                "<b>SELL</b><br>"
                "Time: %{x|%Y-%m-%d %H:%M}<br>"
                "Price: %{y:.2f}<br>"
                "Stop: %{customdata[0]:.2f}<br>"
                "Target: %{customdata[1]:.2f}<br>"
                "Reason: %{customdata[2]}<extra></extra>"
            ),
        ))

    # HOLD dots (only if user asks — can be 90 % of bars, very noisy)
    if show_hold:
        holds = plot_df[plot_df["signal"] == 0]
        fig.add_trace(go.Scatter(
            x=holds.index,
            y=(holds["high"] + holds["low"]) / 2,
            mode="markers",
            marker=dict(symbol="circle", size=3, color="#888888", opacity=0.35),
            name="HOLD",
            hovertemplate=(
                "<b>HOLD</b><br>"
                "Time: %{x|%Y-%m-%d %H:%M}<br>"
                "Price: %{y:.2f}<extra></extra>"
            ),
        ))

    fig.update_layout(
        height=620,
        xaxis_rangeslider_visible=False,
        title=f"{pa_symbol} · {pa_interval} · {chosen_num}: {chosen_label}",
        yaxis_title="Price",
        legend=dict(orientation="h", y=1.05),
    )
    st.plotly_chart(_plotly_dark(fig), use_container_width=True)

    # ── signal log table ──
    sig_rows = plot_df[plot_df["signal"] != 0].copy()
    if not sig_rows.empty:
        st.subheader("📋 Signal Log")
        out = pd.DataFrame({
            "Time":     sig_rows.index,
            "Signal":   sig_rows["signal"].map({1: "🟢 BUY", -1: "🔴 SELL"}),
            "Price":    sig_rows["close"].round(2),
            "Stop":     sig_rows["stop"].round(2),
            "Target":   sig_rows["target"].round(2),
            "Risk/Rwd": ((sig_rows["target"] - sig_rows["close"]).abs() /
                         (sig_rows["close"] - sig_rows["stop"]).abs()).round(2),
            "Reason":   sig_rows["reason"].astype(str),
        })
        st.dataframe(out, use_container_width=True, hide_index=True)
    else:
        st.info(f"No signals fired for {chosen_num} in this window. "
                "Try a longer lookback or a different symbol/timeframe.")
