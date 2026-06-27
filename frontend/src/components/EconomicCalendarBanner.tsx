import { useEffect, useState } from "react";
import clsx from "clsx";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

interface EconEvent {
  date: string;
  timeLocal: string;
  country: "IN" | "US";
  name: string;
  importance: "HIGH" | "MEDIUM" | "LOW";
  forecast?: string;
}

export default function EconomicCalendarBanner() {
  const [events, setEvents] = useState<EconEvent[]>([]);

  useEffect(() => {
    void api.get("/api/calendar/today").then(({ data }) => setEvents((data.events ?? []) as EconEvent[]));
  }, []);

  const high = events.filter((e) => e.importance === "HIGH");
  if (high.length === 0) return null;

  return (
    <div className="bg-accent-hold/10 border border-accent-hold/40 rounded-lg px-4 py-2 flex flex-wrap items-center gap-3 text-xs">
      <span className="font-bold text-accent-hold">⚠ Today</span>
      {high.slice(0, 3).map((e, i) => (
        <span key={i} className="text-slate-200">
          <span className={clsx("inline-block px-1.5 py-0.5 rounded text-[10px] font-mono mr-1.5",
            e.country === "IN" ? "bg-accent-info/15 text-accent-info" : "bg-accent-sell/10 text-accent-sell"
          )}>{e.country}</span>
          {e.name} <span className="text-slate-500">· {e.timeLocal}</span>
        </span>
      ))}
      <Link to="/calendar" className="ml-auto text-accent-info hover:text-white">View full calendar →</Link>
    </div>
  );
}
