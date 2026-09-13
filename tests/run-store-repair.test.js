import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/daemon/run-store.js';

const hash = char => `sha256:${char.repeat(64)}`;
const AT = '2026-09-13T00:00:00.000Z';

function started(store, migrationId = 'repair-run-1') {
  store.start({
    migrationId, planId: hash('1'), sourceSnapshotId: hash('2'),
    targetIdentity: { connector: 'postgres', resource: 'public.orders' },
    startedAt: AT
  });
}

function op(repairPlanId, keyId, effect = 'UPDATE', applied = true) {
  return {
    migrationId: 'repair-run-1', repairPlanId, keyId, effect, applied,
    observedRowHash: hash('a'), writtenRowHash: effect === 'DELETE' ? null : hash('b'),
    attemptedAt: AT
  };
}

test('run store durably preserves repair operations and the repair outcome across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-repair-'));
  const path = join(dir, 'runs.db');
  let store = new RunStore({ path });
  try {
    started(store);
    assert.equal(store.get('repair-run-1').repair, null);
    store.saveRepairOperation(op(hash('3'), hash('4')));
    store.saveRepairOperation(op(hash('3'), hash('5'), 'INSERT'));
    store.completeRepair({
      migrationId: 'repair-run-1',
      repair: { repairPlanIds: [hash('3')], receipt: { receiptId: hash('6') } },
      completedAt: AT
    });
    store.close();

    store = new RunStore({ path });
    const run = store.get('repair-run-1');
    assert.equal(run.status, 'REPAIR_COMPLETE');
    assert.equal(run.receipt, null);
    assert.equal(run.lastErrorCode, null);
    assert.deepEqual(run.repair.repairPlanIds, [hash('3')]);
    assert.equal(run.repair.receipt.receiptId, hash('6'));
    const ops = store.repairOperations('repair-run-1');
    assert.equal(ops.length, 2);
    assert.ok(ops.every(item => item.applied === true));
    assert.deepEqual(ops.map(item => item.effect), ['UPDATE', 'INSERT']);
  } finally {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('repair operation evidence is idempotently replaceable and scoped per migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-repair-retry-'));
  const path = join(dir, 'runs.db');
  const store = new RunStore({ path });
  try {
    started(store);
    store.saveRepairOperation(op(hash('3'), hash('4'), 'UPDATE', true));
    store.saveRepairOperation(op(hash('3'), hash('4'), 'UPDATE', false));
    const ops = store.repairOperations('repair-run-1');
    assert.equal(ops.length, 1);
    assert.equal(ops[0].applied, false);
    assert.deepEqual(store.repairOperations('other-migration'), []);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new execution or a new verification failure discards stale repair evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-repair-reset-'));
  const path = join(dir, 'runs.db');
  const store = new RunStore({ path });
  try {
    started(store);
    store.saveRepairOperation(op(hash('3'), hash('4')));
    store.completeRepair({ migrationId: 'repair-run-1', repair: { repairPlanIds: [hash('3')] }, completedAt: AT });
    assert.equal(store.get('repair-run-1').status, 'REPAIR_COMPLETE');

    started(store);
    assert.equal(store.get('repair-run-1').repair, null);
    assert.deepEqual(store.repairOperations('repair-run-1'), []);

    store.saveRepairOperation(op(hash('3'), hash('4')));
    store.verificationFailed({ migrationId: 'repair-run-1', verification: { status: 'DIFF' } });
    assert.equal(store.get('repair-run-1').status, 'VERIFICATION_FAILED');
    assert.equal(store.get('repair-run-1').repair, null);
    assert.deepEqual(store.repairOperations('repair-run-1'), []);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
