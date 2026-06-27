// Settings page section for broker integration. Lives in its own file
// so the SettingsPage.tsx imports stay short.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";

interface BrokerStatusResponse {
  status: {
    mode: "mock" | "kite";
    connected: boolean;
    lastError?: string;
    userIdHint?: string;
  };
  margins?: { available: number; used: number; net: number; currency: string };
  mode: "mock" | "kite";
  loginUrl?: string;
}

export default function BrokerSection() {
  const [data, setData] = useState<BrokerStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warningAck, setWarningAck] = useState<boolean>(
    typeof window !== "undefined" && localStorage.getItem("qti.broker.warningAck") === "1"
  );
  const [busy, setBusy] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  async function refresh() {
    try {
      const res = await api.get<BrokerStatusResponse>("/api/broker/status");
      setData(res.data);
      setError(null);
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? (e as Error).message;
      setError(msg);
    }
  }

  // Initial load + periodic refresh while connected.
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  // If the user just came back from Kite's login flow with a request_token,
  // post it to /api/broker/auth automatically.
  useEffect(() => {
    const rt = searchParams.get("request_token");
    if (!rt) return;
    setBusy(true);
    api
      .post("/api/broker/auth", { request_token: rt })
      .then(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("request_token");
        next.delete("status");
        next.delete("action");
        setSearchParams(next, { replace: true });
        return refresh();
      })
      .catch((e) => setError((e as { response?: { data?: { status?: { lastError?: string } } } })?.response?.data?.status?.lastError ?? "Kite auth failed"))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function logout() {
    setBusy(true);
    try {
      await api.post("/api/broker/logout");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function connect() {
    if (!warningAck) {
      setError("Please tick the live-trading acknowledgement before connecting.");
      return;
    }
    if (data?.loginUrl) {
      window.location.href = data.loginUrl;
    } else {
      setError("Kite login URL unavailable — check KITE_API_KEY on the server.");
    }
  }

  const mode = data?.mode ?? "mock";
  const status = data?.status;
  const margins = data?.margins;

  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6 space-y-4">
      <div>
        <div className="text-sm uppercase tracking-wider text-slate-500">Broker</div>
        <div className="text-xs text-slate-500">
          Backend BROKER_MODE = <span className="font-mono text-slate-300">{mode}</span>. Restart the backend to switch.
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-400">Mode:</span>
        <ModePill active={mode === "mock"} label="Mock (paper)" />
        <ModePill active={mode === "kite"} label="Zerodha Kite" />
        <span className="ml-auto">
          {status?.connected ? (
            <span className="px-2 py-0.5 rounded bg-accent-buy/20 text-accent-buy text-xs font-semibold">CONNECTED</span>
          ) : (
            <span className="px-2 py-0.5 rounded bg-slate-500/20 text-slate-300 text-xs font-semibold">DISCONNECTED</span>
          )}
        </span>
      </div>

      {mode === "kite" && (
        <div className="space-y-3 border-t border-bg-border pt-3">
          <div className="bg-amber-500/10 border border-amber-500/40 rounded-md p-3 text-xs text-amber-200 space-y-2">
            <div className="font-semibold">⚠️ Live trading uses real money.</div>
            <div>
              Once connected, the auto-trader will place orders against your Zerodha account using the configured risk
              parameters. Verify your stop-loss, position size, and max-daily-loss settings before enabling auto mode.
            </div>
            <label className="flex items-center gap-2 mt-1">
              <input
                type="checkbox"
                checked={warningAck}
                onChange={(e) => {
                  setWarningAck(e.target.checked);
                  localStorage.setItem("qti.broker.warningAck", e.target.checked ? "1" : "0");
                }}
              />
              <span>I understand. Enable live broker actions.</span>
            </label>
          </div>

          {!status?.connected ? (
            <button
              onClick={connect}
              disabled={busy}
              className="bg-accent-info text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
            >
              {busy ? "Connecting…" : "Connect to Kite"}
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <button onClick={logout} disabled={busy} className="text-xs px-3 py-1.5 rounded border border-bg-border text-slate-300 hover:text-white">
                {busy ? "…" : "Disconnect"}
              </button>
              {status.userIdHint && (
                <span className="text-xs text-slate-400 font-mono">Kite user: {status.userIdHint}</span>
              )}
            </div>
          )}

          {margins && status?.connected && (
            <div className="grid grid-cols-3 gap-2 pt-2">
              <Margin label="Available" value={margins.available} />
              <Margin label="Used" value={margins.used} />
              <Margin label="Net" value={margins.net} />
            </div>
          )}

          {status?.lastError && !status.connected && (
            <div className="text-xs text-rose-400">{status.lastError}</div>
          )}
        </div>
      )}

      {error && <div className="text-xs text-rose-400">{error}</div>}
    </section>
  );
}

function ModePill({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium ${
        active ? "bg-accent-info/20 text-white border border-accent-info" : "bg-bg-elevated/60 text-slate-400"
      }`}
    >
      {label}
    </span>
  );
}

function Margin({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-bg-elevated/40 border border-bg-border rounded p-2">
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className="text-sm font-mono text-white">₹{value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>
    </div>
  );
}
