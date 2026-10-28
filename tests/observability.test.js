import test from 'node:test';
import assert from 'node:assert/strict';
import { Histogram, Summary, metrics, metricsHandler } from '../src/observability/prometheus.js';
import { healthHandler, readyHandler } from '../src/observability/health.js';

test('Prometheus metrics registration and increment', async () => {
  metrics.migrationsTotal.inc({ status: 'COMPLETE', target: 'sqlite' });
  metrics.rowsWrittenTotal.inc({ migration_id: 'mig_test', target: 'sqlite' }, 100);

  let output = '';
  const mockRes = {
    writeHead(code, headers) {
      assert.equal(code, 200);
      assert.ok(headers['Content-Type'].includes('text/plain'));
    },
    end(data) {
      output = data;
    }
  };

  await metricsHandler({}, mockRes);
  assert.ok(output.includes('spool_migrations_total'));
  assert.ok(output.includes('spool_rows_written_total'));
});

function metricLine(output, metricName, labelsString) {
  // Parses exposition lines shaped `name{labels?} value`, comparing label
  // parts order-independently.
  for (const line of output.split('\n')) {
    if (!line.startsWith(metricName)) continue;
    const m = line.slice(metricName.length).match(/^(?:\{([^}]*)\})? (-?\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const foundLabels = m[1] ?? null;
    if (foundLabels === null && labelsString === null) return Number(m[2]);
    if (foundLabels !== null && labelsString !== null) {
      const a = foundLabels.split(',').map(s => s.trim()).sort();
      const b = labelsString.replace(/^\{|\}$/g, '').split(',').map(s => s.trim()).sort();
      if (a.length === b.length && a.every((s, i) => s === b[i])) return Number(m[2]);
    }
  }
  return null;
}

test('Histogram keeps cumulative buckets exact, including observations above the largest bucket', () => {
  const fresh = new Histogram({ name: 'spool_test_histogram', help: 'test', buckets: [0.1, 0.5, 1] });
  fresh.observe({}, 0.05);
  fresh.observe({}, 0.2);
  fresh.observe({}, 0.4);
  fresh.observe({}, 0.9);      // only within le=1
  fresh.observe({}, 7);        // above every finite bucket
  const out = fresh.render();
  assert.equal(metricLine(out, 'spool_test_histogram_bucket', '{le="0.1"}'), 1);
  assert.equal(metricLine(out, 'spool_test_histogram_bucket', '{le="0.5"}'), 3);
  assert.equal(metricLine(out, 'spool_test_histogram_bucket', '{le="1"}'), 4);
  assert.equal(metricLine(out, 'spool_test_histogram_bucket', '{le="+Inf"}'), 5);
  assert.equal(metricLine(out, 'spool_test_histogram_count', null), 5);
  assert.equal(metricLine(out, 'spool_test_histogram_sum', null), 8.55);
});

test('Histogram keeps per-label sums and counts separated across label combinations', () => {
  const hist = new Histogram({ name: 'spool_test_labeled', help: 'test', labelNames: ['route', 'method'], buckets: [0.1, 1] });
  hist.observe({ route: '/a', method: 'GET' }, 0.2);
  hist.observe({ route: '/a', method: 'GET' }, 5);   // above largest bucket
  hist.observe({ route: '/b', method: 'POST' }, 0.05);
  const out = hist.render();
  assert.equal(metricLine(out, 'spool_test_labeled_bucket', '{route="/a",method="GET",le="0.1"}'), 0);
  assert.equal(metricLine(out, 'spool_test_labeled_bucket', '{route="/a",method="GET",le="1"}'), 1);
  assert.equal(metricLine(out, 'spool_test_labeled_bucket', '{route="/a",method="GET",le="+Inf"}'), 2);
  assert.equal(metricLine(out, 'spool_test_labeled_bucket', '{route="/b",method="POST",le="0.1"}'), 1);
  assert.equal(metricLine(out, 'spool_test_labeled_bucket', '{route="/b",method="POST",le="+Inf"}'), 1);
  assert.equal(metricLine(out, 'spool_test_labeled_sum', '{route="/a",method="GET"}'), 5.2);
  assert.equal(metricLine(out, 'spool_test_labeled_count', '{route="/a",method="GET"}'), 2);
  assert.equal(metricLine(out, 'spool_test_labeled_sum', '{route="/b",method="POST"}'), 0.05);
  assert.equal(metricLine(out, 'spool_test_labeled_count', '{route="/b",method="POST"}'), 1);
});

test('Summary renders per-label quantiles with its own sums and counts', () => {
  const summary = new Summary({ name: 'spool_test_summary', help: 'test', labelNames: ['target'] });
  summary.observe({ target: 'sqlite' }, 0.1);
  summary.observe({ target: 'sqlite' }, 0.3);
  summary.observe({ target: 'sqlite' }, 1.2);
  summary.observe({ target: 'bigquery' }, 0.4);
  const out = summary.render();
  assert.equal(metricLine(out, 'spool_test_summary', `{target="sqlite",quantile="0.5"}`), 0.3);
  assert.equal(metricLine(out, 'spool_test_summary', `{target="sqlite",quantile="0.99"}`), 1.2);
  assert.equal(metricLine(out, 'spool_test_summary', `{target="bigquery",quantile="0.5"}`), 0.4);
  assert.equal(metricLine(out, 'spool_test_summary_sum', '{target="sqlite"}'), 1.6);
  assert.equal(metricLine(out, 'spool_test_summary_count', '{target="bigquery"}'), 1);
});


test('Health and readiness probes', () => {
  let healthOutput = '';
  healthHandler({}, {
    writeHead(code, headers) {
      assert.equal(code, 200);
    },
    end(data) {
      healthOutput = JSON.parse(data);
    }
  });
  assert.equal(healthOutput.status, 'ok');

  let readyOutput = '';
  readyHandler({}, {
    writeHead(code) {
      assert.equal(code, 200);
    },
    end(data) {
      readyOutput = JSON.parse(data);
    }
  }, { checkDb: () => true });
  assert.equal(readyOutput.status, 'ready');

  let failOutput = '';
  readyHandler({}, {
    writeHead(code) {
      assert.equal(code, 503);
    },
    end(data) {
      failOutput = JSON.parse(data);
    }
  }, { checkDb: () => { throw new Error('DB connection failed'); } });
  assert.equal(failOutput.status, 'not_ready');
});
