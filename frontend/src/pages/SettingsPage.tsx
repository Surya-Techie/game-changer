import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { usePrefs } from "../store/prefs";
import BrokerSection from "../components/BrokerSection";

interface AutotradeSettings {
  autoTradeMode: "OFF" | "SEMI" | "AUTO";
  killSwitch: boolean;
  minConfidence: number;
  maxOpenPositions: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;

  stopMode: "ATR" | "FIXED_PCT";
  stopPct: number;
  targetRR: number;
  trailingStopEnabled: boolean;
  trailingStopPct: number;
  partialTpEnabled: boolean;
  regimeFilterEnabled: boolean;
  regimeMinAdx: number;
  mtfConfirmation: boolean;

  // Item 19 additions
  theme?: "dark" | "light";
  autoRefreshSec?: number;
  brokerageFlat?: number;
  brokeragePct?: number;
  taxStcgPct?: number;
  scannerUniverse?: "watchlist" | "nifty50" | "nifty100";
  notificationPrefs?: {
    signal?: boolean;
    fill?: boolean;
    exit?: boolean;
    alert?: boolean;
    system?: boolean;
  };
}

export default function SettingsPage() {
  const user = useAuth((s) => s.user);
  const theme = usePrefs((s) => s.theme);
  const setLocalTheme = usePrefs((s) => s.setTheme);
  const autoRefreshSec = usePrefs((s) => s.autoRefreshSec);
  const setLocalRefresh = usePrefs((s) => s.setAutoRefreshSec);

  const [settings, setSettings] = useState<AutotradeSettings | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // 2FA state.
  const [twoFaEnabled, setTwoFaEnabled] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [twofaError, setTwofaError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/api/autotrade").then(({ data }) => {
      const s = data.settings as AutotradeSettings;
      setSettings(s);
      // Hydrate local prefs from server (server is source of truth on login).
      if (s.theme) setLocalTheme(s.theme);
      if (typeof s.autoRefreshSec === "number") setLocalRefresh(s.autoRefreshSec);
    });
    api.get("/api/2fa/status").then(({ data }) => setTwoFaEnabled(Boolean(data?.enabled)));
  }, []);

  async function patch(patch: Partial<AutotradeSettings>) {
    const { data } = await api.patch("/api/autotrade", patch);
    setSettings(data.settings as AutotradeSettings);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 800);
  }

  if (!settings) return <div className="p-8 text-slate-400">Loading…</div>;

  return (
    <div className="min-h-screen bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4 flex justify-between items-center">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
          <h1 className="text-xl font-semibold text-white">Settings</h1>
        </div>
        {savedFlash && <span className="text-xs text-accent-buy">Saved</span>}
      </header>

      <main className="max-w-4xl mx-auto p-6 space-y-6">
        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6">
          <div className="text-sm uppercase tracking-wider text-slate-500 mb-2">Account</div>
          <div className="text-slate-200">{user?.email}</div>
        </section>

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6 space-y-5">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500">Stop-loss & take-profit</div>
            <div className="text-xs text-slate-500">Choose how exits are sized. Fixed % is simpler, ATR adapts to volatility.</div>
          </div>

          <Radio
            label="Stop mode"
            value={settings.stopMode}
            options={[
              { v: "FIXED_PCT", label: "Fixed % from entry" },
              { v: "ATR", label: "ATR-based (volatility-adjusted)" },
            ]}
            onChange={(v) => patch({ stopMode: v as "ATR" | "FIXED_PCT" })}
          />

          {settings.stopMode === "FIXED_PCT" && (
            <NumberInput
              label="Stop-loss %"
              value={settings.stopPct}
              min={0.5}
              max={10}
              step={0.1}
              suffix="%"
              hint="2% means losses are capped at 2% of the entry price per trade."
              onCommit={(v) => patch({ stopPct: v })}
            />
          )}

          <NumberInput
            label="Take-profit (R-multiple)"
            value={settings.targetRR}
            min={0.5}
            max={6}
            step={0.5}
            suffix="× stop"
            hint="2× means target distance is 2 times the stop distance (a 2% stop → 4% target)."
            onCommit={(v) => patch({ targetRR: v })}
          />
        </section>

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6 space-y-5">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500">Edge enhancers</div>
            <div className="text-xs text-slate-500">
              These don't guarantee profit, but each is a real edge improvement used by institutional desks.
            </div>
          </div>

          <Toggle
            label="Trailing stop"
            description="Raise the stop as the price moves favorably — locks in unrealised gains."
            checked={settings.trailingStopEnabled}
            onChange={(b) => patch({ trailingStopEnabled: b })}
          />
          {settings.trailingStopEnabled && (
            <NumberInput
              label="Trail distance %"
              value={settings.trailingStopPct}
              min={0.2}
              max={10}
              step={0.1}
              suffix="%"
              onCommit={(v) => patch({ trailingStopPct: v })}
            />
          )}

          <Toggle
            label="Partial take-profit at 1R"
            description="Close 50% when the trade reaches 1× risk; move remaining stop to break-even. Lower variance, often higher expectancy."
            checked={settings.partialTpEnabled}
            onChange={(b) => patch({ partialTpEnabled: b })}
          />

          <Toggle
            label="Regime filter (ADX)"
            description="Skip trades when the market is choppy (low ADX). Often the single biggest filter improvement."
            checked={settings.regimeFilterEnabled}
            onChange={(b) => patch({ regimeFilterEnabled: b })}
          />
          {settings.regimeFilterEnabled && (
            <NumberInput
              label="Min ADX to trade"
              value={settings.regimeMinAdx}
              min={10}
              max={40}
              step={1}
              hint="18–25 is typical. Above 25 = strong trend only."
              onCommit={(v) => patch({ regimeMinAdx: v })}
            />
          )}

          <Toggle
            label="Multi-timeframe confirmation"
            description="Require 1m, 5m, and 15m trends to agree before entering."
            checked={settings.mtfConfirmation}
            onChange={(b) => patch({ mtfConfirmation: b })}
          />
        </section>

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6 space-y-5">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500">Risk sizing</div>
            <div className="text-xs text-slate-500">Per-trade and per-day caps.</div>
          </div>
          <NumberInput
            label="Risk per trade %"
            value={settings.riskPerTradePct}
            min={0.1}
            max={5}
            step={0.1}
            suffix="%"
            hint="Position size is calculated so a stop hit loses this % of capital."
            onCommit={(v) => patch({ riskPerTradePct: v })}
          />
          <NumberInput
            label="Max daily loss %"
            value={settings.maxDailyLossPct}
            min={0.5}
            max={20}
            step={0.5}
            suffix="%"
            hint="Crosses this and the kill switch trips automatically."
            onCommit={(v) => patch({ maxDailyLossPct: v })}
          />
          <NumberInput
            label="Max open positions"
            value={settings.maxOpenPositions}
            min={1}
            max={20}
            step={1}
            onCommit={(v) => patch({ maxOpenPositions: Math.round(v) })}
          />
          <NumberInput
            label="Min signal confidence"
            value={settings.minConfidence}
            min={0.4}
            max={0.9}
            step={0.05}
            hint="Reject signals below this confidence."
            onCommit={(v) => patch({ minConfidence: v })}
          />
        </section>

        {/* === Item 19: Appearance, refresh, costs, notifications === */}

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6 space-y-5">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500">Appearance & refresh</div>
            <div className="text-xs text-slate-500">Theme + how often the dashboard polls.</div>
          </div>
          <Radio
            label="Theme"
            value={theme}
            options={[
              { v: "dark", label: "Dark (default)" },
              { v: "light", label: "Light (daylight)" },
            ]}
            onChange={(v) => { setLocalTheme(v as "dark" | "light"); patch({ theme: v as "dark" | "light" }); }}
          />
          <Radio
            label="Auto-refresh interval"
            value={String(autoRefreshSec)}
            options={[
              { v: "30",  label: "30 seconds" },
              { v: "60",  label: "60 seconds" },
              { v: "300", label: "5 minutes" },
              { v: "0",   label: "Manual only" },
            ]}
            onChange={(v) => { setLocalRefresh(Number(v)); patch({ autoRefreshSec: Number(v) }); }}
          />
        </section>

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6 space-y-5">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500">Charges & taxes (for backtest net P&L)</div>
            <div className="text-xs text-slate-500">Used by the backtest engine and the trade journal to compute true net P&amp;L.</div>
          </div>
          <NumberInput
            label="Brokerage flat ₹ (per round-trip)"
            value={settings.brokerageFlat ?? 20}
            min={0}
            max={1000}
            step={1}
            hint="Zerodha typical: ₹20 per leg flat. Round-trip = ₹40 total."
            onCommit={(v) => patch({ brokerageFlat: v })}
          />
          <NumberInput
            label="Brokerage % (per side)"
            value={settings.brokeragePct ?? 0.03}
            min={0}
            max={1}
            step={0.01}
            suffix="%"
            hint="If your broker charges a percentage instead of flat (e.g. 0.03%)."
            onCommit={(v) => patch({ brokeragePct: v })}
          />
          <NumberInput
            label="STCG tax %"
            value={settings.taxStcgPct ?? 15}
            min={0}
            max={40}
            step={1}
            suffix="%"
            hint="Short-Term Capital Gains tax. Applied to net P&L in the trade journal."
            onCommit={(v) => patch({ taxStcgPct: v })}
          />
        </section>

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6 space-y-5">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500">Scanner</div>
            <div className="text-xs text-slate-500">Universe for the Scanner page's preset and custom scans.</div>
          </div>
          <Radio
            label="Scanner universe"
            value={settings.scannerUniverse ?? "watchlist"}
            options={[
              { v: "watchlist", label: "My watchlist" },
              { v: "nifty50",   label: "Nifty 50" },
              { v: "nifty100",  label: "Nifty 100" },
            ]}
            onChange={(v) => patch({ scannerUniverse: v as "watchlist" | "nifty50" | "nifty100" })}
          />
        </section>

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6 space-y-5">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500">Notification preferences</div>
            <div className="text-xs text-slate-500">Per-type toggles for the notifications drawer.</div>
          </div>
          {(["signal", "fill", "exit", "alert", "system"] as const).map((kind) => (
            <Toggle
              key={kind}
              label={
                kind === "signal" ? "AI signal events" :
                kind === "fill"   ? "Order fills" :
                kind === "exit"   ? "Position closes (SL/TP/Trail)" :
                kind === "alert"  ? "Custom alerts" :
                "System events (kill switch, auto-trade mode change)"
              }
              checked={settings.notificationPrefs?.[kind] ?? true}
              onChange={(b) => patch({ notificationPrefs: { ...(settings.notificationPrefs ?? {}), [kind]: b } })}
            />
          ))}
        </section>

        <section className="bg-bg-panel-solid/70 backdrop-blur-glass border border-bg-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-sm uppercase tracking-wider text-slate-500">Two-factor authentication</div>
              <div className="text-xs text-slate-500">TOTP via any authenticator app.</div>
            </div>
            <span className={twoFaEnabled ? "text-accent-buy font-semibold" : "text-slate-500"}>
              {twoFaEnabled ? "Enabled" : "Disabled"}
            </span>
          </div>

          {!twoFaEnabled && !qr && (
            <button onClick={enroll2fa} disabled={busy} className="btn-primary">Enroll 2FA</button>
          )}
          {qr && (
            <div className="space-y-3">
              <img src={qr} alt="2FA QR" className="w-48 h-48 bg-white p-2 rounded" />
              {secret && <div className="text-xs text-slate-500 font-mono break-all">Manual: {secret}</div>}
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" maxLength={6} className="input w-40" />
              <div><button onClick={verify2fa} disabled={busy || code.length !== 6} className="btn-primary">Verify & enable</button></div>
            </div>
          )}
          {recovery && (
            <div className="mt-4 p-3 bg-accent-info/10 border border-accent-info/40 rounded">
              <div className="text-xs text-slate-300 mb-2">Save these recovery codes:</div>
              <div className="grid grid-cols-2 gap-1 font-mono text-sm text-white">
                {recovery.map((c) => <div key={c}>{c}</div>)}
              </div>
            </div>
          )}
          {twoFaEnabled && !recovery && (
            <div className="space-y-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code to disable" maxLength={6} className="input w-56" />
              <button onClick={disable2fa} disabled={busy || code.length !== 6} className="btn-danger">Disable 2FA</button>
            </div>
          )}
          {twofaError && <div className="mt-3 text-sm text-accent-sell">{twofaError}</div>}
        </section>

        <BrokerSection />
      </main>

      <style>{`
        .input { background: #0a0d12; border: 1px solid #1f2a3d; border-radius: 8px; padding: 8px 12px; color: #e2e8f0; outline: none; }
        .input:focus { border-color: #3b82f6; }
        .btn-primary { background: #3b82f6; color: white; border-radius: 8px; padding: 8px 14px; font-weight: 600; }
        .btn-primary:disabled { opacity: 0.5; }
        .btn-danger { background: rgba(234,57,67,0.15); border: 1px solid #ea3943; color: #ea3943; border-radius: 8px; padding: 8px 14px; font-weight: 600; }
      `}</style>
    </div>
  );

  async function enroll2fa() {
    setBusy(true);
    setTwofaError(null);
    try {
      const { data } = await api.post("/api/2fa/enroll");
      setQr(data.qr);
      setSecret(data.secret);
    } catch (err: any) {
      setTwofaError(err?.response?.data?.error ?? "Enroll failed");
    } finally {
      setBusy(false);
    }
  }

  async function verify2fa() {
    setBusy(true);
    setTwofaError(null);
    try {
      const { data } = await api.post("/api/2fa/verify", { code });
      setRecovery(data.recoveryCodes);
      setTwoFaEnabled(true);
      setQr(null);
      setSecret(null);
    } catch (err: any) {
      setTwofaError(err?.response?.data?.error ?? "Verify failed");
    } finally {
      setBusy(false);
    }
  }

  async function disable2fa() {
    setBusy(true);
    setTwofaError(null);
    try {
      await api.post("/api/2fa/disable", { code });
      setTwoFaEnabled(false);
      setCode("");
      setRecovery(null);
    } catch (err: any) {
      setTwofaError(err?.response?.data?.error ?? "Disable failed");
    } finally {
      setBusy(false);
    }
  }
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-sm text-slate-100">{label}</div>
        {description && <div className="text-xs text-slate-500 max-w-md">{description}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative w-11 h-6 rounded-full transition-colors flex-shrink-0",
          checked ? "bg-accent-info" : "bg-bg-elevated border border-bg-border"
        )}
        aria-pressed={checked}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  step,
  suffix,
  hint,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  hint?: string;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState<string>(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-sm text-slate-100">{label}</div>
        {hint && <div className="text-xs text-slate-500 max-w-md">{hint}</div>}
      </div>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={local}
          min={min}
          max={max}
          step={step}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            const n = Number(local);
            if (!Number.isNaN(n) && n !== value) onCommit(n);
          }}
          className="input w-24 text-right font-mono"
        />
        {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
      </div>
    </div>
  );
}

function Radio({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ v: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="text-sm text-slate-100 mb-2">{label}</div>
      <div className="flex gap-2">
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={clsx(
              "px-3 py-1.5 rounded-md border text-sm",
              value === o.v
                ? "border-accent-info bg-accent-info/10 text-white"
                : "border-bg-border text-slate-400 hover:text-white"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
