import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/daemon/run-store.js';
import { MIGRATION_STATES } from '../src/protocol/migration-state-machine.js';
import { canonicalJson } from '../src/platform/canonical-json.js';

const hash = char => `sha256:${Number(String(char).charCodeAt(0)).toString(16).padStart(64, '0')}`;
const planId = hash('p'), sourceStateId = hash('s'), targetContractId = hash('t');

function failedStore(path, migrationId = 'mig-recover') {
  const store = new RunStore({ path });
  store.initializeMigration(migrationId, { principal: 'alice', reason: 'init' });
  for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) {
    store.transition(migrationId, { nextState: st, principal: 'alice', reason: 'x' });
  }
  store.transition(migrationId, { nextState: MIGRATION_STATES.APPROVED, principal: 'alice', reason: 'x', planId, sourceStateId, targetContractId, context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId } });
  store.transition(migrationId, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
  store.transition(migrationId, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
  store.transition(migrationId, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });
  store.fail({ migrationId, errorCode: 'TARGET_UNAVAILABLE' });
  assert.equal(store.getMigrationState(migrationId).currentState, MIGRATION_STATES.FAILED_RECOVERABLE);
  return store;
}

test('FAILED_RECOVERABLE recovers to SNAPSHOT_ARMED with operator evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-recover-'));
  const path = join(dir, 'state.db');
  const store = failedStore(path);
  try {
    const recovered = store.beginRecovery({
      migrationId: 'mig-recover', principal: 'operator:carol',
      reason: 'target restored, restarting load phase', targetState: MIGRATION_STATES.SNAPSHOT_ARMED
    });
    assert.equal(recovered.currentState, MIGRATION_STATES.SNAPSHOT_ARMED);
    const transitions = store.listTransitions('mig-recover').map(t => t.nextState);
    assert.ok(transitions.includes(MIGRATION_STATES.RECOVERY_PENDING));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery to FULL_LOAD_RUNNING requires a bound durable checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-recover-ckpt-'));
  const path = join(dir, 'state.db');
  const store = failedStore(path);
  try {
    // No checkpoint -> refuse resume at FULL_LOAD_RUNNING.
    assert.throws(() => store.beginRecovery({
      migrationId: 'mig-recover', principal: 'operator:carol',
      reason: 'resume', targetState: MIGRATION_STATES.FULL_LOAD_RUNNING
    }), /RECOVERY_EVIDENCE_REQUIRED/);
    // Checkpoint bound to another plan -> refuse.
    store.checkpointStore('mig-recover').save({
      migrationId: 'mig-recover', planId: hash('9'), sourceSnapshotId: sourceStateId,
      mappingRevision: 1, targetIdentity: { t: 1 }, nextOffset: 1000, lastBatchIdentity: hash('b')
    });
    assert.throws(() => store.beginRecovery({
      migrationId: 'mig-recover', principal: 'operator:carol',
      reason: 'resume', targetState: MIGRATION_STATES.FULL_LOAD_RUNNING
    }), /RECOVERY_EVIDENCE_REQUIRED/);
    // Matching checkpoint -> resume.
    store.checkpointStore('mig-recover').save({
      migrationId: 'mig-recover', planId, sourceSnapshotId: sourceStateId,
      mappingRevision: 1, targetIdentity: { t: 1 }, nextOffset: 1000, lastBatchIdentity: hash('b')
    });
    const recovered = store.beginRecovery({
      migrationId: 'mig-recover', principal: 'operator:carol',
      reason: 'checkpoint proves partial progress', targetState: MIGRATION_STATES.FULL_LOAD_RUNNING
    });
    assert.equal(recovered.currentState, MIGRATION_STATES.FULL_LOAD_RUNNING);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery requires evidence and a safe target, and is deterministic across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-recover-det-'));
  const path = join(dir, 'state.db');
  let store = failedStore(path, 'mig-det');
  try {
    assert.throws(() => store.beginRecovery({
      migrationId: 'mig-det', principal: 'operator:carol',
      reason: '', targetState: MIGRATION_STATES.SNAPSHOT_ARMED
    }), /RECOVERY_EVIDENCE_REQUIRED/);
    assert.throws(() => store.beginRecovery({
      migrationId: 'mig-det', principal: 'operator:carol',
      reason: 'x', targetState: MIGRATION_STATES.VERIFYING
    }), /RECOVERY_TARGET_INVALID/);
    assert.throws(() => store.beginRecovery({
      migrationId: 'mig-nope', principal: 'operator:carol',
      reason: 'x', targetState: MIGRATION_STATES.SNAPSHOT_ARMED
    }), /RECOVERY_NOT_REQUIRED/);
    const seqBefore = store.getMigrationState('mig-det').sequence;
    store.beginRecovery({
      migrationId: 'mig-det', principal: 'operator:carol',
      reason: 'target restored', targetState: MIGRATION_STATES.SNAPSHOT_ARMED,
      commandId: 'recovery-1'
    });
    // Two transitions committed atomically (PENDING + arrival).
    assert.equal(store.getMigrationState('mig-det').sequence, seqBefore + 2);
    assert.equal(store.getMigrationState('mig-det').currentState, MIGRATION_STATES.SNAPSHOT_ARMED);
    // Idempotent retry with the same command after restart returns the
    // current (recovered) state instead of failing.
    store.close();
    store = new RunStore({ path });
    const retry = store.beginRecovery({
      migrationId: 'mig-det', principal: 'operator:carol',
      reason: 'target restored', targetState: MIGRATION_STATES.SNAPSHOT_ARMED,
      commandId: 'recovery-1'
    });
    assert.equal(retry.currentState, MIGRATION_STATES.SNAPSHOT_ARMED);
  } finally {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery intent and effect commit atomically: no bare RECOVERY_PENDING survives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-recover-atomic-'));
  const path = join(dir, 'state.db');
  const store = failedStore(path, 'mig-atomic');
  try {
    // A failing arrival (bad target) rolls back the PENDING record too.
    assert.throws(() => store.beginRecovery({
      migrationId: 'mig-atomic', principal: 'operator:carol',
      reason: 'x', targetState: 'VERIFYING'
    }), /RECOVERY_TARGET_INVALID/);
    assert.equal(store.getMigrationState('mig-atomic').currentState, MIGRATION_STATES.FAILED_RECOVERABLE);
    assert.ok(!store.listTransitions('mig-atomic').some(t => t.nextState === MIGRATION_STATES.RECOVERY_PENDING));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
