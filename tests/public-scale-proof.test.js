import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SCRIPT = 'scripts/benchmarks/run.cjs';

function runWithEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPOOL_TEST_POSTGRES_') || key === 'SPOOL_TEST_PG_PASSWORD' || key === 'SPOOL_COMMIT_SHA') {
      delete env[key];
    }
  }
  return spawnSync(process.execPath, [SCRIPT], { env: { ...env, ...overrides }, encoding: 'utf8' });
}

test('scale benchmark harness fails closed when no PostgreSQL endpoint is configured', () => {
  const result = runWithEnv({ SPOOL_TEST_POSTGRES_ENDPOINT: '' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Fatal benchmark error/);
});

test('scale benchmark harness rejects a malformed PostgreSQL endpoint', () => {
  const result = runWithEnv({ SPOOL_TEST_POSTGRES_ENDPOINT: 'not-a-url' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Fatal benchmark error/);
});
