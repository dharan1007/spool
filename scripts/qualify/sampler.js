import { performance } from 'node:perf_hooks';

export class ResourceSampler {
  constructor({ evidenceWriter, intervalMs = 1000 }) {
    this.evidenceWriter = evidenceWriter;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.samples = [];
    this.maxSamples = 10000; // bounded
    this.cpuPrev = process.cpuUsage();
    this.hrtimePrev = process.hrtime.bigint();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  sample() {
    const mem = process.memoryUsage();
    const cpuCurrent = process.cpuUsage(this.cpuPrev);
    const now = process.hrtime.bigint();
    const elapsedNs = now - this.hrtimePrev;
    const elapsedMs = Number(elapsedNs) / 1e6;
    // CPU percent approximation
    const cpuPercent = (cpuCurrent.user + cpuCurrent.system) / (elapsedMs * 1000) * 100;
    this.cpuPrev = process.cpuUsage();
    this.hrtimePrev = now;

    const sample = {
      timestamp: new Date().toISOString(),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      cpuPercent: Number(cpuPercent.toFixed(2)),
      eventLoopDelayMs: null // could use performance.eventLoopUtilization if available
    };
    // For bounded memory, keep aggregated stats but also stream raw
    if (this.samples.length < this.maxSamples) this.samples.push(sample);
    // Stream to evidence writer as raw event
    try {
      this.evidenceWriter.appendRaw({
        scenario: 'resource',
        event: 'sample',
        ...sample
      });
    } catch {}
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  summary() {
    if (this.samples.length === 0) return { count: 0 };
    const rss = this.samples.map(s => s.rssBytes);
    const heap = this.samples.map(s => s.heapUsedBytes);
    const sort = arr => [...arr].sort((a, b) => a - b);
    const median = arr => {
      const s = sort(arr);
      return s[Math.floor(s.length / 2)];
    };
    const rssSorted = sort(rss);
    return {
      count: this.samples.length,
      rss: {
        min: Math.min(...rss),
        max: Math.max(...rss),
        median: median(rss),
        p95: rssSorted[Math.floor(rssSorted.length * 0.95)] ?? 0,
        initial: rss[0],
        final: rss[rss.length - 1],
        peak: Math.max(...rss),
        slope: rss.length > 1 ? (rss[rss.length - 1] - rss[0]) / rss.length : 0
      },
      heap: {
        min: Math.min(...heap),
        max: Math.max(...heap),
        median: median(heap)
      }
    };
  }
}
