import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { canonicalJson, sha256Canonical } from '../src/platform/canonical-json.js';
import { validateConnectorRef } from '../src/platform/contracts.js';
import { createMigrationPlan, buildPlanIdentityRecord } from '../src/platform/plan.js';

const baseInput = () => ({
  planRevision: 1,
  sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'input/customers.csv', snapshot: { sha256: 'abc' } },
  targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'customers' },
  targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
  mapping: [{ target: 'id', expr: { op: 'field', name: 'id' } }],
  mappingRevision: 3,
  writeStrategy: { mode: 'insert', batchSize: 500 },
  verification: { checks: ['processed_count', 'target_count'] },
  risk: { level: 'low', approvals: [] },
  capabilityAssumptions: { source: { streaming: true }, target: { transactions: true } },
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:01:00.000Z'
});

test('canonical JSON sorts object keys, preserves arrays, and normalizes negative zero', () => {
  assert.equal(canonicalJson({ b: 2, a: [3, { y: -0, x: true }] }), '{"a":[3,{"x":true,"y":0}],"b":2}');
});

test('canonicalization rejects every unsupported v1 value instead of silently dropping it', () => {
  const cycle = {}; cycle.self = cycle;
  class Custom { constructor() { this.x = 1; } }
  const bad = [
    { a: undefined }, { a: NaN }, { a: Infinity }, { a: -Infinity }, { a: 1n }, cycle,
    { a: new Date() }, { a: new Uint8Array([1]) }, { a() {} }, { a: Symbol('x') }, new Custom()
  ];
  for (const value of bad) assert.throws(() => canonicalJson(value), /CANONICAL_/);
});

test('canonical hash is domain separated', () => {
  assert.notEqual(sha256Canonical('spool-plan-v1', { a: 1 }), sha256Canonical('other-domain', { a: 1 }));
});

test('connector references reject resolved credentials and credential-bearing URLs recursively', () => {
  assert.throws(() => validateConnectorRef({ connector: 'sqlite', resource: 'x', nested: { password: 'secret' } }), /SECRET_IN_CONNECTOR_REF/);
  assert.throws(() => validateConnectorRef({ connector: 'rest', resource: 'https://user:pass@example.com/items' }), /SECRET_IN_CONNECTOR_REF/);
  assert.throws(() => validateConnectorRef({ connector: 'rest', resource: '/items', snapshot: { origin: 'https://u:p@example.com' } }), /SECRET_IN_CONNECTOR_REF/);
  assert.throws(() => validateConnectorRef({ connector: 'rest', resource: '/items', authorization: 'Bearer x' }), /SECRET_IN_CONNECTOR_REF/);
  assert.doesNotThrow(() => validateConnectorRef({ connector: 'rest', connectionId: 'api', resource: '/items', secretRef: { provider: 'env', key: 'API_TOKEN' } }));
});

test('equal semantic plans with different key insertion order have identical IDs and volatile fields do not bind identity', async () => {
  const a = baseInput();
  const b = { ...baseInput(), targetRef: { resource: 'customers', connectionId: 'dst', connector: 'sqlite' }, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T01:00:00.000Z' };
  const pa = await createMigrationPlan(a);
  const pb = await createMigrationPlan(b);
  assert.equal(pa.planId, pb.planId);
  assert.equal(pa.identityAlgorithm, 'spool-plan-v1');
});

test('semantic identity changes alter the plan ID', async () => {
  const original = await createMigrationPlan(baseInput());
  for (const mutate of [
    x => { x.sourceRef.resource = 'input/other.csv'; },
    x => { x.targetRef.resource = 'other'; },
    x => { x.mapping[0].expr.name = 'other_id'; },
    x => { x.verification.checks.push('sample_hash'); },
    x => { x.risk.approvals.push('target_overwrite'); },
    x => { x.capabilityAssumptions.target.transactions = false; }
  ]) {
    const next = baseInput(); mutate(next);
    assert.notEqual((await createMigrationPlan(next)).planId, original.planId);
  }
});

test('plan identity is stable in a fresh node process', async () => {
  const plan = await createMigrationPlan(baseInput());
  const script = `import { createMigrationPlan } from './src/platform/plan.js';\nconst input=${JSON.stringify(baseInput())};\nconsole.log((await createMigrationPlan(input)).planId);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), plan.planId);
});

test('authoritative plan is deeply immutable', async () => {
  const plan = await createMigrationPlan(baseInput());
  for (const mutate of [
    () => { plan.mapping[0].expr.name = 'x'; },
    () => { plan.targetSchema[0].name = 'x'; },
    () => { plan.verification.checks.push('x'); },
    () => { plan.risk.level = 'high'; },
    () => { plan.sourceRef.resource = 'x'; },
    () => { plan.targetRef.resource = 'x'; },
    () => { plan.writeStrategy.mode = 'upsert'; },
    () => { plan.capabilityAssumptions.target.transactions = false; }
  ]) assert.throws(mutate, TypeError);
});

test('identity record contains only explicit semantic fields and no raw secret material', async () => {
  const input = baseInput();
  input.sourceRef.secretRef = { provider: 'env', key: 'SOURCE_PASSWORD' };
  const identity = buildPlanIdentityRecord(input);
  const json = canonicalJson(identity);
  assert.doesNotMatch(json, /SOURCE_PASSWORD|secretRef|createdAt|updatedAt/);
  assert.doesNotMatch(json, /password\s*[:=]\s*[^\"]+/i);
});

test('credential reference rotation does not alter semantic plan identity', async () => {
  const a = baseInput();
  const b = baseInput();
  a.sourceRef.secretRef = { provider: 'env', key: 'SOURCE_PASSWORD_V1' };
  b.sourceRef.secretRef = { provider: 'env', key: 'SOURCE_PASSWORD_V2' };
  assert.equal((await createMigrationPlan(a)).planId, (await createMigrationPlan(b)).planId);
});
