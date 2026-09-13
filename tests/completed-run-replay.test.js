import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpoolCommandService, migrationRequestSemanticId } from '../src/daemon/command-service.js';

const PLAN_ID = `sha256:${'1'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'2'.repeat(64)}`;
const COMMIT_SHA = '3'.repeat(40);

async function makeService(t, counters) {
  const root = await mkdtemp(join(tmpdir(), 'spool-complete-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new SpoolCommandService({
    sourcePolicy: Object.freeze({}),
    sourceCoordinator: Object.freeze({
      async prepare() {
        counters.source += 1;
        throw Object.assign(new Error('source must not be touched for completed replay'), { code: 'SOURCE_SHOULD_NOT_BE_TOUCHED' });
      }
    }),
    targetConnectors: Object.freeze({
      async open() {
        counters.target += 1;
        throw Object.assign(new Error('target must not be touched for completed replay'), { code: 'TARGET_SHOULD_NOT_BE_TOUCHED' });
      }
    }),
    statePath: join(root, 'state.sqlite'),
    snapshotRoot: join(root, 'snapshots'),
    approvalSigningKey: 'test-key',
    maxSourceBytes: 1024,
    release: Object.freeze({ version: '1.1.1', commitSha: COMMIT_SHA })
  });
  t.after(() => service.close());
  return service;
}

function request(table = 'orders') {
  return Object.freeze({
    migrationId: 'completed-replay',
    principal: 'operator',
    planInput: Object.freeze({
      sourceRef: Object.freeze({
        connector: 'postgres', endpoint: 'postgresql://source.local:5432/', database: 'app', schema: 'public', table,
        identity: Object.freeze({ user: 'reader' }), secretRef: Object.freeze({ provider: 'env', key: 'SOURCE_SECRET' })
      }),
      targetRef: Object.freeze({
        connector: 'postgres', endpoint: 'postgresql://target.local:5432/', database: 'warehouse', schema: 'public', table: 'orders_copy',
        identity: Object.freeze({ user: 'writer' }), secretRef: Object.freeze({ provider: 'env', key: 'TARGET_SECRET' })
      }),
      mapping: Object.freeze({ id: 'id' }), mappingRevision: 1,
      targetSchema: Object.freeze({ id: Object.freeze({ type: 'number', required: true }) }),
      writeStrategy: Object.freeze({ mode: 'insert', batchSize: 100 }),
      risk: Object.freeze({ approvals: Object.freeze(['target_write']) })
    })
  });
}

function seedCompleted(service, migrationRequest) {
  service.runs.start({
    migrationId: migrationRequest.migrationId,
    planId: PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    targetIdentity: { connector: 'postgres', database: 'warehouse', schema: 'public', table: 'orders_copy' },
    startedAt: '2026-09-13T00:00:00.000Z'
  });
  service.runs.complete({
    migrationId: migrationRequest.migrationId,
    verification: { ok: true },
    receipt: { record: { requestSemanticId: migrationRequestSemanticId(migrationRequest), targetContractId: `sha256:${'4'.repeat(64)}` } },
    completedAt: '2026-09-13T00:01:00.000Z'
  });
}

test('completed replay returns terminal evidence without opening source or target connectors', async t => {
  const counters = { source: 0, target: 0 };
  const service = await makeService(t, counters);
  const migrationRequest = request();
  seedCompleted(service, migrationRequest);
  const replay = await service.run(migrationRequest);
  assert.equal(replay.status, 'COMPLETE');
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.verification, { ok: true });
  assert.equal(counters.source, 0);
  assert.equal(counters.target, 0);
});

test('completed migrationId rejects changed logical request locally without touching connectors', async t => {
  const counters = { source: 0, target: 0 };
  const service = await makeService(t, counters);
  const original = request();
  seedCompleted(service, original);
  await assert.rejects(() => service.run(request('changed_orders')), error => error?.code === 'MIGRATION_ID_REUSE_CONFLICT');
  assert.equal(counters.source, 0);
  assert.equal(counters.target, 0);
});

test('credential reference rotation does not change completed-run semantic identity', () => {
  const base = request();
  const rotated = structuredClone(base);
  rotated.planInput.sourceRef.secretRef = { provider: 'env', key: 'SOURCE_SECRET_ROTATED' };
  rotated.planInput.targetRef.secretRef = { provider: 'env', key: 'TARGET_SECRET_ROTATED' };
  assert.equal(migrationRequestSemanticId(base), migrationRequestSemanticId(rotated));
});
