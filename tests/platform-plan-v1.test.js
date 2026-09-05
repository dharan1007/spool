import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/platform/canonical-json.js';
import { createMigrationPlan } from '../src/platform/plan.js';

function basePlan() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'input/customers.csv', identity: 'sha256:abc' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'field', name: 'id' } }],
    writeStrategy: { mode: 'insert', batchSize: 500 },
    verification: { checks: ['processed_count', 'target_count'] },
    risk: { level: 'low', approvals: [] }
  };
}

test('plan identity is explicitly versioned and remains stable across volatile creation time', async () => {
  const a = await createMigrationPlan({ ...basePlan(), createdAt: '2026-09-05T00:00:00.000Z' });
  const b = await createMigrationPlan({ ...basePlan(), createdAt: '2026-09-05T01:00:00.000Z' });
  assert.equal(a.identityVersion, 'spool-plan-v1');
  assert.equal(a.planId, b.planId);
});

test('returned plan is deeply immutable', async () => {
  const plan = await createMigrationPlan(basePlan());
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.sourceRef), true);
  assert.equal(Object.isFrozen(plan.targetSchema), true);
  assert.equal(Object.isFrozen(plan.targetSchema[0]), true);
  assert.throws(() => { plan.sourceRef.resource = 'other.csv'; }, TypeError);
  assert.throws(() => { plan.targetSchema[0].name = 'changed'; }, TypeError);
});

test('strict canonical JSON rejects ambiguous or non-deterministic values', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson({ value: undefined }), /canonical|unsupported|undefined/i);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /canonical|finite|number/i);
  assert.throws(() => canonicalJson({ value: Infinity }), /canonical|finite|number/i);
  assert.throws(() => canonicalJson({ value: 1n }), /canonical|unsupported|bigint/i);
  assert.throws(() => canonicalJson(cyclic), /canonical|circular|cycle/i);
});

test('plan identity changes when migration semantics change', async () => {
  const a = await createMigrationPlan(basePlan());
  const changed = basePlan();
  changed.writeStrategy.batchSize = 501;
  const b = await createMigrationPlan(changed);
  assert.notEqual(a.planId, b.planId);
});
