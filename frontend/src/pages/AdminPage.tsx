import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { useMarketSocket, type WsPatternTrainingProgress } from "../lib/socket";
import {
  fetchPatternAccuracy,
  getTrainStatus,
  submitPatternTrain,
  type PatternAccuracyRollup,
  type PatternTimeframe,
} from "../lib/patternApi";
import { apiErrorMessage } from "../lib/errors";

interface SystemStats {
  api: { ok: boolean; uptimeSec: number; node: string; pid: number };
  feed: { type: string; running: boolean; symbols: string[]; lastPriceCount: number };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  cpu: { loadAvg1m: number; loadAvg5m: number; loadAvg15m: number; cores: number };
  counters: {
    users: number;
    activeUsers24h: number;
    openPositions: number;
    closedTrades: number;
    signals: number;
    signalsToday: number;
    auditEntries: number;
  };
  universe: string[];
  lastPrices: Record<string, number>;
  ts: number;
}

interface User {
  _id: string;
  email: string;
  role: "ADMIN" | "USER";
  capital: number;
  twoFactorEnabled: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export default function AdminPage() {
  const [tab, setTab] = useState<"system" | "users" | "signals" | "audit" | "patterns">("system");

  return (
    <div className="min-h-full bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4 flex items-center justify-between">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
          <h1 className="text-xl font-semibold text-white">Admin</h1>
          <div className="text-xs text-slate-500">System, users, signals, audit log, pattern ML models.</div>
        </div>
        <nav className="flex gap-2 text-sm">
          {(["system", "users", "signals", "audit", "patterns"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                "px-3 py-1.5 rounded-md capitalize",
                tab === t ? "bg-bg-elevated text-white" : "text-slate-400 hover:text-white"
              )}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main className="max-w-7xl mx-auto p-6">
        {tab === "system" && <SystemTab />}
        {tab === "users" && <UsersTab />}
        {tab === "signals" && <SignalsTab />}
        {tab === "audit" && <AuditTab />}
        {tab === "patterns" && <PatternsAdminTab />}
      </main>
    </div>
  );
}

// ----------------------------------------------------------------- Permissions

function AdminGate({ error, onRecovered }: { error: unknown; onRecovered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status;

  async function bootstrap() {
    setBusy(true);
    setMsg(null);
    try {
      const { data } = await api.post("/api/auth/bootstrap-admin");
      setMsg(`Promoted to ${data.role} (${data.reason}). Refresh.`);
      onRecovered();
    } catch (err) {
      setMsg(apiErrorMessage(err, "Bootstrap failed"));
    } finally {
      setBusy(false);
    }
  }

  if (status === 401) {
    return (
      <div className="bg-accent-sell/10 border border-accent-sell/40 text-accent-sell rounded-xl p-5 text-sm">
        Session expired — <Link to="/login" className="underline">log in</Link> again.
      </div>
    );
  }
  if (status === 403) {
    return (
      <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-5 text-sm space-y-3">
        <div className="text-slate-200">
          Admin role required. In dev mode you can promote your account in one click:
        </div>
        <button
          onClick={bootstrap}
          disabled={busy}
          className="bg-accent-info text-white rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? "Promoting…" : "Become admin (dev)"}
        </button>
        {msg && <div className="text-xs text-slate-400">{msg}</div>}
        <div className="text-[11px] text-slate-500">
          Or sign out and register a fresh account — the first user to exist with no admin present
          automatically becomes admin.
        </div>
      </div>
    );
  }
  return (
    <div className="bg-accent-sell/10 border border-accent-sell/40 text-accent-sell rounded-xl p-4 text-sm">
      {(error as Error)?.message ?? "Error"}
    </div>
  );
}

// ----------------------------------------------------------------- System

function SystemTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "system"],
    queryFn: async () => (await api.get("/api/admin/system")).data as SystemStats,
    // Stop the 5 s poll once the server says Forbidden — a non-admin tab
    // was hammering the endpoint with a 403 every cycle.
    refetchInterval: (query) => (query.state.error ? false : 5000),
    retry: (count, err) =>
      (err as { response?: { status?: number } })?.response?.status === 403 ? false : count < 2,
  });
  if (q.isLoading && !q.data) return <Skeleton rows={6} />;
  if (q.isError) return <AdminGate error={q.error} onRecovered={() => qc.invalidateQueries({ queryKey: ["admin"] })} />;
  if (!q.data) return null;
  const d = q.data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Stat label="API" value={d.api.ok ? "OK" : "DOWN"} tone={d.api.ok ? "buy" : "sell"} />
        <Stat label="Feed" value={d.feed.running ? "live" : "stopped"} tone={d.feed.running ? "buy" : "sell"} sub={`${d.feed.lastPriceCount}/${d.feed.symbols.length} sym`} />
        <Stat label="Users" value={d.counters.users} sub={`${d.counters.activeUsers24h} active 24h`} />
        <Stat label="Signals today" value={d.counters.signalsToday} sub={`${d.counters.signals} total`} />
        <Stat label="Open pos" value={d.counters.openPositions} sub={`${d.counters.closedTrades} closed`} />
        <Stat label="Audit rows" value={d.counters.auditEntries} />
        <Stat label="Uptime" value={`${(d.api.uptimeSec / 60).toFixed(1)}m`} />
        <Stat label="Heap" value={`${d.memory.heapUsedMb}/${d.memory.heapTotalMb} MB`} />
        <Stat label="RSS" value={`${d.memory.rssMb} MB`} />
        <Stat label="Load (1m)" value={d.cpu.loadAvg1m.toFixed(2)} sub={`${d.cpu.cores} cores`} />
        <Stat label="Node" value={d.api.node} />
        <Stat label="PID" value={d.api.pid} />
      </div>
      <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-5">
        <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Universe last prices</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 font-mono text-sm">
          {d.universe.map((s) => (
            <div key={s} className="flex justify-between bg-bg-elevated rounded px-3 py-2">
              <span className="text-slate-400">{s}</span>
              <span className="text-white">{d.lastPrices[s]?.toFixed(2) ?? "—"}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ----------------------------------------------------------------- Users

function UsersTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => (await api.get("/api/admin/users")).data.users as User[],
  });
  if (q.isLoading && !q.data) return <Skeleton rows={3} />;
  if (q.isError) return <AdminGate error={q.error} onRecovered={() => qc.invalidateQueries({ queryKey: ["admin"] })} />;
  if (!q.data) return null;

  async function setRole(id: string, role: "ADMIN" | "USER") {
    await api.patch(`/api/admin/users/${id}`, { role });
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
  }

  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="text-left px-5 py-3">Email</th>
            <th className="text-left px-5 py-3">Role</th>
            <th className="text-right px-5 py-3">Capital</th>
            <th className="text-left px-5 py-3">2FA</th>
            <th className="text-left px-5 py-3">Last login</th>
            <th className="text-right px-5 py-3">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-bg-border">
          {q.data.map((u) => (
            <tr key={u._id}>
              <td className="px-5 py-2 text-white">{u.email}</td>
              <td className="px-5 py-2"><Badge tone={u.role === "ADMIN" ? "info" : "muted"}>{u.role}</Badge></td>
              <td className="px-5 py-2 text-right font-mono">₹{u.capital.toLocaleString("en-IN")}</td>
              <td className="px-5 py-2"><Badge tone={u.twoFactorEnabled ? "buy" : "muted"}>{u.twoFactorEnabled ? "ON" : "OFF"}</Badge></td>
              <td className="px-5 py-2 text-slate-400 text-xs">{u.lastLoginAt ?? "—"}</td>
              <td className="px-5 py-2 text-right">
                {u.role === "ADMIN" ? (
                  <button onClick={() => setRole(u._id, "USER")} className="text-xs text-slate-400 hover:text-accent-sell">Demote</button>
                ) : (
                  <button onClick={() => setRole(u._id, "ADMIN")} className="text-xs text-slate-400 hover:text-accent-buy">Promote</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ----------------------------------------------------------------- Signals

function SignalsTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "signals"],
    queryFn: async () => (await api.get("/api/admin/signals")).data.signals as Array<{ _id: string; symbol: string; action: string; confidence: number; price: number; createdAt: string }>,
    refetchInterval: 5000,
  });
  if (q.isLoading && !q.data) return <Skeleton rows={6} />;
  if (q.isError) return <AdminGate error={q.error} onRecovered={() => qc.invalidateQueries({ queryKey: ["admin"] })} />;
  if (!q.data) return null;
  if (q.data.length === 0) {
    return <Empty label="No signals yet — wait for the signal engine's next tick (~15s)." />;
  }
  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="text-left px-5 py-3">Time</th>
            <th className="text-left px-5 py-3">Symbol</th>
            <th className="text-left px-5 py-3">Action</th>
            <th className="text-right px-5 py-3">Confidence</th>
            <th className="text-right px-5 py-3">Price</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-bg-border">
          {q.data.slice(0, 100).map((s) => (
            <tr key={s._id}>
              <td className="px-5 py-2 text-slate-400 font-mono text-xs">{new Date(s.createdAt).toLocaleTimeString()}</td>
              <td className="px-5 py-2 text-white">{s.symbol}</td>
              <td className="px-5 py-2"><Badge tone={s.action === "BUY" ? "buy" : s.action === "SELL" ? "sell" : "muted"}>{s.action}</Badge></td>
              <td className="px-5 py-2 text-right font-mono">{(s.confidence * 100).toFixed(0)}%</td>
              <td className="px-5 py-2 text-right font-mono">{s.price.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ----------------------------------------------------------------- Audit

function AuditTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "audit"],
    queryFn: async () => (await api.get("/api/admin/audit?limit=200")).data.logs as Array<{ _id: string; method: string; path: string; status: number; email?: string; ip?: string; durationMs?: number; createdAt: string }>,
    refetchInterval: 5000,
  });
  if (q.isLoading && !q.data) return <Skeleton rows={6} />;
  if (q.isError) return <AdminGate error={q.error} onRecovered={() => qc.invalidateQueries({ queryKey: ["admin"] })} />;
  if (!q.data) return null;
  if (q.data.length === 0) return <Empty label="No audit entries captured yet." />;
  return (
    <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="text-left px-5 py-3">Time</th>
            <th className="text-left px-5 py-3">Method</th>
            <th className="text-left px-5 py-3">Path</th>
            <th className="text-right px-5 py-3">Status</th>
            <th className="text-left px-5 py-3">User</th>
            <th className="text-right px-5 py-3">ms</th>
            <th className="text-left px-5 py-3">IP</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-bg-border">
          {q.data.map((l) => (
            <tr key={l._id}>
              <td className="px-5 py-2 text-slate-400 font-mono text-xs">{new Date(l.createdAt).toLocaleTimeString()}</td>
              <td className="px-5 py-2 font-mono">{l.method}</td>
              <td className="px-5 py-2 font-mono text-slate-300">{l.path}</td>
              <td className={clsx("px-5 py-2 text-right font-mono", l.status >= 400 ? "text-accent-sell" : "text-accent-buy")}>{l.status}</td>
              <td className="px-5 py-2 text-slate-400 text-xs">{l.email ?? "—"}</td>
              <td className="px-5 py-2 text-right font-mono text-slate-400">{l.durationMs ?? "—"}</td>
              <td className="px-5 py-2 text-slate-400 text-xs">{l.ip ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ----------------------------------------------------------------- shared

function Stat({ label, value, tone, sub }: { label: string; value: string | number; tone?: "buy" | "sell"; sub?: string }) {
  const toneClass = tone === "buy" ? "text-accent-buy" : tone === "sell" ? "text-accent-sell" : "text-white";
  return (
    <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("text-xl font-mono tabular-nums", toneClass)}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 font-mono">{sub}</div>}
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "buy" | "sell" | "info" | "muted" }) {
  const cls = {
    buy: "bg-accent-buy/15 text-accent-buy",
    sell: "bg-accent-sell/15 text-accent-sell",
    info: "bg-accent-info/15 text-accent-info",
    muted: "bg-bg-elevated text-slate-400",
  }[tone];
  return <span className={clsx("px-2 py-0.5 rounded text-[11px] font-bold", cls)}>{children}</span>;
}

function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 bg-bg-elevated/40 rounded-lg animate-pulse" />
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-6 text-sm text-slate-400 text-center">
      {label}
    </div>
  );
}

// =============================================================================
// Phase 11 — Pattern ML Models admin tab
// =============================================================================

interface ModelStatus {
  ready: boolean;
  trained_at: string | null;
  feature_version: number;
  metrics: Record<string, unknown>;
}
interface PatternStatusResponse {
  models: Record<string, ModelStatus | string | number>;
  cache: { backend: string; size?: number; url?: string };
  mongo: { connected: boolean; db?: string; server_info?: string; reason?: string };
  ai_service_token_enabled: boolean;
}

const TIMEFRAMES: PatternTimeframe[] = ["M1", "M5", "M15", "M30", "H1", "D1"];

function PatternsAdminTab() {
  const token = useAuth((s) => s.token);
  const [status, setStatus] = useState<PatternStatusResponse | null>(null);
  const [accuracy, setAccuracy] = useState<PatternAccuracyRollup[] | null>(null);
  const [busyTf, setBusyTf] = useState<string | null>(null);
  const [activeJobs, setActiveJobs] = useState<Record<string, WsPatternTrainingProgress>>({});
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadAll() {
    setLoading(true);
    setErr(null);
    try {
      const [s, a] = await Promise.all([
        api.get<PatternStatusResponse>("/api/patterns/admin/status").then((r) => r.data),
        fetchPatternAccuracy(),
      ]);
      setStatus(s);
      setAccuracy(a?.rollups ?? []);
    } catch (e: unknown) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAll(); }, []);

  // Listen for live training progress over the WS.
  useMarketSocket({
    token,
    symbols: [],
    onEvent: (ev) => {
      if (ev.type !== "pattern_training_progress") return;
      const p = ev.progress;
      setActiveJobs((m) => ({ ...m, [p.job_id]: p }));
      if (p.status === "completed" || p.status === "failed") {
        // Refresh the registry so the new trained_at + metrics surface.
        void loadAll();
      }
    },
  });

  async function retrain(tf: PatternTimeframe, fast = false) {
    setBusyTf(tf);
    try {
      const res = await submitPatternTrain(tf, fast);
      if (res?.job_id) {
        setActiveJobs((m) => ({
          ...m,
          [res.job_id]: {
            job_id: res.job_id,
            status: "queued",
            percent: 0,
            message: `queued (ETA ${res.estimated_seconds}s)`,
            timeframe: tf,
          },
        }));
        // Background poll fallback in case the WS bridge isn't wired.
        const id = window.setInterval(async () => {
          const data = await getTrainStatus(res.job_id);
          if (!data) return;
          setActiveJobs((m) => ({
            ...m,
            [res.job_id]: {
              job_id: res.job_id,
              status: String(data.status ?? "running"),
              percent: Number(data.percent ?? 0),
              message: String(data.message ?? ""),
              timeframe: tf,
              finished_at: typeof data.finished_at === "string" ? data.finished_at : undefined,
              error: typeof data.error === "string" ? data.error : undefined,
            },
          }));
          if (data.status === "completed" || data.status === "failed") {
            window.clearInterval(id);
            void loadAll();
          }
        }, 4000);
      }
    } finally {
      setBusyTf(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500">Pattern ML Models</div>
            <div className="text-xs text-slate-400 mt-0.5">Per-timeframe sklearn ensemble (GB + MLP).</div>
          </div>
          <button onClick={loadAll} disabled={loading} className="text-xs border border-bg-border rounded px-2 py-1 text-slate-300 hover:text-white">
            {loading ? "…" : "Refresh"}
          </button>
        </div>
        {err && <div className="text-xs text-accent-sell mb-2">{err}</div>}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {TIMEFRAMES.map((tf) => {
            const m = (status?.models?.[tf] as ModelStatus | undefined);
            const ready = m?.ready ?? false;
            const trainedAt = m?.trained_at;
            const gbMetrics = (m?.metrics as Record<string, unknown> | undefined)?.gb as Record<string, unknown> | undefined;
            const testAcc = (gbMetrics?.test as Record<string, unknown> | undefined)?.accuracy;
            const testF1 = (gbMetrics?.test as Record<string, unknown> | undefined)?.f1_macro;
            return (
              <div key={tf} className={clsx(
                "border rounded-lg p-3",
                ready ? "border-accent-buy/30 bg-accent-buy/5" : "border-bg-border bg-bg-elevated/40"
              )}>
                <div className="flex items-center justify-between">
                  <div className="font-mono text-white text-lg">{tf}</div>
                  <span className={clsx(
                    "text-[10px] uppercase font-bold px-2 py-0.5 rounded",
                    ready ? "bg-accent-buy/15 text-accent-buy" : "bg-slate-500/15 text-slate-400"
                  )}>{ready ? "ready" : "not trained"}</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Trained: {trainedAt ? new Date(trainedAt).toLocaleString() : "never"}
                </div>
                {testAcc != null && (
                  <div className="text-[11px] font-mono text-slate-300 mt-1">
                    Test acc: <span className="text-white">{Number(testAcc).toFixed(3)}</span> · F1: <span className="text-white">{Number(testF1 ?? 0).toFixed(3)}</span>
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => retrain(tf, false)}
                    disabled={busyTf === tf}
                    className="flex-1 text-[11px] bg-accent-info text-white rounded px-2 py-1 disabled:opacity-50"
                  >
                    {busyTf === tf ? "…" : "Retrain"}
                  </button>
                  <button
                    onClick={() => retrain(tf, true)}
                    disabled={busyTf === tf}
                    className="text-[11px] border border-bg-border text-slate-300 rounded px-2 py-1"
                    title="Smaller model + fewer iterations, finishes in seconds (for sanity checks)"
                  >
                    Fast
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Live training progress strip */}
      {Object.values(activeJobs).length > 0 && (
        <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4">
          <div className="text-sm uppercase tracking-wider text-slate-500 mb-2">Training jobs</div>
          <div className="space-y-2">
            {Object.values(activeJobs).slice(-6).map((j) => (
              <div key={j.job_id} className="text-xs">
                <div className="flex items-center justify-between font-mono">
                  <span className="text-slate-300">{j.timeframe ?? "?"} · {j.job_id.slice(0, 8)}</span>
                  <span className={clsx(
                    j.status === "completed" ? "text-accent-buy" :
                    j.status === "failed" ? "text-accent-sell" :
                    "text-amber-400"
                  )}>
                    {j.status} · {j.percent}%
                  </span>
                </div>
                <div className="h-1 mt-1 bg-bg-border rounded">
                  <div className={clsx(
                    "h-full rounded transition-all",
                    j.status === "completed" ? "bg-accent-buy" : j.status === "failed" ? "bg-accent-sell" : "bg-accent-info"
                  )} style={{ width: `${j.percent}%` }} />
                </div>
                {j.message && <div className="text-[10px] text-slate-500 mt-0.5">{j.message}</div>}
                {j.error && <div className="text-[10px] text-accent-sell mt-0.5">{j.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Health row */}
      <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-4 text-xs font-mono text-slate-400 flex flex-wrap gap-4">
        <span>Cache: <span className="text-white">{status?.cache?.backend ?? "?"}</span></span>
        <span>Mongo: <span className={status?.mongo?.connected ? "text-accent-buy" : "text-accent-sell"}>{status?.mongo?.connected ? "connected" : "disconnected"}</span></span>
        <span>Service token: <span className={status?.ai_service_token_enabled ? "text-accent-buy" : "text-slate-500"}>{status?.ai_service_token_enabled ? "enabled" : "open (dev)"}</span></span>
      </div>

      {/* Accuracy table */}
      <div className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl overflow-hidden">
        <div className="px-5 pt-4 pb-2 text-sm uppercase tracking-wider text-slate-500">Pattern accuracy rollup (top 25)</div>
        {!accuracy ? (
          <div className="px-5 py-6 text-xs text-slate-500">Loading…</div>
        ) : accuracy.length === 0 ? (
          <div className="px-5 py-6 text-xs text-slate-500">No resolved patterns yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Pattern</th>
                  <th className="text-left px-3 py-2">TF</th>
                  <th className="text-right px-3 py-2">N</th>
                  <th className="text-right px-3 py-2">W</th>
                  <th className="text-right px-3 py-2">L</th>
                  <th className="text-right px-3 py-2">Win %</th>
                  <th className="text-right px-3 py-2">Avg RR</th>
                  <th className="text-right px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {accuracy.slice(0, 25).map((r) => (
                  <tr key={`${r.pattern_name}:${r.timeframe}`}>
                    <td className="px-3 py-1.5 text-slate-200">{r.pattern_name}</td>
                    <td className="px-3 py-1.5 text-slate-400">{r.timeframe}</td>
                    <td className="px-3 py-1.5 text-right text-slate-300">{r.total_detected}</td>
                    <td className="px-3 py-1.5 text-right text-accent-buy">{r.wins}</td>
                    <td className="px-3 py-1.5 text-right text-accent-sell">{r.losses}</td>
                    <td className={clsx("px-3 py-1.5 text-right", r.win_rate >= 0.55 ? "text-accent-buy" : "text-accent-sell")}>
                      {(r.win_rate * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-300">{r.avg_rr.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-500">
                      {r.last_updated ? new Date(r.last_updated).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
