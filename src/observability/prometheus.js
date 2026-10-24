// Zero-dependency standard Prometheus metrics exposition format implementation

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

export class Histogram extends Metric {
  constructor(options) {
    super(options.name, options.help, 'histogram', options.labelNames);
    this.buckets = options.buckets ?? [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60];
    this.counts = new Map(); // key -> bucket counts
    this.sums = new Map();
  }

  observe(labels = {}, value) {
    const key = this.formatLabels(labels);
    const curSum = this.sums.get(key) ?? 0;
    this.sums.set(key, curSum + value);

    const bucketCounts = this.counts.get(key) ?? new Array(this.buckets.length).fill(0);
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        bucketCounts[i]++;
      }
    }
    this.counts.set(key, bucketCounts);
  }

  render() {
    if (this.sums.size === 0) return '';
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n`;
    for (const [key, sum] of this.sums.entries()) {
      const bucketCounts = this.counts.get(key) ?? [];
      let totalCount = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        totalCount = bucketCounts[i];
        const leLabels = key ? key.replace(/\}$/, `,le="${this.buckets[i]}"}`) : `{le="${this.buckets[i]}"}`;
        out += `${this.name}_bucket${leLabels} ${totalCount}\n`;
      }
      const infLabels = key ? key.replace(/\}$/, `,le="+Inf"}`) : `{le="+Inf"}`;
      out += `${this.name}_bucket${infLabels} ${totalCount}\n`;
      out += `${this.name}_sum${key} ${sum}\n`;
      out += `${this.name}_count${key} ${totalCount}\n`;
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
