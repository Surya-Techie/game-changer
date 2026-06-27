import { AnimatePresence, motion } from "framer-motion";

interface Props {
  open: boolean;
  onClose: () => void;
}

const ROWS: Array<[string, string]> = [
  ["Ctrl + K  /  ⌘K", "Open command palette (pages + symbol search)"],
  ["?", "Show this shortcut sheet"],
  ["1 – 9", "Switch to symbol N of your watchlist"],
  ["G then D", "Go to Dashboard"],
  ["G then W", "Go to Watchlist"],
  ["G then S", "Go to Scanner"],
  ["G then H", "Go to Signal History"],
  ["G then P", "Go to Portfolio"],
  ["G then B", "Go to Backtest"],
  ["G then A", "Go to Alerts"],
  ["G then ,", "Go to Settings"],
  ["Esc", "Close any open modal / palette"],
  ["—", "— Paper trading order terminal —"],
  ["B", "Toggle BUY / LONG direction"],
  ["S", "Toggle SELL / SHORT direction"],
  ["M", "Switch to MARKET order type"],
  ["L", "Switch to LIMIT order type"],
];

export default function ShortcutsHelp({ open, onClose }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg z-50 bg-bg-panel-solid border border-bg-border rounded-xl shadow-2xl p-6"
          >
            <div className="flex justify-between items-center mb-4">
              <div className="text-sm uppercase tracking-wider text-slate-500">Keyboard shortcuts</div>
              <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <div className="space-y-2 text-sm">
              {ROWS.map(([keys, desc]) => (
                <div key={keys} className="flex justify-between">
                  <kbd className="font-mono text-xs bg-bg-elevated px-2 py-1 rounded border border-bg-border text-slate-200">{keys}</kbd>
                  <span className="text-slate-400 ml-3">{desc}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 text-[10px] text-slate-500">Press ? anytime to reopen this.</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
