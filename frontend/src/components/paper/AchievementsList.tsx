import clsx from "clsx";
import type { Badge } from "../../lib/paperApi";

export default function AchievementsList({ badges }: { badges: Badge[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
      {badges.map((b) => (
        <div
          key={b.id}
          className={clsx(
            "border rounded-lg p-3 flex flex-col gap-1 transition-colors",
            b.earned
              ? "bg-accent-buy/10 border-accent-buy/40"
              : "bg-bg-elevated/40 border-bg-border opacity-60"
          )}
        >
          <div className="text-xl">{b.icon}</div>
          <div className="text-sm font-semibold text-white">{b.label}</div>
          <div className="text-[11px] text-slate-400">{b.description}</div>
          {b.progress && <div className="text-[10px] text-slate-500 font-mono mt-auto">{b.progress}</div>}
          {b.earned && <div className="text-[10px] uppercase tracking-wider text-accent-buy">Earned</div>}
        </div>
      ))}
    </div>
  );
}
