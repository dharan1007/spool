import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/daemon/run-store.js';
import { MIGRATION_STATES, buildCutoverAttemptId } from '../src/protocol/migration-state-machine.js';
import { verificationSemanticId } from '../src/protocol/verification-coordinator.js';

const hash = char => `sha256:${Number(String(char).charCodeAt(0)).toString(16).padStart(64, '0')}`;
const AT = '2026-09-13T00:00:00.000Z';

function verificationRecord({ migrationId, mode, planId, sourceStateId, targetContractId, cutoverAttemptId, status = 'VERIFIED', withDiff = false }) {
  const semantic = {
    schemaVersion: 1,
    migrationId,
    mode,
    planId,
    mappingRevision: 1,
    sourceStateId,
    targetContractId,
    cutoverAttemptId,
    sourceBoundary: { snapshotId: sourceStateId },
    targetBoundary: { contractId: targetContractId },
    cdc: null,
    counts: { sourceRows: 4, validRows: 4, invalidRows: 0 },
    contentRoot: hash('r'),
    levels: { required: ['ROW_COUNT'], completed: ['ROW_COUNT'] },
    invariants: withDiff ? [{ code: 'CONTENT_VERIFICATION_DIFF', message: 'fixture diff' }] : null,
    release: { version: '9.9.9-test', commitSha: '1'.repeat(40) }
  };
  const verificationId = verificationSemanticId(semantic);
  return {
    ...semantic,
    verificationId,
    fenceToken: 7,
    startedAt: '2026-09-13T00:00:00.000Z',
    completedAt: new Date().toISOString(),
    contentProof: null,
    status
  };
}

function armInput(migrationId, armedAt = AT) {
  const planId = hash('1'), sourceSnapshotId = hash('2'), targetContractId = hash('3');
  const cutoverAttemptId = buildCutoverAttemptId({
    migrationId, receiptId: hash('a'), receiptKind: 'migration',
    planId, sourceStateId: sourceSnapshotId, targetContractId, armedAt
  });
  return {
    migrationId, principal: 'alice', receiptId: hash('a'), receiptKind: 'migration',
    planId, sourceSnapshotId, targetIdentity: { connector: 'sqlite', resource: 'rows' },
    targetContractId, armedAt, cutoverAttemptId
  };
}

function readyState(store, migrationId) {
  const planId = hash('1'), sourceStateId = hash('2'), targetContractId = hash('3');
  store.initializeMigration(migrationId, { principal: 'alice', reason: 'init' });
  for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) {
    store.transition(migrationId, { nextState: st, principal: 'alice', reason: 'x' });
  }
  store.transition(migrationId, { nextState: MIGRATION_STATES.APPROVED, principal: 'alice', reason: 'x', planId, sourceStateId, targetContractId, context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId } });
  store.transition(migrationId, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
  store.transition(migrationId, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
  store.transition(migrationId, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });
  store.transition(migrationId, { nextState: MIGRATION_STATES.VERIFYING, principal: 'alice', reason: 'x' });
  store.transition(migrationId, { nextState: MIGRATION_STATES.READY_FOR_CUTOVER, principal: 'alice', reason: 'x', context: { verification: { status: 'VERIFIED' } } });
  return { planId, sourceStateId, targetContractId };
}

