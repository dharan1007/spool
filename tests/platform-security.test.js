import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSecretRef } from '../src/platform/secrets.js';
import { redact } from '../src/platform/redact.js';
import { evaluatePlanPolicy } from '../src/platform/policy.js';
import { ConfigStore } from '../src/daemon/config-store.js';

test('redaction removes nested secret material without changing safe metadata', () => {
  const value = redact({
    password: 'p',
    token: 't',
    nested: { apiKey: 'k', safe: 3, connection: { authorization: 'Bearer x', host: 'localhost' } }
  });
  assert.deepEqual(value, {
    password: '[REDACTED]',
    token: '[REDACTED]',
    nested: { apiKey: '[REDACTED]', safe: 3, connection: { authorization: '[REDACTED]', host: 'localhost' } }
  });
});

test('environment secret references resolve without embedding a value in the reference', () => {
  const ref = { provider: 'env', key: 'SPOOL_TEST_SECRET' };
  assert.equal(resolveSecretRef(ref, { SPOOL_TEST_SECRET: 'value' }), 'value');
  assert.deepEqual(ref, { provider: 'env', key: 'SPOOL_TEST_SECRET' });
});

test('missing environment secret fails closed', () => {
  assert.throws(
    () => resolveSecretRef({ provider: 'env', key: 'MISSING_SECRET' }, {}),
    /SECRET_NOT_FOUND|not set/i
  );
});

test('destructive overwrite requires explicit policy approval', () => {
  const denied = evaluatePlanPolicy(
    { risk: { level: 'high', approvals: ['target_overwrite'] } },
    { allow: [] }
  );
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.missingApprovals, ['target_overwrite']);

  const allowed = evaluatePlanPolicy(
    { risk: { level: 'high', approvals: ['target_overwrite'] } },
    { allow: ['target_overwrite'] }
  );
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.missingApprovals, []);
});

test('connection descriptors persist secret references but never resolved secret values', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-config-'));
  try {
    const store = new ConfigStore({ stateDir });
    await store.putConnection('source', {
      type: 'sqlite',
      config: { database: './legacy.db' },
      secretRefs: { password: { provider: 'env', key: 'LEGACY_DB_PASSWORD' } }
    });

    const saved = await store.getConnection('source');
    assert.equal(saved.name, 'source');
    assert.equal(saved.type, 'sqlite');
    assert.equal(saved.secretRefs.password.key, 'LEGACY_DB_PASSWORD');

    const raw = await readFile(join(stateDir, 'connections.json'), 'utf8');
    assert.doesNotMatch(raw, /actual-secret-value/);
    assert.match(raw, /LEGACY_DB_PASSWORD/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('connection store rejects raw secret-shaped config values', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-config-'));
  try {
    const store = new ConfigStore({ stateDir });
    await assert.rejects(
      () => store.putConnection('unsafe', { type: 'remote', config: { password: 'actual-secret-value' } }),
      /secret|credential|password/i
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
