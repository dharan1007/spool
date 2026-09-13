import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/daemon/run-store.js';

const hash = char => `sha256:${char.repeat(64)}`;
const AT = '2026-09-13T00:00:00.000Z';

function arm(store, migrationId = 'cutover-1') {
  return store.beginCutover({
    migrationId,
    receiptId: hash('a'),
    receiptKind: 'migration',
    planId: hash('1'),
    sourceSnapshotId: hash('2'),
    targetIdentity: { connector: 'sqlite', resource: 'rows' },
    targetContractId: hash('3'),
    armedAt: AT
  });
}

test('cutover arms, commits and aborts with durable evidence across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-cutover-'));
  const path = join(dir, 'runs.db');
  let store = new RunStore({ path });
  try {
    assert.equal(store.cutover('cutover-1'), null);
    const armed = arm(store);
    assert.equal(armed.status, 'ARMED');
    assert.equal(armed.receiptKind, 'migration');
    assert.equal(armed.commitEvidence, null);

    const replayed = arm(store);
    assert.equal(replayed.status, 'ARMED');

    const committed = store.commitCutover({
      migrationId: 'cutover-1',
      commitEvidence: { targetContractId: hash('3'), fencingToken: 9, fenced: true, committedAt: AT },
      decidedAt: AT
    });
    assert.equal(committed.status, 'COMMITTED');
    assert.equal(committed.commitEvidence.fencingToken, 9);
    store.close();

    store = new RunStore({ path });
    const run = store.cutover('cutover-1');
    assert.equal(run.status, 'COMMITTED');
    assert.equal(run.decidedAt, AT);
    assert.throws(() => arm(store), error => error?.code === 'CUTOVER_STATE_CONFLICT');
    assert.throws(
      () => store.commitCutover({ migrationId: 'cutover-1', commitEvidence: {}, decidedAt: AT }),
      error => error?.code === 'CUTOVER_STATE_CONFLICT'
    );
    assert.throws(
      () => store.abortCutover({ migrationId: 'cutover-1', reason: 'too late', decidedAt: AT }),
      error => error?.code === 'CUTOVER_STATE_CONFLICT'
    );
  } finally {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('cutover abort records the reason and allows re-arming', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-cutover-abort-'));
  const path = join(dir, 'runs.db');
  const store = new RunStore({ path });
  try {
    arm(store, 'cutover-2');
    const aborted = store.abortCutover({ migrationId: 'cutover-2', reason: 'contract drift observed', decidedAt: AT });
    assert.equal(aborted.status, 'ABORTED');
    assert.equal(aborted.abortReason, 'contract drift observed');
    const rearmed = arm(store, 'cutover-2');
    assert.equal(rearmed.status, 'ARMED');
    assert.equal(rearmed.abortReason, null);
    assert.throws(
      () => store.commitCutover({ migrationId: 'cutover-unknown', commitEvidence: {}, decidedAt: AT }),
      error => error?.code === 'CUTOVER_STATE_CONFLICT'
    );
    assert.throws(
      () => store.abortCutover({ migrationId: 'cutover-unknown', reason: 'x', decidedAt: AT }),
      error => error?.code === 'CUTOVER_STATE_CONFLICT'
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
