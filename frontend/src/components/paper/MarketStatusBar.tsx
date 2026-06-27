import clsx from "clsx";
import { useEffect, useState } from "react";
import { paperApi, type MarketStatusResp } from "../../lib/paperApi";

export default function MarketStatusBar() {
  const [status, setStatus] = useState<MarketStatusResp | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => paperApi.marketStatus().then((s) => !cancelled && setStatus(s)).catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!status) return null;
  const dot = clsx("w-2 h-2 rounded-full inline-block", {
    "bg-emerald-400 animate-pulse": status.state === "OPEN",
    "bg-amber-400": status.state === "PRE_OPEN",
    "bg-rose-500": status.state === "CLOSED",
  });

  return (
    <div className="text-xs text-slate-300 flex items-center gap-2 font-mono">
      <span className={dot} />
      {status.state === "OPEN" && (
        <span>
          MARKET OPEN <span className="text-slate-500">— {status.istNow} IST</span>
          {status.minutesToClose != null && (
            <span className={clsx("ml-2", status.minutesToClose <= 10 && "text-amber-400")}>
              closes in {status.minutesToClose} min
            </span>
          )}
        </span>
      )}
      {status.state === "PRE_OPEN" && (
        <span>
          PRE-MARKET <span className="text-slate-500">— {status.istNow} IST</span>
          {status.minutesToOpen != null && <span className="ml-2">opens in {status.minutesToOpen} min</span>}
        </span>
      )}
      {status.state === "CLOSED" && (
        <span>
          MARKET CLOSED <span className="text-slate-500">— {status.istNow} IST</span>
          {status.isHoliday && <span className="ml-2 text-amber-400">NSE holiday</span>}
        </span>
      )}
    </div>
  );
}
