import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import PaperBanner from "../components/paper/PaperBanner";
import { AreaLineChart, PnlBars, DistributionHistogram, HeatGrid } from "../components/paper/charts";
import AchievementsList from "../components/paper/AchievementsList";
import { paperApi, backtestApi, type AnalyticsBundle, type Badge } from "../lib/paperApi";

export default function PaperAnalyticsPage() {
  const [data, setData] = useState<AnalyticsBundle | null>(null);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [vsBacktest, setVsBacktest] = useState<{ paper: { totalPnl: number; winRate: number; trades: number; avgHoldMins: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [a, b, vb] = await Promise.all([
          paperApi.analytics(),
          paperApi.achievements(),
          paperApi.vsBacktest(),
        ]);
        setData(a);
        setBadges(b);
        setVsBacktest(vb);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-app-radial text-slate-200">
      <PaperBanner />
      <Topbar symbol="Analytics" wsStatus="open" />
      <div className="flex-1 flex">
        <Sidebar symbols={[]} prices={{}} prevPrices={{}} active="" onSelect={() => {}} />
        <main className="flex-1 p-4 space-y-4 min-w-0">
          <PaperSubNav active="analytics" />
          {err && <div className="text-rose-400 text-sm">{err}</div>}
          {!data ? (
            <div className="text-slate-500 text-sm">Loading analytics…</div>
          ) : data.summary.totalTrades === 0 ? (
            <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-10 text-center space-y-3">
              <div className="text-5xl">📊</div>
              <div className="text-lg text-white">No paper trades to analyse yet</div>
              <div className="text-sm text-slate-400 max-w-md mx-auto">
                Place at least one paper trade and close it (manually or via SL/TP) to see your
                equity curve, drawdown, win-rate, profit factor, Sharpe ratio, hour-of-day heatmap,
                and behavior analytics here.
              </div>
              <Link to="/paper" className="inline-block mt-2 bg-accent-info text-white text-sm px-4 py-2 rounded">
                Open the trading terminal →
              </Link>
            </div>
          ) : (
            <>
              <SummaryCards data={data} />

              <Section title="Equity Curve">
                <AreaLineChart
                  data={data.equityCurve.map((p, i) => ({ x: i, y: p.equity }))}
                  baseline={data.summary.startingCapital}
                  height={200}
                />
              </Section>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Section title="Daily P&L (last 30 days)">
                  <PnlBars data={data.dailyPnl.map((p) => ({ label: p.date, value: p.pnl }))} />
                </Section>
                <Section title="Drawdown %">
                  <AreaLineChart
                    data={data.drawdown.series.map((p, i) => ({ x: i, y: -p.ddPct }))}
                    height={160}
                    positiveColor="#ea3943"
                    negativeColor="#ea3943"
                  />
                  <div className="text-xs text-slate-400 mt-1">
                    Max drawdown: <span className="text-rose-400 font-mono">-{data.drawdown.maxDrawdownPct.toFixed(2)}%</span>
                  </div>
                </Section>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Section title="Trade P&L Distribution">
                  <DistributionHistogram bins={data.distribution.bins} />
                </Section>
                <Section title="P&L by Symbol">
                  <BySymbolTable rows={data.bySymbol} />
                </Section>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Section title="P&L by Hour (IST)">
                  <HeatGrid
                    cols={7}
                    cells={data.byHour.map((h) => ({ label: `${h.hour}:00`, value: h.pnl }))}
                  />
                </Section>
                <Section title="P&L by Weekday">
                  <PnlBars data={data.byWeekday.map((d) => ({ label: d.weekday, value: d.pnl }))} />
                </Section>
              </div>

              <Section title="Strategy Breakdown">
                <StrategyTable rows={data.byStrategy} />
              </Section>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <Section title="Advanced Metrics">
                  <Advanced data={data.advanced} streaks={data.streaks} />
                </Section>
                <Section title="Behavior">
                  <Behavior data={data.behavior} />
                </Section>
                <Section title="Paper vs AI Backtest">
                  <VsBacktest paper={vsBacktest?.paper} />
                </Section>

                <Section title="Leaderboard (last 30d, % return)">
                  <LeaderboardSection />
                </Section>

                <Section title="Export">
                  <ExportSection />
                </Section>
              </div>

              <Section title="Achievements">
                <AchievementsList badges={badges} />
              </Section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export function PaperSubNav({ active }: { active: "trade" | "analytics" | "journal" }) {
  const items: { key: typeof active; label: string; to: string }[] = [
    { key: "trade", label: "Trade", to: "/paper" },
    { key: "analytics", label: "Analytics", to: "/paper/analytics" },
    { key: "journal", label: "Journal", to: "/paper/journal" },
  ];
  return (
    <div className="flex gap-2 border-b border-bg-border">
      {items.map((i) => (
        <Link
          key={i.key}
          to={i.to}
          className={`px-3 py-2 text-sm ${
            active === i.key ? "text-white border-b-2 border-accent-info" : "text-slate-400 hover:text-white"
          }`}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-panel-solid/60 border border-bg-border rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">{title}</div>
      {children}
    </div>
  );
}

function SummaryCards({ data }: { data: AnalyticsBundle }) {
  const s = data.summary;
  const cards: { label: string; value: string; cls?: string }[] = [
    { label: "Starting Capital", value: `₹${s.startingCapital.toLocaleString("en-IN")}` },
    { label: "Current Equity", value: `₹${s.currentEquity.toLocaleString("en-IN")}` },
    { label: "Total P&L", value: `${s.totalPnl >= 0 ? "+" : ""}₹${s.totalPnl.toLocaleString("en-IN")} (${s.totalPnlPct >= 0 ? "+" : ""}${s.totalPnlPct.toFixed(2)}%)`, cls: s.totalPnl >= 0 ? "text-accent-buy" : "text-accent-sell" },
    { label: "Win Rate", value: `${s.winRate.toFixed(1)}%` },
    { label: "Profit Factor", value: s.profitFactor.toFixed(2) },
    { label: "Max Drawdown", value: `-${data.drawdown.maxDrawdownPct.toFixed(2)}%`, cls: "text-rose-400" },
    { label: "Trades", value: String(s.totalTrades) },
    { label: "Expectancy", value: `₹${s.expectancy.toFixed(0)}` },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
      {cards.map((c) => (
        <div key={c.label} className="bg-bg-elevated/40 border border-bg-border rounded p-2">
          <div className="text-[10px] uppercase text-slate-500">{c.label}</div>
          <div className={`text-sm font-mono text-white ${c.cls ?? ""}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function BySymbolTable({ rows }: { rows: AnalyticsBundle["bySymbol"] }) {
  if (rows.length === 0) return <div className="text-xs text-slate-500">No trades</div>;
  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-[10px] uppercase text-slate-500">
        <tr><th className="text-left py-1">Symbol</th><th>Trades</th><th>Win %</th><th className="text-right">P&L</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.symbol} className="border-t border-bg-border">
            <td className="py-1 text-white">{r.symbol}</td>
            <td className="text-center">{r.trades}</td>
            <td className="text-center">{r.winRate.toFixed(0)}%</td>
            <td className={`text-right ${r.pnl > 0 ? "text-accent-buy" : "text-accent-sell"}`}>
              {r.pnl >= 0 ? "+" : ""}₹{r.pnl.toFixed(0)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StrategyTable({ rows }: { rows: AnalyticsBundle["byStrategy"] }) {
  if (rows.length === 0) return <div className="text-xs text-slate-500">Tag your trades with a strategy to see breakdown here.</div>;
  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-[10px] uppercase text-slate-500">
        <tr>
          <th className="text-left py-1">Strategy</th>
          <th>Trades</th>
          <th>Win %</th>
          <th>Avg Win</th>
          <th>Avg Loss</th>
          <th>Profit Factor</th>
          <th className="text-right">P&L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.strategy} className="border-t border-bg-border">
            <td className="py-1 text-white">{r.strategy}</td>
            <td className="text-center">{r.trades}</td>
            <td className="text-center">{r.winRate.toFixed(0)}%</td>
            <td className="text-center text-accent-buy">₹{r.avgWin.toFixed(0)}</td>
            <td className="text-center text-accent-sell">₹{r.avgLoss.toFixed(0)}</td>
            <td className="text-center">{r.profitFactor.toFixed(2)}</td>
            <td className={`text-right ${r.pnl > 0 ? "text-accent-buy" : "text-accent-sell"}`}>
              {r.pnl >= 0 ? "+" : ""}₹{r.pnl.toFixed(0)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Advanced({ data, streaks }: { data: AnalyticsBundle["advanced"]; streaks: AnalyticsBundle["streaks"] }) {
  const rows = [
    ["Sharpe Ratio", data.sharpe.toFixed(2)],
    ["Sortino", data.sortino.toFixed(2)],
    ["Calmar", data.calmar.toFixed(2)],
    ["SQN", data.sqn.toFixed(2)],
    ["Kelly %", data.kelly.toFixed(1)],
    ["Recovery Factor", data.recoveryFactor.toFixed(2)],
    ["Max Win Streak", String(streaks.maxWinStreak)],
    ["Max Loss Streak", String(streaks.maxLossStreak)],
  ];
  return (
    <div className="space-y-1 text-xs font-mono">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between border-b border-bg-border py-1">
          <span className="text-slate-400">{k}</span>
          <span className="text-white">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Behavior({ data }: { data: AnalyticsBundle["behavior"] }) {
  const longer = data.avgHoldMinsWin > data.avgHoldMinsLoss;
  return (
    <div className="space-y-2 text-xs">
      <div>
        <div className="text-slate-500">Avg hold (winners vs losers)</div>
        <div className="font-mono text-white">
          {data.avgHoldMinsWin}m vs {data.avgHoldMinsLoss}m
          <span className={`ml-2 ${longer ? "text-accent-buy" : "text-amber-400"}`}>
            {longer ? "letting winners run ✓" : "cutting winners early ✗"}
          </span>
        </div>
      </div>
      <div>
        <div className="text-slate-500">Overtrading days</div>
        <div className="font-mono text-white">
          {data.overtradingDays} {data.overtradingDays > 0 && <span className="text-amber-400 ml-1">(&gt;10 trades/day)</span>}
        </div>
      </div>
      <div>
        <div className="text-slate-500">Revenge trades</div>
        <div className="font-mono text-white">
          {data.revengeTrades} {data.revengeTrades > 0 && <span className="text-rose-400 ml-1">(within 5m of SL)</span>}
        </div>
      </div>
    </div>
  );
}

function VsBacktest({ paper }: { paper?: { totalPnl: number; winRate: number; trades: number; avgHoldMins: number } }) {
  const [symbol, setSymbol] = useState<string>("RELIANCE");
  const [bt, setBt] = useState<{ summary?: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const r = await backtestApi.run({ symbol, capital: 1_000_000, bars: 500 });
      setBt(r);
    } catch (e) {
      setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Backtest failed");
    } finally {
      setBusy(false);
    }
  }

  if (!paper) return <div className="text-xs text-slate-500">Loading…</div>;
  const btSummary = bt?.summary ?? {};
  return (
    <div className="space-y-2 text-xs">
      <div className="flex gap-2 items-center text-xs">
        <span className="text-slate-500">Compare against AI backtest on</span>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-white w-24 font-mono"
        />
        <button onClick={run} disabled={busy} className="bg-accent-info/80 text-white text-xs px-3 py-1 rounded disabled:opacity-50">
          {busy ? "…" : "Run"}
        </button>
      </div>
      {err && <div className="text-rose-400">{err}</div>}
      <table className="w-full font-mono">
        <thead className="text-[10px] uppercase text-slate-500">
          <tr><th className="text-left py-1">Metric</th><th className="text-right">You</th><th className="text-right">AI Backtest</th></tr>
        </thead>
        <tbody>
          <CompareRow label="Trades" you={String(paper.trades)} bt={btSummary.trades != null ? String(btSummary.trades) : "—"} />
          <CompareRow label="Win rate" you={`${paper.winRate.toFixed(1)}%`} bt={btSummary.winRate != null ? `${btSummary.winRate.toFixed(1)}%` : "—"} />
          <CompareRow label="Total P&L" you={`${paper.totalPnl >= 0 ? "+" : ""}₹${paper.totalPnl.toFixed(0)}`} bt={btSummary.totalPnl != null ? `${btSummary.totalPnl >= 0 ? "+" : ""}₹${btSummary.totalPnl.toFixed(0)}` : "—"} />
          <CompareRow label="Avg hold (m)" you={String(paper.avgHoldMins)} bt={btSummary.avgHoldMins != null ? String(btSummary.avgHoldMins) : "—"} />
        </tbody>
      </table>
    </div>
  );
}

function CompareRow({ label, you, bt }: { label: string; you: string; bt: string }) {
  return (
    <tr className="border-t border-bg-border">
      <td className="py-1 text-slate-400">{label}</td>
      <td className="py-1 text-right text-white">{you}</td>
      <td className="py-1 text-right text-slate-300">{bt}</td>
    </tr>
  );
}

function LeaderboardSection() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof paperApi.leaderboard>>["rows"]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    paperApi.leaderboard().then((r) => { setRows(r.rows); setLoading(false); }).catch(() => setLoading(false));
  }, []);
  if (loading) return <div className="text-xs text-slate-500">Loading…</div>;
  if (rows.length === 0) return <div className="text-xs text-slate-500">No paper traders with activity in the last 30 days.</div>;
  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-[10px] uppercase text-slate-500"><tr><th className="text-left py-1">#</th><th className="text-left">Trader</th><th className="text-right">Return %</th><th className="text-right">P&L</th><th className="text-right">Trades</th><th className="text-right">Win %</th><th className="text-right">Max DD</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.userId + r.accountName} className={`border-t border-bg-border ${r.isYou ? "bg-accent-info/10" : ""}`}>
            <td className="py-1 text-slate-400">{r.rank}</td>
            <td className="py-1 text-white">{r.displayName} <span className="text-slate-500">· {r.accountName}</span></td>
            <td className={`text-right ${r.returnPct >= 0 ? "text-accent-buy" : "text-accent-sell"}`}>{r.returnPct >= 0 ? "+" : ""}{r.returnPct.toFixed(2)}%</td>
            <td className={`text-right ${r.netPnl >= 0 ? "text-accent-buy" : "text-accent-sell"}`}>{r.netPnl >= 0 ? "+" : ""}₹{r.netPnl.toFixed(0)}</td>
            <td className="text-right">{r.trades}</td>
            <td className="text-right">{r.winRate.toFixed(0)}%</td>
            <td className="text-right text-slate-400">-{r.maxDrawdownPct.toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExportSection() {
  const [fy, setFy] = useState("");
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      // Use the JWT-bearing axios instance so the request is authenticated,
      // then materialise the response as a Blob and trigger a save dialog.
      const csv = await paperApi.exportTradesCsv(fy || undefined);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `qti-trades${fy ? `-${fy}` : ""}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-xs">
      <div className="text-slate-400">Download all paper trades as CSV (open in Excel / share with your CA).</div>
      <div className="flex items-center gap-2">
        <input
          value={fy}
          onChange={(e) => setFy(e.target.value)}
          placeholder="FY (e.g. 2025-26)"
          className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-white w-36"
        />
        <button
          onClick={download}
          disabled={busy}
          className="bg-accent-info/80 hover:bg-accent-info text-white text-xs px-3 py-1 rounded disabled:opacity-50"
        >
          {busy ? "…" : "Download CSV"}
        </button>
      </div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-elevated/40 border border-bg-border rounded p-2">
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className="text-white">{value}</div>
    </div>
  );
}
