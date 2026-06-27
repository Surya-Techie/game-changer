import { useState } from "react";
import { paperApi, type PaperAccount } from "../../lib/paperApi";

interface Props {
  accounts: PaperAccount[];
  activeId: string | null;
  onChange: () => void;
}

export default function AccountSelector({ accounts, activeId, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("Aggressive");
  const [newCapital, setNewCapital] = useState(1_000_000);
  const [confirmReset, setConfirmReset] = useState(false);

  async function activate(id: string) {
    if (id === activeId) return;
    setBusy(true);
    await paperApi.activateAccount(id).finally(() => setBusy(false));
    onChange();
  }

  async function createNew() {
    setBusy(true);
    await paperApi.createAccount(newName.trim() || "Account", Number(newCapital) || 1_000_000).finally(() => setBusy(false));
    setShowNew(false);
    onChange();
  }

  async function reset() {
    if (!activeId) return;
    setBusy(true);
    await paperApi.resetAccount(activeId).finally(() => setBusy(false));
    setConfirmReset(false);
    onChange();
  }

  return (
    <div className="flex items-center gap-2 relative">
      <select
        value={activeId ?? ""}
        onChange={(e) => activate(e.target.value)}
        disabled={busy}
        className="bg-bg-elevated border border-bg-border rounded-md text-sm px-2 py-1 text-white"
      >
        {accounts.map((a) => (
          <option key={a._id} value={a._id}>
            {a.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => setShowNew((v) => !v)}
        className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded border border-bg-border"
        disabled={accounts.length >= 3}
        title={accounts.length >= 3 ? "Max 3 accounts" : "Create another paper account"}
      >
        + new
      </button>
      <button
        onClick={() => setConfirmReset(true)}
        className="text-xs text-slate-400 hover:text-rose-300 px-2 py-1 rounded border border-bg-border"
      >
        reset
      </button>

      {showNew && (
        <div className="absolute top-full mt-2 right-0 bg-bg-panel-solid border border-bg-border rounded-lg shadow-glass p-3 z-30 w-64 space-y-2">
          <div className="text-xs text-slate-400">New paper account</div>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-white"
          />
          <input
            type="number"
            value={newCapital}
            onChange={(e) => setNewCapital(Number(e.target.value))}
            min={10_000}
            className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1 text-sm text-white"
          />
          <div className="flex gap-2">
            <button onClick={createNew} className="flex-1 bg-accent-info/90 hover:bg-accent-info text-white text-xs py-1.5 rounded">
              Create
            </button>
            <button onClick={() => setShowNew(false)} className="text-xs text-slate-400 px-2">
              cancel
            </button>
          </div>
        </div>
      )}

      {confirmReset && (
        <div className="absolute top-full mt-2 right-0 bg-bg-panel-solid border border-rose-500/40 rounded-lg shadow-glass p-3 z-30 w-72 space-y-2">
          <div className="text-sm font-semibold text-rose-300">Reset this paper account?</div>
          <div className="text-xs text-slate-400">
            All positions, orders and trade history for this account will be wiped. Cash returns to the starting capital.
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={reset} className="flex-1 bg-rose-500/90 hover:bg-rose-500 text-white text-xs py-1.5 rounded">
              Confirm reset
            </button>
            <button onClick={() => setConfirmReset(false)} className="text-xs text-slate-400 px-2">
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
