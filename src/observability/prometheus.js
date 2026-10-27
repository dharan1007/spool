// Zero-dependency standard Prometheus metrics exposition format implementation
import { fail } from '../core/errors.js';

class Metric {
  constructor(name, help, type, labelNames = []) {
    this.name = name;
    this.help = help;
    this.type = type;
    this.labelNames = labelNames;
    this.values = new Map();
  }

  formatLabels(labels = {}) {
    if (!this.labelNames.length) return '';
    const parts = [];
    for (const key of this.labelNames) {
      if (labels[key] !== undefined) {
        parts.push(`${key}="${String(labels[key]).replace(/"/g, '\\"')}"`);
      }
    }
    return parts.length ? `{${parts.join(',')}}` : '';
  }

  render() {
    if (this.values.size === 0) return '';
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n`;
    for (const [key, val] of this.values.entries()) {
      out += `${this.name}${key} ${val}\n`;
    }
    return out;
  }
}

export class Counter extends Metric {
  constructor(options) {
    super(options.name, options.help, 'counter', options.labelNames);
  }

  inc(labels = {}, value = 1) {
    const key = this.formatLabels(labels);
    const cur = this.values.get(key) ?? 0;
    this.values.set(key, cur + value);
  }
}

export class Gauge extends Metric {
  constructor(options) {
    super(options.name, options.help, 'gauge', options.labelNames);
  }

  set(labels = {}, value = 0) {
    const key = this.formatLabels(labels);
    this.values.set(key, value);
  }

  inc(labels = {}, value = 1) {
    const key = this.formatLabels(labels);
    const cur = this.values.get(key) ?? 0;
    this.values.set(key, cur + value);
  }

  dec(labels = {}, value = 1) {
    const key = this.formatLabels(labels);
    const cur = this.values.get(key) ?? 0;
    this.values.set(key, cur - value);
  }
}

function extendSampleKey(key, extraLabel) {
  // Merges a quantile/le label into an existing series label set, keeping the
  // extend label last per the exposition format rules.
  if (!key) return `{${extraLabel}}`;
  return key.replace(/\}$/, `,${extraLabel}}`);
}

export class Histogram extends Metric {
  constructor(options) {
    super(options.name, options.help, 'histogram', options.labelNames);
    this.buckets = [...(options.buckets ?? [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60])].sort((a, b) => a - b);
    if (this.buckets.some(le => !Number.isFinite(le) || le <= 0) || this.buckets.some(le => !Number.isSafeInteger(le) && !Number.isSafeInteger(Math.round(le * 1e15)))) {
      fail('INVALID_METRIC_BUCKETS', 'Histogram buckets must be positive finite numbers');
    }
    this._series = new Map(); // labelKey -> { bucketCounts, sum, count }
  }

  observe(labels = {}, value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail('INVALID_METRIC_VALUE', 'Histogram observations must be non-negative finite numbers');
    }
    const key = this.formatLabels(labels);
    let series = this._series.get(key);
    if (!series) {
      series = { bucketCounts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this._series.set(key, series);
    }
    // Prometheus cumulative semantics: every bucket whose upper bound >= value
    // counts the observation; observations above the largest finite bucket are
    // still accounted and represented by the mandatory +Inf bucket.
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) series.bucketCounts[i] += 1;
    }
    series.sum += value;
    series.count += 1;
  }

  render() {
    if (this._series.size === 0) return '';
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n`;
    for (const [key, series] of this._series.entries()) {
      for (let i = 0; i < this.buckets.length; i++) {
        out += `${this.name}_bucket${extendSampleKey(key, `le="${this.buckets[i]}"`)} ${series.bucketCounts[i]}\n`;
      }
      out += `${this.name}_bucket${extendSampleKey(key, 'le="+Inf"')} ${series.count}\n`;
      out += `${this.name}_sum${key} ${series.sum}\n`;
      out += `${this.name}_count${key} ${series.count}\n`;
    }
    return out;
  }
}

export class Summary extends Metric {
  constructor(options) {
    super(options.name, options.help, 'summary', options.labelNames);
    this._series = new Map(); // labelKey -> { sortedValues, sum, count }
  }

  observe(labels = {}, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('INVALID_METRIC_VALUE', 'Summary observations must be finite numbers');
    }
    const key = this.formatLabels(labels);
    let series = this._series.get(key);
    if (!series) {
      series = { values: [], sum: 0, count: 0 };
      this._series.set(key, series);
    }
    series.values.push(value);
    series.sum += value;
    series.count += 1;
  }

  #quantile(values, q, defaultIfEmpty) {
    if (values.length === 0) return defaultIfEmpty;
    const index = Math.ceil(q * values.length) - 1;
    return values[Math.max(0, Math.min(index, values.length - 1))];
  }

  render() {
    if (this._series.size === 0) return '';
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n`;
    for (const [key, series] of this._series.entries()) {
      const sorted = [...series.values].sort((a, b) => a - b);
      for (const [q, p] of [[0.5, 50], [0.9, 90], [0.95, 95], [0.99, 99]]) {
        out += `${this.name}${extendSampleKey(key, `quantile="${q}"`)} ${this.#quantile(sorted, p / 100, series.values[0])}\n`;
      }
      out += `${this.name}_sum${key} ${series.sum}\n`;
      out += `${this.name}_count${key} ${series.count}\n`;
    }
    return out;
  }
}

export class Registry {
  constructor() {
    this.metrics = [];
  }

  register(metric) {
    this.metrics.push(metric);
    return metric;
  }

  metricsOutput() {
    return this.metrics.map(m => m.render()).filter(Boolean).join('\n') + '\n';
  }
}

export const defaultRegistry = new Registry();

export const metrics = {
  migrationsTotal: defaultRegistry.register(new Counter({
    name: 'spool_migrations_total',
    help: 'Total migrations by status and target',
    labelNames: ['status', 'target']
  })),
  migrationsActive: defaultRegistry.register(new Gauge({
    name: 'spool_migrations_active',
    help: 'Currently executing migrations by target',
    labelNames: ['target']
  })),
  rowsProcessedTotal: defaultRegistry.register(new Counter({
    name: 'spool_rows_processed_total',
    help: 'Rows processed',
    labelNames: ['migration_id', 'target']
  })),
  rowsWrittenTotal: defaultRegistry.register(new Counter({
    name: 'spool_rows_written_total',
    help: 'Rows written',
    labelNames: ['migration_id', 'target']
  })),
  rowsRejectedTotal: defaultRegistry.register(new Counter({
    name: 'spool_rows_rejected_total',
    help: 'Rows rejected',
    labelNames: ['migration_id', 'target']
  })),
  batchDurationSeconds: defaultRegistry.register(new Histogram({
    name: 'spool_batch_duration_seconds',
    help: 'Per-batch execution time',
    labelNames: ['target'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60]
  })),
  apiRequestsTotal: defaultRegistry.register(new Counter({
    name: 'spool_api_requests_total',
    help: 'API requests total',
    labelNames: ['method', 'route', 'status']
  })),
  apiLatencySeconds: defaultRegistry.register(new Histogram({
    name: 'spool_api_latency_seconds',
    help: 'API latency in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
  }))
};

export async function metricsHandler(req, res) {
  try {
    const data = defaultRegistry.metricsOutput();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(data);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(error));
  }
}