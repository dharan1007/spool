export function rowsPerSecond(rows, durationMs) {
  if (durationMs <= 0) return 0;
  return rows / (durationMs / 1000);
}

export function bytesPerSecond(bytes, durationMs) {
  if (durationMs <= 0) return 0;
  return bytes / (durationMs / 1000);
}

export function mibPerSecond(bytes, durationMs) {
  return bytesPerSecond(bytes, durationMs) / (1024 * 1024);
}

export class LatencyHistogram {
  constructor({ maxSamples = 200_000 } = {}) {
    this.maxSamples = maxSamples;
    this.samples = [];
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    // Deterministic stride state (no RNG: evidence must be reproducible).
    // Once the reservoir is full, every maxSamples-th observation replaces the
    // slot at (count mod maxSamples), preserving a uniform deterministic stride.
    this.strideCounter = 0;
  }

  add(valueMs) {
    const v = Number(valueMs);
    if (!Number.isFinite(v) || v < 0) return;
    this.count++;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(v);
    } else {
      // Deterministic stride replacement: uniform over the stream without RNG.
      this.strideCounter++;
      if (this.strideCounter % this.maxSamples === 0) {
        this.samples[this.count % this.maxSamples] = v;
      }
    }
  }

  percentiles() {
    if (this.samples.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, count: this.count };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mean = this.sum / this.count;
    const at = p => {
      const idx = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
    };
    return {
      min: this.min === Infinity ? 0 : this.min,
      max: this.max === -Infinity ? 0 : this.max,
      mean,
      p50: at(50),
      p90: at(90),
      p95: at(95),
      p99: at(99),
      count: this.count
    };
  }

  toJSON() {
    return this.percentiles();
  }
}

export class ThroughputTracker {
  constructor() {
    this.rows = 0;
    this.bytes = 0;
    this.startNs = process.hrtime.bigint();
    this.endNs = null;
  }
  add(rows, bytes) {
    this.rows += rows;
    this.bytes += bytes;
  }
  stop() {
    this.endNs = process.hrtime.bigint();
  }
  durationMs() {
    const end = this.endNs ?? process.hrtime.bigint();
    return Number(end - this.startNs) / 1e6;
  }
  snapshot() {
    const ms = this.durationMs();
    return {
      rows: this.rows,
      bytes: this.bytes,
      durationMs: ms,
      rowsPerSec: rowsPerSecond(this.rows, ms),
      mibPerSec: mibPerSecond(this.bytes, ms)
    };
  }
}

export function calculateRpo({ acknowledgedRows, expectedRows, startTimeMs, endTimeMs } = {}) {
  const rpoRows = Math.max(0, (expectedRows ?? 0) - (acknowledgedRows ?? 0));
  const rpoMs = rpoRows === 0 ? 0 : (endTimeMs - startTimeMs);
  return { rpoRows, rpoMs, rpoStatus: Number.isFinite(rpoRows) ? 'KNOWN' : 'UNKNOWN' };
}

export function calculateRto({ faultTimeMs, recoveryTimeMs }) {
  if (faultTimeMs == null || recoveryTimeMs == null) return { rtoMs: null, rtoStatus: 'UNKNOWN' };
  return { rtoMs: Math.max(0, recoveryTimeMs - faultTimeMs), rtoStatus: 'KNOWN' };
}
