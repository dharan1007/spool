import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpoolCommandService, migrationRequestSemanticId } from '../src/daemon/command-service.js';

const PLAN_ID = `sha256:${'1'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'2'.repeat(64)}`;

async function makeService(t, counters) {
  const root = await mkdtemp(join(tmpdir(), 'spool-complete-terminal-'));
  const service = new SpoolCommandService({
    sourcePolicy: Object.freeze({}),
    sourceCoordinator: Object.freeze({ async prepare() { counters.source += 1; throw Object.assign(new Error('unexpected source access'), { code: 'SOURCE_SHOULD_NOT_BE_TOUCHED' }); } }),
    targetConnectors: Object.freeze({ async open() { counters.target += 1; throw Object.assign(new Error('unexpected target access'), { code: 'TARGET_SHOULD_NOT_BE_TOUCHED' }); } }),
    statePath: join(root, 'state.sqlite'),
    snapshotRoot: join(root, 'snapshots'),
    approvalSigningKey: 'test-key',
    maxSourceBytes: 1024,
    release: Object.freeze({ version: '1.1.1', commitSha: '3'.repeat(40) })
  });
  t.after(() => service.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  return service;
}

function request(resource = 'public.orders') {
  return Object.freeze({
    migrationId: 'completed-replay',
    principal: 'operator',
    planInput: Object.freeze({
      sourceRef: Object.freeze({ connector: 'postgres', resource }),
      targetRef: Object.freeze({ connector: 'postgres', resource: 'public.orders_copy' }),
      mapping: Object.freeze({ id: 'id' }),
      mappingRevision: 1,
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
    targetIdentity: { connector: 'postgres', resource: 'public.orders_copy' },
    startedAt: '2026-09-13T00:00:00.000Z'
  });
  service.runs.complete({
    migrationId: migrationRequest.migrationId,
    verification: { ok: true },
    receipt: { record: { requestSemanticId: migrationRequestSemanticId(migrationRequest), targetContractId: `sha256:${'4'.repeat(64)}` } },
    completedAt: '2026-09-13T00:01:00.000Z'
  });
}

test('completed replay returns terminal evidence without opening connectors', async t => {
  const counters = { source: 0, target: 0 };
  const service = await makeService(t, counters);
  const migrationRequest = request();
  seedCompleted(service, migrationRequest);
  const replay = await service.run(migrationRequest);
  assert.equal(replay.status, 'COMPLETE');
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.verification, { ok: true });
  assert.deepEqual(counters, { source: 0, target: 0 });
});

test('completed migrationId rejects changed logical request without opening connectors', async t => {
  const counters = { source: 0, target: 0 };
  const service = await makeService(t, counters);
  seedCompleted(service, request());
  await assert.rejects(() => service.run(request('public.changed_orders')), error => error?.code === 'MIGRATION_ID_REUSE_CONFLICT');
  assert.deepEqual(counters, { source: 0, target: 0 });
});