test('cutover arms, commits and aborts atomically with durable evidence across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-cutover-'));
  const path = join(dir, 'runs.db');
  let store = new RunStore({ path });
  try {
    assert.equal(store.cutover('cutover-1'), null);
    readyState(store, 'cutover-1');
    const armed = store.armCutoverAtomic(armInput('cutover-1'));
    assert.equal(armed.status, 'ARMED');
    assert.equal(armed.receiptKind, 'migration');
    assert.equal(armed.commitEvidence, null);
    assert.match(armed.cutoverAttemptId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(store.getMigrationState('cutover-1').currentState, MIGRATION_STATES.CUTOVER_ARMED);

    // Idempotent re-arm retry with the same attempt.
    const replayed = store.armCutoverAtomic(armInput('cutover-1'));
    assert.equal(replayed.status, 'ARMED');
    assert.equal(replayed.cutoverAttemptId, armed.cutoverAttemptId);

    const finalRecord = verificationRecord({
      migrationId: 'cutover-1', mode: 'FINAL_PRE_CUTOVER',
      planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3'),
      cutoverAttemptId: armed.cutoverAttemptId
    });
    store.recordFinalVerificationAtomic({
      migrationId: 'cutover-1', principal: 'alice', verification: finalRecord,
      fenceToken: 9, planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3')
    });
    const committed = store.commitCutoverAtomic({
      migrationId: 'cutover-1', principal: 'alice',
      commitEvidence: {
        targetContractId: hash('3'), fencingToken: 9, fenced: true, committedAt: AT,
        sourceWriteBarrier: {
          barrierId: hash('b'), kind: 'POSTGRES_TABLE_SHARE_LOCK',
          acquiredAt: AT, finalLsn: '0/4A1B2C0',
          proof: { backendPid: 4242, heldLockMode: 'ShareLock' },
          externalBarrierId: hash('e'),
          externalPrincipal: 'operator:oncall',
          externalRoutingDecision: 'source traffic frozen',
          zeroDowntime: false
        }
      },
      decidedAt: AT, finalVerificationId: finalRecord.verificationId,
      fenceToken: 9, planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3')
    });
    assert.equal(committed.status, 'COMMITTED');
    assert.equal(committed.commitEvidence.fencingToken, 9);
    store.close();

    store = new RunStore({ path });
    const run = store.cutover('cutover-1');
    assert.equal(run.status, 'COMMITTED');
    assert.equal(run.decidedAt, AT);
    assert.equal(run.commitEvidence.sourceWriteBarrier.kind, 'POSTGRES_TABLE_SHARE_LOCK');
    assert.equal(run.commitEvidence.sourceWriteBarrier.proof.backendPid, 4242);
    assert.equal(run.commitEvidence.sourceWriteBarrier.externalPrincipal, 'operator:oncall');
    assert.equal(run.commitEvidence.sourceWriteBarrier.zeroDowntime, false);
    assert.throws(() => store.armCutoverAtomic(armInput('cutover-1')), /CUTOVER_STATE_CONFLICT/);
    assert.throws(
      () => store.commitCutoverAtomic({
        migrationId: 'cutover-1', principal: 'alice',
        commitEvidence: {}, decidedAt: AT, finalVerificationId: hash('z'),
        fenceToken: 9, planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3')
      }),
      /CUTOVER_ALREADY_COMMITTED/
    );
    // Idempotent retry of the same commit (same bound verification) returns
    // the committed record instead of failing.
    const recommitted = store.commitCutoverAtomic({
      migrationId: 'cutover-1', principal: 'alice',
      commitEvidence: { targetContractId: hash('3'), fencingToken: 9, fenced: true, committedAt: AT },
      decidedAt: AT, finalVerificationId: finalRecord.verificationId,
      fenceToken: 9, planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3')
    });
    assert.equal(recommitted.status, 'COMMITTED');
    assert.throws(
      () => store.abortCutoverAtomic({ migrationId: 'cutover-1', principal: 'alice', reason: 'too late', decidedAt: AT }),
      /CUTOVER_ALREADY_COMMITTED|CUTOVER_STATE_CONFLICT/
    );
  } finally {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('cutover abort records the reason and requires explicit re-arm with a fresh attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-cutover-abort-'));
  const path = join(dir, 'runs.db');
  const store = new RunStore({ path });
  try {
    readyState(store, 'cutover-2');
    const first = store.armCutoverAtomic(armInput('cutover-2'));
    const aborted = store.abortCutoverAtomic({ migrationId: 'cutover-2', principal: 'alice', reason: 'contract drift observed', decidedAt: AT });
    assert.equal(aborted.status, 'ABORTED');
    assert.equal(aborted.abortReason, 'contract drift observed');
    assert.equal(store.getMigrationState('cutover-2').currentState, MIGRATION_STATES.ABORTED);
    // Implicit re-arm through the generic path is rejected: ABORTED needs an
    // explicit rearm context.
    assert.throws(() => store.transition('cutover-2', {
      nextState: MIGRATION_STATES.CUTOVER_ARMED, principal: 'alice', reason: 'implicit',
      planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3')
    }), /CUTOVER_REARM_REQUIRED/);
    // Re-arm with the ABORTED attempt identity is rejected: attempts are single-use.
    assert.throws(() => store.rearmCutoverAtomic({
      ...armInput('cutover-2'), principal: 'alice', reason: 'retry',
      cutoverAttemptId: first.cutoverAttemptId
    }), /CUTOVER_ATTEMPT_MISMATCH/);
    // Explicit re-arm with a fresh attempt succeeds.
    const rearmed = store.rearmCutoverAtomic({
      ...armInput('cutover-2', '2026-09-14T00:00:00.000Z'),
      principal: 'alice', reason: 'drift resolved, re-arming'
    });
    assert.equal(rearmed.status, 'ARMED');
    assert.equal(rearmed.abortReason, null);
    assert.notEqual(rearmed.cutoverAttemptId, first.cutoverAttemptId);
    assert.equal(store.getMigrationState('cutover-2').currentState, MIGRATION_STATES.CUTOVER_ARMED);
    assert.throws(
      () => store.commitCutoverAtomic({ migrationId: 'cutover-unknown', principal: 'alice', commitEvidence: {}, decidedAt: AT, finalVerificationId: hash('z'), fenceToken: 1, planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3') }),
      /CUTOVER_STATE_CONFLICT/
    );
    assert.throws(
      () => store.abortCutoverAtomic({ migrationId: 'cutover-unknown', principal: 'alice', reason: 'x', decidedAt: AT }),
      /CUTOVER_STATE_CONFLICT/
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('commit rejects verification bound to a superseded attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-run-cutover-attempt-'));
  const path = join(dir, 'runs.db');
  const store = new RunStore({ path });
  try {
    readyState(store, 'cutover-3');
    const first = store.armCutoverAtomic(armInput('cutover-3'));
    store.abortCutoverAtomic({ migrationId: 'cutover-3', principal: 'alice', reason: 'window moved', decidedAt: AT });
    const second = store.rearmCutoverAtomic({ ...armInput('cutover-3', '2026-09-14T00:00:00.000Z'), principal: 'alice', reason: 'new window' });
    // A FINAL verification minted for the aborted attempt cannot authorize the new one.
    const staleRecord = verificationRecord({
      migrationId: 'cutover-3', mode: 'FINAL_PRE_CUTOVER',
      planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3'),
      cutoverAttemptId: first.cutoverAttemptId
    });
    store.saveVerification('cutover-3', staleRecord);
    const finalRecord = verificationRecord({
      migrationId: 'cutover-3', mode: 'FINAL_PRE_CUTOVER',
      planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3'),
      cutoverAttemptId: second.cutoverAttemptId
    });
    store.recordFinalVerificationAtomic({
      migrationId: 'cutover-3', principal: 'alice', verification: finalRecord,
      fenceToken: 5, planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3')
    });
    assert.throws(() => store.commitCutoverAtomic({
      migrationId: 'cutover-3', principal: 'alice',
      commitEvidence: { targetContractId: hash('3'), fencingToken: 5, fenced: true, committedAt: AT },
      decidedAt: AT, finalVerificationId: staleRecord.verificationId,
      fenceToken: 5, planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3')
    }), /CUTOVER_ATTEMPT_MISMATCH/);
    const committed = store.commitCutoverAtomic({
      migrationId: 'cutover-3', principal: 'alice',
      commitEvidence: { targetContractId: hash('3'), fencingToken: 5, fenced: true, committedAt: AT },
      decidedAt: AT, finalVerificationId: finalRecord.verificationId,
      fenceToken: 5, planId: hash('1'), sourceStateId: hash('2'), targetContractId: hash('3')
    });
    assert.equal(committed.status, 'COMMITTED');
    assert.equal(committed.cutoverAttemptId, second.cutoverAttemptId);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
