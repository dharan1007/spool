import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSecretRef } from '../src/platform/secrets.js';
import { redact } from '../src/platform/redact.js';
import { evaluatePlanPolicy } from '../src/platform/policy.js';
import { ConfigStore } from '../src/daemon/config-store.js';

const envRef = key => ({ provider: 'env', key });

test('recursive redaction removes nested secret material without mutating input', () => {
  const input = {
    password: 'p',
    TOKEN: 't',
    nested: { apiKey: 'k', authorization: 'Bearer x', safe: 3 },
    list: [{ credential: 'c', value: 'ok' }]
  };
  const result = redact(input);
  assert.deepEqual(result, {
    password: '[REDACTED]',
    TOKEN: '[REDACTED]',
    nested: { apiKey: '[REDACTED]', authorization: '[REDACTED]', safe: 3 },
    list: [{ credential: '[REDACTED]', value: 'ok' }]
  });
  assert.equal(input.password, 'p');
  assert.notEqual(result, input);
});

test('redaction fail-closes on accessors instead of invoking them', () => {
  let invoked = false;
  const value = {};
  Object.defineProperty(value, 'token', { enumerable: true, get() { invoked = true; return 'secret'; } });
  assert.throws(() => redact(value), /REDACTION_UNSAFE_VALUE/);
  assert.equal(invoked, false);
});

test('environment secret references resolve without being embedded in descriptors', () => {
  assert.equal(resolveSecretRef(envRef('SPOOL_TEST_SECRET'), { SPOOL_TEST_SECRET: 'value' }), 'value');
  assert.throws(() => resolveSecretRef(envRef('SPOOL_MISSING'), {}), /SECRET_NOT_FOUND/);
  assert.throws(() => resolveSecretRef({ provider: 'file', key: 'x' }, {}), /UNSUPPORTED_SECRET_REF/);
});

test('policy evaluation requires every plan approval and fails closed on malformed policy', () => {
  const plan = { risk: { level: 'high', approvals: ['target_overwrite', 'remote_egress'] } };
  assert.deepEqual(evaluatePlanPolicy(plan, { allow: ['target_overwrite'] }), {
    allowed: false,
    requiredApprovals: ['remote_egress', 'target_overwrite'],
    missingApprovals: ['remote_egress']
  });
  assert.deepEqual(evaluatePlanPolicy(plan, { allow: ['remote_egress', 'target_overwrite'] }), {
    allowed: true,
    requiredApprovals: ['remote_egress', 'target_overwrite'],
    missingApprovals: []
  });
  assert.throws(() => evaluatePlanPolicy(plan, { allow: '*' }), /INVALID_POLICY/);
});

test('ConfigStore persists only redacted descriptors and uses atomic replacement', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-config-'));
  const store = new ConfigStore(stateDir);
  const descriptor = {
    name: 'warehouse',
    type: 'sqlite',
    config: { database: './warehouse.db', options: { mode: 'rw' } },
    secretRefs: { password: envRef('WAREHOUSE_PASSWORD') },
    createdAt: '2026-09-05T00:00:00.000Z'
  };

  await store.putConnection('warehouse', descriptor);
  assert.deepEqual(await store.getConnection('warehouse'), descriptor);
  assert.deepEqual(await store.listConnections(), [descriptor]);

  const persisted = JSON.parse(await readFile(join(stateDir, 'connections.json'), 'utf8'));
  assert.deepEqual(persisted, { version: 1, connections: { warehouse: descriptor } });
  await assert.rejects(readFile(join(stateDir, 'connections.json.tmp'), 'utf8'));
});

test('ConfigStore rejects raw secret-shaped config recursively and never overwrites prior state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-config-'));
  const store = new ConfigStore(stateDir);
  const good = {
    name: 'safe',
    type: 'filesystem',
    config: { root: './data' },
    secretRefs: {},
    createdAt: '2026-09-05T00:00:00.000Z'
  };
  await store.putConnection('safe', good);

  await assert.rejects(
    store.putConnection('unsafe', {
      name: 'unsafe',
      type: 'rest',
      config: { nested: { api_key: 'plaintext' } },
      secretRefs: {},
      createdAt: '2026-09-05T00:00:00.000Z'
    }),
    /SECRET_IN_CONNECTION_DESCRIPTOR/
  );

  assert.deepEqual(await store.listConnections(), [good]);
});

test('ConfigStore rejects malformed persisted state rather than silently discarding it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-config-'));
  await writeFile(join(stateDir, 'connections.json'), '{not json', 'utf8');
  const store = new ConfigStore(stateDir);
  await assert.rejects(store.listConnections(), /INVALID_CONFIG_STORE/);
});
