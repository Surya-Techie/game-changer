import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { api } from "../lib/api";

interface FormulaCondition {
  indicator: string;
  operator: "crosses_above" | "crosses_below" | "is_above" | "is_below";
  rhs: number | string;
}

interface Alert {
  _id: string;
  symbol: string;
  type: string;
  value?: number;
  enabled: boolean;
  note?: string;
  soundEnabled: boolean;
  triggerCount: number;
  lastTriggeredAt?: string;
  lastTriggeredValue?: number;
  formula?: FormulaCondition[];
  formulaTimeframe?: string;
  lastFormulaValues?: Record<string, number>;
  // Phase 11 — PATTERN_ALERT
  patternNames?: string[];
  patternMinConfidence?: number;
  patternDirections?: Array<"bullish" | "bearish" | "continuation" | "neutral">;
  patternTimeframes?: string[];
}

const FORMULA_INDICATORS = ["RSI", "MACD", "EMA_20", "EMA_50", "SMA_200", "ADX", "ATR", "SUPERTREND", "VWAP", "OBV"] as const;
const FORMULA_OPERATORS: { v: FormulaCondition["operator"]; label: string }[] = [
  { v: "crosses_above", label: "crosses above" },
  { v: "crosses_below", label: "crosses below" },
  { v: "is_above", label: "is above" },
  { v: "is_below", label: "is below" },
];
const FORMULA_TIMEFRAMES = ["M5", "M15", "H1", "D1"] as const;

interface HistoryEvent {
  id: string;
  symbol: string;
  type: string;
  ts: string;
  value?: number;
}

const TYPE_DEFS: Record<string, { label: string; needsValue: boolean; valueLabel: string; valueDefault: number }> = {
  INDICATOR_FORMULA: { label: "Indicator formula (advanced)", needsValue: false, valueLabel: "", valueDefault: 0 },
  PRICE_ABOVE: { label: "Price above", needsValue: true, valueLabel: "Price ₹", valueDefault: 100 },
  PRICE_BELOW: { label: "Price below", needsValue: true, valueLabel: "Price ₹", valueDefault: 100 },
  PRICE_CHANGE_PCT: { label: "% change ≥", needsValue: true, valueLabel: "% change", valueDefault: 1 },
  RSI_ABOVE: { label: "RSI above", needsValue: true, valueLabel: "RSI", valueDefault: 70 },
  RSI_BELOW: { label: "RSI below", needsValue: true, valueLabel: "RSI", valueDefault: 30 },
  MACD_CROSS_BULL: { label: "MACD cross bullish", needsValue: false, valueLabel: "", valueDefault: 0 },
  MACD_CROSS_BEAR: { label: "MACD cross bearish", needsValue: false, valueLabel: "", valueDefault: 0 },
  AI_SIGNAL_BUY: { label: "AI signal BUY", needsValue: false, valueLabel: "", valueDefault: 0 },
  AI_SIGNAL_SELL: { label: "AI signal SELL", needsValue: false, valueLabel: "", valueDefault: 0 },
  COMPOSITE_ABOVE: { label: "Composite score above", needsValue: true, valueLabel: "Score", valueDefault: 70 },
  COMPOSITE_BELOW: { label: "Composite score below", needsValue: true, valueLabel: "Score", valueDefault: 30 },
  VOLUME_SPIKE: { label: "Volume spike (× avg)", needsValue: true, valueLabel: "Multiplier", valueDefault: 2 },
  SUPERTREND_FLIP_BULL: { label: "Supertrend flips bullish", needsValue: false, valueLabel: "", valueDefault: 0 },
  SUPERTREND_FLIP_BEAR: { label: "Supertrend flips bearish", needsValue: false, valueLabel: "", valueDefault: 0 },
  // Phase 11 — pattern detection alert
  PATTERN_ALERT: { label: "Pattern detected", needsValue: false, valueLabel: "", valueDefault: 75 },
};

