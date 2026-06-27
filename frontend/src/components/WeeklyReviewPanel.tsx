import { useState } from "react";
import { api } from "../lib/api";

interface Review {
  sinceIso: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  biggestWin: { symbol: string; pnl: number; exitAt: string } | null;
  biggestLoss: { symbol: string; pnl: number; exitAt: string } | null;
  topTag: { tag: string; count: number; pnl: number } | null;
  symbols: Array<{ symbol: string; trades: number; pnl: number }>;
  lessons: string[];
  trades: Array<{ symbol: string; side: string; pnl: number; pnlPct: number; exitReason: string; exitAt: string }>;
}

const fmtINR = (n: number, signed = false) => `${signed && n > 0 ? "+" : ""}₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function WeeklyReviewPanel() {
  const [r, setR] = useState<Review | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    try {
      const { data } = await api.get("/api/portfolio-analytics/weekly-review");
      setR(data as Review);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500">Weekly review</div>
          <div className="text-[10px] text-slate-500">Auto-summary of the last 7 days of closed trades.</div>
        </div>
        <div className="flex gap-2">
          <button onClick={generate} disabled={loading} className="bg-accent-info text-white text-xs rounded-md px-3 py-1.5 font-semibold disabled:opacity-50">
            {loading ? "Generating…" : r ? "Refresh" : "Generate"}
          </button>
          {r && (
            <button onClick={() => window.print()} className="border border-bg-border text-slate-300 hover:text-white text-xs rounded-md px-3 py-1.5">
              Print PDF
            </button>
          )}
        </div>
      </div>

      {r && (
        <div className="space-y-3 weekly-review-printable">
          <h2 className="hidden print:block text-lg font-semibold text-white">QTI Weekly Review</h2>
          <div className="hidden print:block text-xs text-slate-400">Since {new Date(r.sinceIso).toLocaleString()}</div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            <Stat label="Trades" value={String(r.totalTrades)} />
            <Stat label="Wins / Losses" value={`${r.wins} / ${r.losses}`} />
            <Stat label="Win rate" value={`${(r.winRate * 100).toFixed(1)}%`} tone={r.winRate >= 0.5 ? "buy" : "sell"} />
            <Stat label="Total P&L" value={fmtINR(r.totalPnl, true)} tone={r.totalPnl >= 0 ? "buy" : "sell"} />
            <Stat label="Top tag" value={r.topTag ? r.topTag.tag : "—"} sub={r.topTag ? `${r.topTag.count}×` : ""} />
          </div>

          {r.biggestWin && (
            <div className="text-xs"><span className="text-slate-500">Biggest win:</span> <span className="text-accent-buy font-mono">{r.biggestWin.symbol} {fmtINR(r.biggestWin.pnl, true)}</span> on {new Date(r.biggestWin.exitAt).toLocaleDateString()}</div>
          )}
          {r.biggestLoss && (
            <div className="text-xs"><span className="text-slate-500">Biggest loss:</span> <span className="text-accent-sell font-mono">{r.biggestLoss.symbol} {fmtINR(r.biggestLoss.pnl, true)}</span> on {new Date(r.biggestLoss.exitAt).toLocaleDateString()}</div>
          )}

          {r.lessons.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Observations</div>
              <ul className="space-y-1 text-xs text-slate-300 list-disc list-inside">
                {r.lessons.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </div>
          )}

          {r.symbols.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">By symbol</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-xs font-mono">
                {r.symbols.map((s) => (
                  <div key={s.symbol} className="flex justify-between bg-bg-elevated/40 rounded px-2 py-1">
                    <span className="text-slate-300">{s.symbol}</span>
                    <span className={s.pnl >= 0 ? "text-accent-buy" : "text-accent-sell"}>{fmtINR(s.pnl, true)} <span className="text-slate-500">×{s.trades}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!r && !loading && (
        <div className="text-xs text-slate-400">Click <span className="text-white">Generate</span> to build a printable review of this week's trades.</div>
      )}

      <style>{`
        @media print {
          body { background: white !important; color: black !important; }
          .weekly-review-printable { page-break-inside: avoid; }
          .bg-bg-panel-solid\\/70 { background: white !important; }
          .text-white, .text-slate-200, .text-slate-300 { color: black !important; }
        }
      `}</style>
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: "buy" | "sell"; sub?: string }) {
  const cls = tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-white";
  return (
    <div className="bg-bg-elevated/40 rounded-lg px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono ${cls}`}>{value}{sub && <span className="text-slate-500 text-[10px] ml-1">{sub}</span>}</div>
    </div>
  );
}
