import test from 'node:test';
import assert from 'node:assert/strict';
import { MigrationRunner } from '../src/execution/migration-runner.js';

const planId = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const sourceSnapshotId = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const payloadHash = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

function input(overrides = {}) {
  return {
    migrationId: 'mig_async_target_001',
    planId,
    sourceSnapshotId,
    mappingRevision: 1,
    sourceRange: { start: 0, endExclusive: 2 },
    targetIdentity: {
      connector: 'postgresql',
      connectionId: 'prod',
      resource: 'public.customers',
      endpoint: 'postgres.example.internal',
      database: 'app',
      schema: 'public',
      table: 'customers'
    },
    rows: [{ id: 1 }, { id: 2 }],
    ...overrides
  };
}

function asyncCheckpointStore() {
  let value = null;
  return {
    async load() { await Promise.resolve(); return value; },
    async save(next) { await Promise.resolve(); value = next; },
    current() { return value; }
  };
}

function asyncTarget() {
  let committed = null;
  return {
    async describeBatch(batch) {
      await Promise.resolve();
      return { rowCount: batch.rows.length, payloadHash };
    },
    async reconcileTargetCommit(evidence) {
      await Promise.resolve();
      if (!committed) return { status: 'NOT_COMMITTED', batchIdentity: evidence.batchIdentity };
      if (committed.batchIdentity !== evidence.batchIdentity || committed.payloadHash !== evidence.payloadHash || committed.rowCount !== evidence.rowCount) {
        return { status: 'CONFLICT', batchIdentity: evidence.batchIdentity };
      }
      return { status: 'COMMITTED_EXACT', ...committed };
    },
    async commitBatch(batch) {
      await Promise.resolve();
      committed = {
        batchIdentity: batch.batchIdentity,
        rowCount: batch.rows.length,
        payloadHash
      };
      return { status: 'COMMITTED_EXACT', alreadyCommitted: false, ...committed };
    },
    committed() { return committed; }
  };
}

test('async runner awaits a network-style target and persists checkpoint only after exact commit evidence', async () => {
  const target = asyncTarget();
  const checkpointStore = asyncCheckpointStore();
  const runner = new MigrationRunner({ target, checkpointStore });

  const result = await runner.runBatchAsync(input());

  assert.equal(result.status, 'COMMITTED_EXACT');
  assert.equal(result.recovered, false);
  assert.equal(result.alreadyCheckpointed, false);
  assert.equal(result.rowCount, 2);
  assert.equal(target.committed().batchIdentity, result.batchIdentity);
  assert.equal(checkpointStore.current().lastBatchIdentity, result.batchIdentity);
  assert.equal(checkpointStore.current().nextOffset, 2);
});

test('async runner reconciles commit-before-checkpoint crash without replaying target mutation', async () => {
  const target = asyncTarget();
  const checkpointStore = asyncCheckpointStore();
  const runner = new MigrationRunner({ target, checkpointStore });
  const batch = input({ migrationId: 'mig_async_crash_001' });

  await assert.rejects(
    runner.runBatchAsync(batch, { faultAfterTargetCommit: true }),
    error => error?.code === 'FAULT_AFTER_TARGET_COMMIT'
  );
  const committed = target.committed();
  assert.ok(committed);
  assert.equal(checkpointStore.current(), null);

  const recovered = await runner.runBatchAsync(batch);
  assert.equal(recovered.status, 'COMMITTED_EXACT');
  assert.equal(recovered.recovered, true);
  assert.deepEqual(target.committed(), committed);
  assert.equal(checkpointStore.current().lastBatchIdentity, recovered.batchIdentity);
});

test('async runner fails closed when reconciliation is indeterminate', async () => {
  const checkpointStore = asyncCheckpointStore();
  const target = {
    async describeBatch(batch) { return { rowCount: batch.rows.length, payloadHash }; },
    async reconcileTargetCommit() { return { status: 'INDETERMINATE' }; },
    async commitBatch() { assert.fail('indeterminate reconciliation must not write'); }
  };
  const runner = new MigrationRunner({ target, checkpointStore });

  await assert.rejects(
    runner.runBatchAsync(input({ migrationId: 'mig_async_indeterminate_001' })),
    error => error?.code === 'TARGET_RECONCILIATION_INDETERMINATE'
  );
  assert.equal(checkpointStore.current(), null);
});
