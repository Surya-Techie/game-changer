import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { api } from "../lib/api";

interface EconEvent {
  date: string;
  timeLocal: string;
  country: "IN" | "US";
  name: string;
  importance: "HIGH" | "MEDIUM" | "LOW";
  previous?: string;
  forecast?: string;
  actual?: string | null;
}

export default function CalendarPage() {
  const [events, setEvents] = useState<EconEvent[]>([]);
  const [today, setToday] = useState("");
  const [note, setNote] = useState<string | undefined>();
  const [filter, setFilter] = useState<"ALL" | "IN" | "US">("ALL");
  const [minImpact, setMinImpact] = useState<"LOW" | "MEDIUM" | "HIGH">("LOW");

  useEffect(() => {
    void api.get("/api/calendar").then(({ data }) => {
      setEvents((data.upcoming ?? []) as EconEvent[]);
      setToday(data.today ?? "");
      setNote(data.note);
    });
  }, []);

  const grouped = useMemo(() => {
    const impactRank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    const minRank = impactRank[minImpact];
    const filtered = events.filter((e) => (filter === "ALL" || e.country === filter) && impactRank[e.importance] >= minRank);
    const byDate = new Map<string, EconEvent[]>();
    for (const e of filtered) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date)!.push(e);
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events, filter, minImpact]);

  return (
    <div className="min-h-full bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4">
        <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
        <h1 className="text-xl font-semibold text-white">Economic Calendar</h1>
        <div className="text-xs text-slate-500">Next 7 days · Indian + US events</div>
        {note && <div className="text-[10px] text-slate-500 mt-1">⚠ {note}</div>}
      </header>

      <main className="max-w-5xl mx-auto p-6 space-y-4">
        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-4 flex flex-wrap gap-3 items-center text-xs">
          <div className="flex gap-2">
            {(["ALL", "IN", "US"] as const).map((c) => (
              <button key={c} onClick={() => setFilter(c)} className={clsx("px-3 py-1 rounded-md border", filter === c ? "border-accent-info text-white bg-accent-info/10" : "border-bg-border text-slate-400")}>
                {c === "ALL" ? "Both" : c}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center text-slate-400">
            Min impact:
            {(["LOW", "MEDIUM", "HIGH"] as const).map((i) => (
              <button key={i} onClick={() => setMinImpact(i)} className={clsx("px-2 py-1 rounded text-[10px] font-bold border", minImpact === i ? "border-accent-info bg-accent-info/10 text-white" : "border-bg-border text-slate-500")}>{i}</button>
            ))}
          </div>
        </section>

        {grouped.length === 0 && <div className="text-sm text-slate-400">No events match the filter.</div>}

        {grouped.map(([date, list]) => (
          <section key={date} className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
            <div className={clsx("px-4 py-2 flex items-center justify-between text-sm",
              date === today ? "bg-accent-hold/15 text-accent-hold" : "bg-bg-elevated/40 text-slate-300"
            )}>
              <span className="font-semibold">{new Date(date).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
              {date === today && <span className="text-[10px] font-bold">TODAY</span>}
            </div>
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-1.5">Time</th>
                  <th className="text-left px-2 py-1.5">Country</th>
                  <th className="text-left px-2 py-1.5">Event</th>
                  <th className="text-center px-2 py-1.5">Impact</th>
                  <th className="text-right px-2 py-1.5">Previous</th>
                  <th className="text-right px-2 py-1.5">Forecast</th>
                  <th className="text-right px-2 py-1.5">Actual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {list.map((e, i) => (
                  <tr key={i}>
                    <td className="px-4 py-1.5 text-slate-400 font-mono">{e.timeLocal}</td>
                    <td className="px-2 py-1.5">
                      <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold",
                        e.country === "IN" ? "bg-accent-info/15 text-accent-info" : "bg-accent-sell/10 text-accent-sell"
                      )}>{e.country}</span>
                    </td>
                    <td className="px-2 py-1.5 text-slate-200">{e.name}</td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold",
                        e.importance === "HIGH" ? "bg-accent-sell/15 text-accent-sell" :
                        e.importance === "MEDIUM" ? "bg-accent-hold/15 text-accent-hold" :
                        "bg-slate-500/15 text-slate-400"
                      )}>{e.importance}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-slate-400 font-mono">{e.previous ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right text-slate-300 font-mono">{e.forecast ?? "—"}</td>
                    <td className={clsx("px-2 py-1.5 text-right font-mono", e.actual ? "text-white" : "text-slate-600")}>{e.actual ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </main>
    </div>
  );
}
