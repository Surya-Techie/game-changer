// Minimal in-process Prometheus-style metrics. Zero deps so we don't
// pull prom-client into the bundle. Supports counters, gauges, and
// histograms with hardcoded latency buckets. Exposed as text on /metrics
// in the standard Prometheus exposition format.

type LabelSet = Record<string, string | number>;
type Labels = string; // serialised "k=v,k=v" used as map key

function serialise(labels: LabelSet | undefined): Labels {
  if (!labels) return "";
  return Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(",");
}

interface CounterRow { labels: LabelSet; value: number }
interface GaugeRow { labels: LabelSet; value: number }

class Counter {
  private rows = new Map<Labels, CounterRow>();
  constructor(public name: string, public help: string) {}
  inc(labels?: LabelSet, by = 1) {
    const key = serialise(labels);
    const row = this.rows.get(key);
    if (row) row.value += by;
    else this.rows.set(key, { labels: labels ?? {}, value: by });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const row of this.rows.values()) {
      const lab = serialise(row.labels);
      lines.push(`${this.name}${lab ? `{${lab}}` : ""} ${row.value}`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  private rows = new Map<Labels, GaugeRow>();
  constructor(public name: string, public help: string) {}
  set(value: number, labels?: LabelSet) {
    this.rows.set(serialise(labels), { labels: labels ?? {}, value });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const row of this.rows.values()) {
      const lab = serialise(row.labels);
      lines.push(`${this.name}${lab ? `{${lab}}` : ""} ${row.value}`);
    }
    return lines.join("\n");
  }
}

const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

interface HistRow {
  labels: LabelSet;
  buckets: number[]; // running counts ≤ each bucket
  sum: number;
  count: number;
}

class Histogram {
  private rows = new Map<Labels, HistRow>();
  constructor(public name: string, public help: string) {}
  observeMs(ms: number, labels?: LabelSet) {
    const key = serialise(labels);
    let row = this.rows.get(key);
    if (!row) {
      row = { labels: labels ?? {}, buckets: new Array(LATENCY_BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
      this.rows.set(key, row);
    }
    row.sum += ms;
    row.count += 1;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      if (ms <= LATENCY_BUCKETS_MS[i]) row.buckets[i] += 1;
    }
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const row of this.rows.values()) {
      const baseLab = serialise(row.labels);
      const joinLab = (extra: string) => (baseLab ? `${baseLab},${extra}` : extra);
      for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
        lines.push(`${this.name}_bucket{${joinLab(`le="${LATENCY_BUCKETS_MS[i]}"`)}} ${row.buckets[i]}`);
      }
      lines.push(`${this.name}_bucket{${joinLab(`le="+Inf"`)}} ${row.count}`);
      lines.push(`${this.name}_sum${baseLab ? `{${baseLab}}` : ""} ${row.sum}`);
      lines.push(`${this.name}_count${baseLab ? `{${baseLab}}` : ""} ${row.count}`);
    }
    return lines.join("\n");
  }
}

class Registry {
  private counters: Counter[] = [];
  private gauges: Gauge[] = [];
  private histograms: Histogram[] = [];
  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.counters.push(c);
    return c;
  }
  gauge(name: string, help: string): Gauge {
    const g = new Gauge(name, help);
    this.gauges.push(g);
    return g;
  }
  histogram(name: string, help: string): Histogram {
    const h = new Histogram(name, help);
    this.histograms.push(h);
    return h;
  }
  render(): string {
    const parts: string[] = [];
    for (const c of this.counters) parts.push(c.render());
    for (const g of this.gauges) parts.push(g.render());
    for (const h of this.histograms) parts.push(h.render());
    return parts.join("\n") + "\n";
  }
}

export const metrics = new Registry();

// Pre-declared instruments used across the codebase.
export const httpRequests = metrics.counter("qti_http_requests_total", "HTTP request count");
export const httpDurationMs = metrics.histogram("qti_http_request_duration_ms", "HTTP request duration in ms");
export const paperOrdersTotal = metrics.counter("qti_paper_orders_total", "Paper orders placed");
export const paperOrdersFilled = metrics.counter("qti_paper_orders_filled_total", "Paper orders filled");
export const brokerOrdersTotal = metrics.counter("qti_broker_orders_total", "Broker orders placed (mock+kite)");
export const wsConnections = metrics.gauge("qti_ws_connections", "Active WebSocket connections");
export const signalsEmitted = metrics.counter("qti_signals_emitted_total", "AI signals emitted to bus");
