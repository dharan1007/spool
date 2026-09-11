import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSqliteTargetRuntime, SQLITE_TARGET_DESCRIPTOR } from '../src/connectors/sqlite/runtime.js';

const PLAN_ID = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SNAPSHOT_ID = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BATCH_ID = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'spool-sqlite-runtime-'));
  const path = join(root, 'target.db');
  const db = new Database(path);
  db.exec('CREATE TABLE customers (id INTEGER NOT NULL, name TEXT NOT NULL);');
  db.close();
  return { root, path, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

function planInput(path = 'target.db') {
  return {
    targetRef: { connector: 'sqlite', path, table: 'customers' },
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ],
    writeStrategy: { mode: 'insert', batchSize: 100 },
    risk: { approvals: ['target_write'] }
  };
}

test('SQLite target descriptor advertises the production guarantees Gate B actually proves', () => {
  assert.equal(SQLITE_TARGET_DESCRIPTOR.name, 'sqlite');
  assert.equal(SQLITE_TARGET_DESCRIPTOR.role, 'target');
  assert.equal(SQLITE_TARGET_DESCRIPTOR.capabilities.transactions, true);
  assert.equal(SQLITE_TARGET_DESCRIPTOR.capabilities.atomicBatchLedger, true);
  assert.equal(SQLITE_TARGET_DESCRIPTOR.capabilities.reconcileAfterCrash, true);
  assert.equal(SQLITE_TARGET_DESCRIPTOR.capabilities.idempotentReplay, true);
  assert.equal(SQLITE_TARGET_DESCRIPTOR.capabilities.fencing, true);
});

test('runtime normalizes a local SQLite target and performs contract-bound preflight', async () => {
  const fx = await fixture();
  try {
    const runtime = await createSqliteTargetRuntime({ targetRoot: fx.root });
    const normalized = await runtime.normalizePlanInput(planInput());
    assert.equal(normalized.targetRef.path, fx.path);

    const preflight = runtime.preflight(normalized);
    assert.equal(preflight.status, 'READY');
    assert.match(preflight.targetContractId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(preflight.table, 'customers');

    assert.deepEqual(runtime.approvalEffects(normalized), [
      'approval:target_write',
      'sqlite:insert_rows',
      'sqlite:write_batch_ledger'
    ]);
  } finally {
    await fx.cleanup();
  }
});

test('runtime owns SQLite-specific target validation instead of leaking it into the command service', async () => {
  const fx = await fixture();
  try {
    const runtime = await createSqliteTargetRuntime({ targetRoot: fx.root });

    await assert.rejects(
      runtime.normalizePlanInput({ ...planInput(), targetRef: { ...planInput().targetRef, secretRef: 'secret://db' } }),
      error => error?.code === 'UNSUPPORTED_LOCAL_CONNECTOR_SECRET'
    );
    await assert.rejects(
      runtime.normalizePlanInput({ ...planInput(), writeStrategy: { mode: 'upsert', batchSize: 100 } }),
      error => error?.code === 'UNSUPPORTED_WRITE_STRATEGY'
    );
    await assert.rejects(
      runtime.normalizePlanInput({ ...planInput(), writeStrategy: { mode: 'insert', batchSize: 10001 } }),
      error => error?.code === 'INVALID_WRITE_STRATEGY'
    );
  } finally {
    await fx.cleanup();
  }
});

test('runtime owns durable fencing, target opening, ledger evidence and cleanup', async () => {
  const fx = await fixture();
  try {
    const runtime = await createSqliteTargetRuntime({ targetRoot: fx.root, leaseTtlMs: 60_000 });
    const normalized = await runtime.normalizePlanInput(planInput());
    const preflight = runtime.preflight(normalized);
    const execution = runtime.createExecution({ migrationId: 'mig_runtime_001', targetRef: normalized.targetRef });
    const lease = execution.renewLease({ nowMs: 1_000 });
    const target = execution.openTarget();

    const committed = target.commitBatch({
      batchIdentity: BATCH_ID,
      migrationId: 'mig_runtime_001',
      planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      mappingRevision: 1,
      rows: [{ id: 1, name: 'Ada' }],
      targetContractId: preflight.targetContractId,
      fencingToken: lease.fencingToken,
      nowMs: 1_001
    });
    assert.equal(committed.status, 'COMMITTED_EXACT');

    const ledger = execution.ledgerEntries();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].migrationId, 'mig_runtime_001');
    assert.equal(ledger[0].targetTable, 'customers');

    execution.close();
    assert.equal(execution.close(), undefined);
  } finally {
    await fx.cleanup();
  }
});
