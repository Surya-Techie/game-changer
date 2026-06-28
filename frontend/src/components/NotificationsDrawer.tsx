import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";

export interface Notification {
  id: string;
  ts: number;
  type: "signal" | "fill" | "exit" | "alert" | "system";
  title: string;
  body?: string;
  symbol?: string;
  tone?: "buy" | "sell" | "info" | "muted";
}

interface Props {
  open: boolean;
  onClose: () => void;
  notifications: Notification[];
  onClear: () => void;
}

export default function NotificationsDrawer({ open, onClose, notifications, onClear }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40"
            onClick={onClose}
          />
          <motion.aside
            initial={{ x: 400 }}
            animate={{ x: 0 }}
            exit={{ x: 400 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            className="fixed right-0 top-0 bottom-0 w-96 z-50 bg-bg-panel-solid border-l border-bg-border shadow-2xl flex flex-col"
          >
            <header className="px-5 py-4 border-b border-bg-border flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-500">Notifications</div>
                <div className="text-sm text-slate-200">{notifications.length} recent</div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={onClear} className="text-xs text-slate-500 hover:text-white">Clear</button>
                <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="p-6 text-sm text-slate-500">Nothing yet. Signals, fills and exits will appear here.</div>
              ) : (
                <ul className="divide-y divide-bg-border">
                  {notifications.map((n) => (
                    <motion.li
                      key={n.id}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="px-5 py-3"
                    >
                      <div className="flex items-start gap-3">
                        <span className={clsx("mt-1 h-2 w-2 rounded-full shrink-0", dotColor(n.tone))} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-white truncate">{n.title}</div>
                          {n.body && <div className="text-xs text-slate-400">{n.body}</div>}
                          <div className="text-[10px] text-slate-500 mt-1">{new Date(n.ts).toLocaleTimeString()} {n.symbol && `· ${n.symbol}`}</div>
                        </div>
                      </div>
                    </motion.li>
                  ))}
                </ul>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function dotColor(tone?: Notification["tone"]) {
  switch (tone) {
    case "buy":
      return "bg-accent-buy";
    case "sell":
      return "bg-accent-sell";
    case "info":
      return "bg-accent-info";
    default:
      return "bg-slate-500";
  }
}
