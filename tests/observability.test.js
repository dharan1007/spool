import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics, metricsHandler } from '../src/observability/prometheus.js';
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
