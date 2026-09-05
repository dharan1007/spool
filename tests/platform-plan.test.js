import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256Json } from '../src/platform/canonical-json.js';
import { createMigrationPlan, validateMigrationPlan } from '../src/platform/plan.js';

test('canonical JSON and plan hash are stable across object key order', async () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(await sha256Json({ b: 2, a: 1 }), await sha256Json({ a: 1, b: 2 }));
});

test('plan identity excludes volatile creation time but binds migration semantics', async () => {
  const base = {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'input/customers.csv', identity: 'sha256:abc' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'field', name: 'id' } }],
    writeStrategy: { mode: 'insert', batchSize: 500 },
    verification: { checks: ['processed_count', 'target_count'] },
    risk: { level: 'low', approvals: [] }
  };

  const a = await createMigrationPlan({ ...base, createdAt: '2026-09-05T00:00:00.000Z' });
  const b = await createMigrationPlan({ ...base, createdAt: '2026-09-05T01:00:00.000Z' });

  assert.equal(a.planId, b.planId);
  assert.match(a.planId, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotThrow(() => validateMigrationPlan(a));
});

test('connector references reject embedded secret-shaped fields', async () => {
  const input = {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'input.csv', token: 'must-not-persist' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'field', name: 'id' } }],
    writeStrategy: { mode: 'insert', batchSize: 500 },
    verification: { checks: ['processed_count'] },
    risk: { level: 'low', approvals: [] }
  };

  await assert.rejects(() => createMigrationPlan(input), /secret|reference/i);
});
