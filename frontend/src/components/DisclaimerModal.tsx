import { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";

const STORAGE_KEY = "qti:disclaimer:accepted-v1";

/**
 * SEBI requires any platform showing trade signals to a retail audience to
 * carry an unambiguous "not investment advice" notice and require explicit
 * acknowledgement before use. We persist the acknowledgement in
 * localStorage so it surfaces once per browser, not on every page load.
 */
export default function DisclaimerModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setOpen(true);
    } catch {
      // privacy mode / disabled storage — show the modal every load
      setOpen(true);
    }
  }, []);

  const accept = () => {
    try { localStorage.setItem(STORAGE_KEY, new Date().toISOString()); } catch { /* */ }
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="max-w-xl w-full bg-bg-panel-solid border border-bg-border rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-bg-border flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-accent-sell/20 flex items-center justify-center">
            <AlertTriangle className="h-5 w-5 text-accent-sell" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Before you continue</h2>
            <p className="text-xs text-slate-400">Quick Trade Insights · risk acknowledgement</p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-3 text-sm text-slate-300 leading-relaxed">
          <p>
            QTI shows pattern detections, ML predictions, and trade ideas for
            <span className="text-white font-semibold"> educational and research purposes only</span>.
            It is <span className="text-accent-sell font-semibold">not investment advice</span> and is
            not a substitute for guidance from a SEBI-registered advisor.
          </p>
          <p>
            Trading equities, F&amp;O, and other instruments carries substantial risk of loss.
            Past performance — including backtest results and "historical win rates" shown in this app —
            does not guarantee future results.
          </p>
          <p>
            Any orders placed through connected brokers are your responsibility. Verify every signal
            independently before acting on it. The authors of this software accept no liability for
            trading losses incurred through its use.
          </p>
        </div>

        <div className="px-6 py-4 bg-bg-elevated/40 border-t border-bg-border flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-500 flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Stored locally — shown once per browser
          </span>
          <button
            onClick={accept}
            className="px-5 py-2 bg-accent-buy hover:bg-accent-buy/80 text-white font-bold text-sm rounded-lg transition-colors"
          >
            I understand &amp; accept
          </button>
        </div>
      </div>
    </div>
  );
}