const SYMBOLS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL"];

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [symbol, setSymbol] = useState("RELIANCE");
  const [type, setType] = useState<string>("PRICE_ABOVE");
  const [value, setValue] = useState<number>(100);
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);

  // Indicator-formula builder state.
  const [formula, setFormula] = useState<FormulaCondition[]>([
    { indicator: "RSI", operator: "crosses_below", rhs: 30 },
  ]);
  const [formulaTimeframe, setFormulaTimeframe] = useState<typeof FORMULA_TIMEFRAMES[number]>("M15");

  // Phase 11 — PATTERN_ALERT builder state.
  const [patternNamesInput, setPatternNamesInput] = useState<string>("");
  const [patternMinConfidence, setPatternMinConfidence] = useState<number>(75);
  const [patternDirections, setPatternDirections] = useState<string[]>([]);
  const [patternTimeframes, setPatternTimeframes] = useState<string[]>(["M15"]);
  const [availablePatternNames, setAvailablePatternNames] = useState<string[]>([]);

  // Load the master pattern name list once for the autocomplete checklist.
  useEffect(() => {
    let aborted = false;
    api.get("/api/backtest/patterns/names")
      .then((r) => { if (!aborted) setAvailablePatternNames((r.data?.names ?? []) as string[]); })
      .catch(() => {});
    return () => { aborted = true; };
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  async function load() {
    const [a, h] = await Promise.all([
      api.get("/api/alerts").then(({ data }) => data.alerts as Alert[]),
      api.get("/api/alerts/history").then(({ data }) => data.history as HistoryEvent[]),
    ]);
    setAlerts(a);
    setHistory(h);
  }

  async function create() {
    setCreating(true);
    try {
      const payload: Record<string, unknown> = {
        symbol,
        type,
        value: TYPE_DEFS[type]?.needsValue ? value : undefined,
        note: note || undefined,
      };
      if (type === "INDICATOR_FORMULA") {
        payload.formula = formula;
        payload.formulaTimeframe = formulaTimeframe;
      }
      if (type === "PATTERN_ALERT") {
        const names = patternNamesInput
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (names.length) payload.patternNames = names;
        payload.patternMinConfidence = patternMinConfidence;
        if (patternDirections.length) payload.patternDirections = patternDirections;
        if (patternTimeframes.length) payload.patternTimeframes = patternTimeframes;
      }
      await api.post("/api/alerts", payload);
      setNote("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    await api.patch(`/api/alerts/${id}`, { enabled });
    await load();
  }

  async function remove(id: string) {
    await api.delete(`/api/alerts/${id}`);
    await load();
  }

  const def = TYPE_DEFS[type];

  return (
    <div className="min-h-screen bg-app-radial text-slate-200">
      <header className="border-b border-bg-border bg-bg-panel-solid/60 backdrop-blur-glass px-6 py-4">
        <Link to="/" className="text-xs text-slate-500 hover:text-white">← Dashboard</Link>
        <h1 className="text-xl font-semibold text-white">Alerts</h1>
        <div className="text-xs text-slate-500">Fires on price, indicator, AI signal or composite events. Max 20 active.</div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl p-5">
          <div className="text-sm uppercase tracking-wider text-slate-500 mb-3">Create alert</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
            <Field label="Symbol">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="input">
                {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Condition">
              <select value={type} onChange={(e) => { setType(e.target.value); const d = TYPE_DEFS[e.target.value]; if (d) setValue(d.valueDefault); }} className="input">
                {Object.entries(TYPE_DEFS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
            {def?.needsValue && (
              <Field label={def.valueLabel}>
                <input type="number" step={0.01} value={value} onChange={(e) => setValue(Number(e.target.value))} className="input font-mono" />
              </Field>
            )}
            <Field label="Note (optional)">
              <input value={note} onChange={(e) => setNote(e.target.value)} className="input" placeholder="" />
            </Field>
            <button onClick={create} disabled={creating} className="bg-accent-info text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
              {creating ? "…" : "Add alert"}
            </button>
          </div>

          {type === "INDICATOR_FORMULA" && (
            <FormulaBuilder
              formula={formula}
              setFormula={setFormula}
              timeframe={formulaTimeframe}
              setTimeframe={setFormulaTimeframe}
            />
          )}

          {type === "PATTERN_ALERT" && (
            <PatternAlertBuilder
              namesInput={patternNamesInput}
              setNamesInput={setPatternNamesInput}
              minConfidence={patternMinConfidence}
              setMinConfidence={setPatternMinConfidence}
              directions={patternDirections}
              setDirections={setPatternDirections}
              timeframes={patternTimeframes}
              setTimeframes={setPatternTimeframes}
              availableNames={availablePatternNames}
            />
          )}
        </section>

        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
          <div className="px-5 pt-4 pb-2 text-sm uppercase tracking-wider text-slate-500">Active alerts ({alerts.filter((a) => a.enabled).length})</div>
          {alerts.length === 0 ? (
            <div className="px-6 py-6 text-sm text-slate-400 text-center">No alerts yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">Symbol</th>
                  <th className="text-left px-3 py-2">Condition</th>
                  <th className="text-right px-3 py-2">Value</th>
                  <th className="text-center px-3 py-2">Status</th>
                  <th className="text-center px-3 py-2">Last triggered</th>
                  <th className="text-right px-3 py-2">Count</th>
                  <th className="px-3 py-2">Note</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {alerts.map((a) => (
                  <tr key={a._id}>
                    <td className="px-4 py-2 text-white">{a.symbol}</td>
                    <td className="px-3 py-2 text-slate-300">
                      {TYPE_DEFS[a.type]?.label ?? a.type}
                      {a.type === "INDICATOR_FORMULA" && a.formula && (
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {a.formula.map((c, i) => (
                            <span key={i}>
                              {i > 0 && <span className="text-amber-400 mx-1">AND</span>}
                              {c.indicator} {c.operator.replace("_", " ")} {c.rhs}
                            </span>
                          ))}
                          <span className="ml-1 text-slate-600">[{a.formulaTimeframe}]</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{a.value ?? "—"}</td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => toggle(a._id, !a.enabled)} className={clsx("text-[10px] font-bold px-2 py-0.5 rounded", a.enabled ? "bg-accent-buy/15 text-accent-buy" : "bg-slate-500/15 text-slate-400")}>
                        {a.enabled ? "ON" : "OFF"}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-center text-slate-400 text-xs font-mono">
                      {a.lastTriggeredAt ? new Date(a.lastTriggeredAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-300">{a.triggerCount}</td>
                    <td className="px-3 py-2 text-slate-500 text-xs">{a.note ?? ""}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => remove(a._id)} className="text-slate-500 hover:text-accent-sell text-xs">Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="bg-bg-panel-solid/70 border border-bg-border rounded-xl overflow-hidden">
          <div className="px-5 pt-4 pb-2 text-sm uppercase tracking-wider text-slate-500">Trigger history (last 100)</div>
          {history.length === 0 ? (
            <div className="px-6 py-4 text-sm text-slate-400">Nothing fired yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">Time</th>
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-left px-3 py-2">Condition</th>
                  <th className="text-right px-3 py-2">Observed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {history.map((h, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2 text-slate-400 font-mono text-xs">{new Date(h.ts).toLocaleString()}</td>
                    <td className="px-3 py-2 text-white">{h.symbol}</td>
                    <td className="px-3 py-2 text-slate-300">{TYPE_DEFS[h.type]?.label ?? h.type}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-300">{h.value != null ? h.value.toFixed(3) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>

      <style>{`
        .input { width: 100%; background: #0a0d12; border: 1px solid #1f2a3d; border-radius: 8px; padding: 8px 10px; color: #e2e8f0; outline: none; }
        .input:focus { border-color: #3b82f6; }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 inline-block">{label}</span>
      {children}
    </label>
  );
}

function FormulaBuilder({
  formula, setFormula, timeframe, setTimeframe,
}: {
  formula: FormulaCondition[];
  setFormula: (f: FormulaCondition[]) => void;
  timeframe: typeof FORMULA_TIMEFRAMES[number];
  setTimeframe: (t: typeof FORMULA_TIMEFRAMES[number]) => void;
}) {
  function update(i: number, patch: Partial<FormulaCondition>) {
    setFormula(formula.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function remove(i: number) {
    if (formula.length <= 1) return;
    setFormula(formula.filter((_, idx) => idx !== i));
  }
  function add() {
    if (formula.length >= 6) return;
    setFormula([...formula, { indicator: "EMA_20", operator: "crosses_above", rhs: "EMA_50" }]);
  }
  return (
    <div className="mt-3 border-t border-bg-border pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-slate-500">Formula (all conditions AND-ed)</div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">Timeframe</span>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as typeof FORMULA_TIMEFRAMES[number])} className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-white">
            {FORMULA_TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      {formula.map((cond, i) => {
        const rhsIsLiteral = typeof cond.rhs === "number";
        return (
          <div key={i} className="grid grid-cols-12 gap-2 items-center text-xs">
            <select
              value={cond.indicator}
              onChange={(e) => update(i, { indicator: e.target.value })}
              className="col-span-3 bg-bg-elevated border border-bg-border rounded px-2 py-1 text-white"
            >
              {FORMULA_INDICATORS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              value={cond.operator}
              onChange={(e) => update(i, { operator: e.target.value as FormulaCondition["operator"] })}
              className="col-span-3 bg-bg-elevated border border-bg-border rounded px-2 py-1 text-white"
            >
              {FORMULA_OPERATORS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <div className="col-span-2 flex items-center gap-1">
              <button
                onClick={() => update(i, { rhs: rhsIsLiteral ? "EMA_50" : 30 })}
                className={`text-[10px] px-2 py-1 rounded border ${rhsIsLiteral ? "border-accent-info text-white" : "border-bg-border text-slate-400"}`}
                type="button"
              >
                value
              </button>
              <button
                onClick={() => update(i, { rhs: rhsIsLiteral ? "EMA_50" : 30 })}
                className={`text-[10px] px-2 py-1 rounded border ${!rhsIsLiteral ? "border-accent-info text-white" : "border-bg-border text-slate-400"}`}
                type="button"
              >
                indicator
              </button>
            </div>
            <div className="col-span-3">
              {rhsIsLiteral ? (
                <input
                  type="number"
                  step="0.01"
                  value={cond.rhs as number}
                  onChange={(e) => update(i, { rhs: Number(e.target.value) })}
                  className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1 text-white font-mono"
                />
              ) : (
                <select
                  value={cond.rhs as string}
                  onChange={(e) => update(i, { rhs: e.target.value })}
                  className="w-full bg-bg-elevated border border-bg-border rounded px-2 py-1 text-white"
                >
                  {FORMULA_INDICATORS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
            <button
              onClick={() => remove(i)}
              disabled={formula.length === 1}
              className="col-span-1 text-[10px] text-rose-300 hover:text-rose-200 disabled:opacity-30"
              type="button"
            >
              remove
            </button>
          </div>
        );
      })}
      <button
        onClick={add}
        disabled={formula.length >= 6}
        type="button"
        className="text-xs text-accent-info hover:text-blue-300 disabled:opacity-40"
      >
        + Add condition
      </button>
      <div className="text-[10px] text-slate-500">
        Evaluated every 60s against {timeframe} candles. Cooldown 60s between fires.
      </div>
    </div>
  );
}


// Phase 11 — PATTERN_ALERT builder. Filter by name list, min confidence,
// direction (multi), and timeframe (multi). Empty patternNames means "any
// pattern that passes the other filters".
interface PatternBuilderProps {
  namesInput: string;
  setNamesInput: (s: string) => void;
  minConfidence: number;
  setMinConfidence: (n: number) => void;
  directions: string[];
  setDirections: (d: string[]) => void;
  timeframes: string[];
  setTimeframes: (t: string[]) => void;
  availableNames: string[];
}

function PatternAlertBuilder({
  namesInput,
  setNamesInput,
  minConfidence,
  setMinConfidence,
  directions,
  setDirections,
  timeframes,
  setTimeframes,
  availableNames,
}: PatternBuilderProps) {
  function toggle(set: string[], v: string, setter: (s: string[]) => void) {
    setter(set.includes(v) ? set.filter((x) => x !== v) : [...set, v]);
  }
  const selected = namesInput
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="mt-4 pt-4 border-t border-bg-border space-y-3">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">Pattern alert filters</div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-slate-400 flex items-center gap-2">
          <span>Min confidence</span>
          <input
            type="range"
            min={50}
            max={95}
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
            className="w-40"
          />
          <span className="font-mono text-slate-200">{minConfidence}%</span>
        </label>

        <div className="text-xs text-slate-400 flex items-center gap-2">
          <span>Direction</span>
          {(["bullish", "bearish", "continuation", "neutral"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggle(directions, d, setDirections)}
              className={clsx(
                "px-2 py-0.5 rounded border text-[11px]",
                directions.includes(d)
                  ? "border-accent-info bg-accent-info/10 text-white"
                  : "border-bg-border text-slate-400"
              )}
            >
              {d}
            </button>
          ))}
        </div>

        <div className="text-xs text-slate-400 flex items-center gap-2">
          <span>Timeframes</span>
          {(["M5", "M15", "H1", "D1"] as const).map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => toggle(timeframes, tf, setTimeframes)}
              className={clsx(
                "px-2 py-0.5 rounded border text-[11px] font-mono",
                timeframes.includes(tf)
                  ? "border-accent-info bg-accent-info/10 text-white"
                  : "border-bg-border text-slate-400"
              )}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">
          Patterns ({selected.length === 0 ? "any" : `${selected.length} selected`})
        </div>
        <input
          type="text"
          placeholder="Comma-separated names (blank = any pattern). e.g. Bullish Engulfing, Hammer"
          value={namesInput}
          onChange={(e) => setNamesInput(e.target.value)}
          className="input w-full text-xs"
        />
        {availableNames.length > 0 && (
          <details className="mt-2 text-[10px] text-slate-500">
            <summary className="cursor-pointer hover:text-slate-300">Browse available patterns ({availableNames.length})</summary>
            <div className="mt-2 max-h-40 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-1">
              {availableNames.map((n) => {
                const on = selected.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      const next = on ? selected.filter((x) => x !== n) : [...selected, n];
                      setNamesInput(next.join(", "));
                    }}
                    className={clsx(
                      "text-left text-[10px] px-1.5 py-0.5 rounded border truncate",
                      on ? "border-accent-info bg-accent-info/10 text-white" : "border-bg-border text-slate-400 hover:text-slate-200"
                    )}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
          </details>
        )}
      </div>
      <div className="text-[10px] text-slate-500">
        Fires when patternEngine emits a 'pattern' event passing all the above filters. Cooldown 30s.
      </div>
    </div>
  );
}
