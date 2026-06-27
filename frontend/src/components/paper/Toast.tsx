import { useEffect, useState } from "react";

export interface ToastMsg {
  id: number;
  kind: "info" | "success" | "error" | "warn";
  text: string;
  // Optional undo affordance for destructive actions. When the user
  // clicks Undo within 5s we run undo() and dismiss the toast early.
  undo?: { label?: string; run: () => void };
}

export function useToastQueue() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  function push(kind: ToastMsg["kind"], text: string, opts?: { undo?: ToastMsg["undo"]; ttlMs?: number }) {
    const t: ToastMsg = { id: Date.now() + Math.random(), kind, text, undo: opts?.undo };
    setToasts((q) => [...q, t]);
    setTimeout(() => setToasts((q) => q.filter((x) => x.id !== t.id)), opts?.ttlMs ?? 5_000);
  }
  function dismiss(id: number) {
    setToasts((q) => q.filter((x) => x.id !== id));
  }
  return { toasts, push, dismiss };
}

export function ToastStack({ toasts }: { toasts: ToastMsg[] }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}

function ToastItem({ t }: { t: ToastMsg }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(true);
  }, []);
  const color =
    t.kind === "success"
      ? "border-accent-buy/40 bg-accent-buy/10"
      : t.kind === "error"
      ? "border-accent-sell/40 bg-accent-sell/10"
      : t.kind === "warn"
      ? "border-amber-500/40 bg-amber-500/10"
      : "border-bg-border bg-bg-elevated/80";
  return (
    <div
      className={`text-sm text-white border ${color} px-3 py-2 rounded-lg shadow-glass transition-all flex items-center justify-between gap-3 ${
        visible ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
      }`}
    >
      <span>{t.text}</span>
      {t.undo && (
        <button
          onClick={() => t.undo!.run()}
          className="text-xs uppercase tracking-wider text-accent-info hover:text-blue-300"
        >
          {t.undo.label ?? "Undo"}
        </button>
      )}
    </div>
  );
}
