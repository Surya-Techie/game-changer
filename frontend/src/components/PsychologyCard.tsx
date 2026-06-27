export default function PsychologyCard() {
  return (
    <div className="bg-bg-panel border border-bg-border rounded-xl p-5">
      <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Trading Psychology</div>
      <ul className="text-sm text-slate-300 space-y-2">
        <Item ok>No overtrading detected (0 trades in last hour)</Item>
        <Item ok>Within daily loss limit</Item>
        <Item ok>Position sizing in normal range</Item>
      </ul>
      <div className="mt-4 text-[11px] text-slate-500 leading-relaxed">
        Behaviour analysis activates once you start placing live orders. It tracks frequency, lot-size escalation, and
        post-loss revenge trades.
      </div>
    </div>
  );
}

function Item({ children, ok }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      <span className={ok ? "text-accent-buy" : "text-accent-sell"}>●</span>
      <span>{children}</span>
    </li>
  );
}
