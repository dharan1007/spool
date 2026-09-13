import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/daemon/run-store.js';

const hash = char => `sha256:${char.repeat(64)}`;

function proof(id, status = 'VERIFIED') {
  return {
    schemaVersion: 1,
    level: 'CONTENT_EXACT',
    status,
    verificationId: hash(id),
    primaryKey: ['id'],
    columns: ['id', 'name'],
    expected: { rowCount: 1, rootHash: hash('a') },
    actual: { rowCount: status === 'VERIFIED' ? 1 : 0, rootHash: hash('b') },
    diff: { counts: { missing: status === 'VERIFIED' ? 0 : 1, mismatch: 0, unexpected: 0 }, total: status === 'VERIFIED' ? 0 : 1, entries: [] }
  };
}

test('run store durably preserves per-batch verification and repair evidence across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-verification-'));
  const path = join(dir, 'runs.db');
  let store = new RunStore({ path });
  try {
    store.start({
      migrationId: 'm1', planId: hash('1'), sourceSnapshotId: hash('2'),
      targetIdentity: { connector: 'postgres', resource: 'public.orders' },
      startedAt: '2026-09-13T00:00:00.000Z'
    });
    store.clearVerificationBatches('m1');
    store.saveVerificationBatch({
      migrationId: 'm1', ordinal: 0, sourceRange: { start: 0, endExclusive: 1 },
      verification: proof('3'), repair: null
    });
    store.saveVerificationBatch({
      migrationId: 'm1', ordinal: 1, sourceRange: { start: 1, endExclusive: 2 },
      verification: proof('4', 'DIFF'),
      repair: { schemaVersion: 1, repairPlanId: hash('5'), operations: [{ effect: 'INSERT', key: { id: 2 } }] }
    });
    const summary = {
      status: 'DIFF', accounting: { sourceRows: 2, writtenRows: 2, rejectedRows: 0, filteredRows: 0 },
      content: { schemaVersion: 1, level: 'CONTENT_EXACT', status: 'DIFF', rootHash: hash('6') }
    };
    store.verificationFailed({ migrationId: 'm1', verification: summary });
    store.close();

    store = new RunStore({ path });
    const run = store.get('m1');
    assert.equal(run.status, 'VERIFICATION_FAILED');
    assert.equal(run.receipt, null);
    assert.equal(run.lastErrorCode, 'VERIFICATION_FAILED');
    assert.equal(run.verification.content.rootHash, hash('6'));
    const batches = store.verificationBatches('m1');
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map(item => item.ordinal), [0, 1]);
    assert.equal(batches[0].repair, null);
    assert.equal(batches[1].repair.repairPlanId, hash('5'));
    assert.deepEqual(batches[1].sourceRange, { start: 1, endExclusive: 2 });
  } finally {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification batch evidence is idempotently replaceable and explicitly clearable for a new verification attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-verification-retry-'));
  const path = join(dir, 'runs.db');
  const store = new RunStore({ path });
  try {
    store.start({
      migrationId: 'm2', planId: hash('1'), sourceSnapshotId: hash('2'),
      targetIdentity: { connector: 'postgres', resource: 'public.orders' },
      startedAt: '2026-09-13T00:00:00.000Z'
    });
    store.saveVerificationBatch({ migrationId: 'm2', ordinal: 0, sourceRange: { start: 0, endExclusive: 1 }, verification: proof('3'), repair: null });
    store.saveVerificationBatch({ migrationId: 'm2', ordinal: 0, sourceRange: { start: 0, endExclusive: 1 }, verification: proof('4'), repair: null });
    assert.equal(store.verificationBatches('m2')[0].verification.verificationId, hash('4'));
    store.clearVerificationBatches('m2');
    assert.deepEqual(store.verificationBatches('m2'), []);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
