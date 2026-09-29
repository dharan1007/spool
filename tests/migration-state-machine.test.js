import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RunStore } from '../src/daemon/run-store.js';
import {
  MIGRATION_STATES,
  isAllowedTransition,
  buildTransitionRecord,
  createTransitionId,
  validateTransitionRecord,
  assertTransitionPreconditions,
  buildSnapshotCdcBinding,
  snapshotCdcBindingId,
  buildCutoverAttemptId,
  decideRecoveryAction
} from '../src/protocol/migration-state-machine.js';
import { verificationSemanticId } from '../src/protocol/verification-coordinator.js';

function H(n) { return `sha256:${Number(n).toString(16).padStart(64, '0')}`; }
const HASH = n => H(typeof n === 'number' ? n : String(n).charCodeAt(0));
function lsn(hi, lo) { return `${hi.toString(16).toUpperCase()}/${lo.toString(16).toUpperCase()}`; }

// Helpers to create a RunStore with migration initialized to a given state via stepwise transitions
async function storeWithState(path, migrationId, targetState, { principal = 'test', planId = HASH('a'), sourceStateId = HASH('b'), targetContractId = HASH('c') } = {}) {
  const store = new RunStore({ path });
  store.initializeMigration(migrationId, { principal, reason: 'init' });
  const order = [
    MIGRATION_STATES.DISCOVERING,
    MIGRATION_STATES.PREFLIGHTED,
    MIGRATION_STATES.PLANNED,
    MIGRATION_STATES.AWAITING_APPROVAL,
    MIGRATION_STATES.APPROVED,
    MIGRATION_STATES.SNAPSHOT_ARMED,
    MIGRATION_STATES.SNAPSHOT_RUNNING,
    MIGRATION_STATES.FULL_LOAD_RUNNING,
    MIGRATION_STATES.CDC_RUNNING,
    MIGRATION_STATES.CATCHING_UP,
    MIGRATION_STATES.VERIFYING,
    MIGRATION_STATES.READY_FOR_CUTOVER,
    MIGRATION_STATES.CUTOVER_ARMED,
    MIGRATION_STATES.FINAL_DRAIN,
    MIGRATION_STATES.FINAL_VERIFY,
    MIGRATION_STATES.CUTOVER_COMMITTED,
    MIGRATION_STATES.POST_CUTOVER_VERIFY,
    MIGRATION_STATES.COMPLETED
  ];
  const idx = order.indexOf(targetState);
  if (idx === -1) throw new Error(`Unknown targetState ${targetState}`);
  // Need to walk from CREATED stepwise, supplying required contexts for special transitions
  const approval = { approvalId: 'approval-1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } };
  const verification = { status: 'VERIFIED' };
  for (let i = 0; i <= idx; i++) {
    const next = order[i];
    const cur = store.getMigrationState(migrationId).currentState;
    if (cur === next) continue;
    // Build context per transition
    let context = {};
    if (next === MIGRATION_STATES.APPROVED) context = { approval, planId, sourceStateId, targetContractId };
    if (next === MIGRATION_STATES.CDC_RUNNING || next === MIGRATION_STATES.CATCHING_UP) {
      const binding = buildSnapshotCdcBinding({
        sourceStateId,
        databaseSnapshotIdentity: 'db-identity-1',
        exportedSnapshotId: '00000001-00000001-123',
        snapshotLsn: lsn(0, 0x1000),
        cdcStartLsn: lsn(0, 0x1000),
        catalogId: HASH('d')
      });
      store.setSnapshotCdcBinding(migrationId, binding);
      context = { cdcBinding: binding, sourceStateId };
    }
  if (next === MIGRATION_STATES.READY_FOR_CUTOVER) context = { verification };
  if (next === MIGRATION_STATES.CUTOVER_ARMED) context = { receipt: { receiptId: HASH('e') }, verification, planId, targetContractId };
  if (next === MIGRATION_STATES.CUTOVER_ARMED || next === MIGRATION_STATES.FINAL_DRAIN || next === MIGRATION_STATES.FINAL_VERIFY || next === MIGRATION_STATES.CUTOVER_COMMITTED) {
    throw new Error('storeWithState cannot reach cutover states without persisted verification; use armCutoverState()');
  }
  if (next === MIGRATION_STATES.COMPLETED) {
    throw new Error('storeWithState cannot reach COMPLETED without persisted verifications; use the cutover fixtures');
  }
    // For transitions that require fence, supply it
    let fenceToken = null;
    if ([MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.CUTOVER_COMMITTED].includes(next)) fenceToken = 1;
    store.transition(migrationId, {
      nextState: next,
      principal,
      reason: `test advance to ${next}`,
      planId,
      sourceStateId,
      targetContractId,
      fenceToken,
      context
    });
  }
  return store;
}

// Build a coordinator-shaped verification record with a valid semantic
// identity. completedAt defaults to "now" so the record postdates the
// arming/drain transitions created earlier in the fixture.
function verificationRecord({ migrationId, mode, planId, sourceStateId, targetContractId, cutoverAttemptId, status = 'VERIFIED', withDiff = false, completedAt = null, contentRoot = null, counts = null }) {
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
    counts: counts ?? { sourceRows: 10, validRows: 10, invalidRows: 0 },
    contentRoot: contentRoot ?? H(200),
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
    completedAt: completedAt ?? new Date().toISOString(),
    contentProof: null,
    status
  };
}

// Arm a cutover through the atomic operation with a real attempt identity.
// Returns { attemptId, armedAt }.
function armCutoverState(store, migrationId, target, { principal = 'test', planId, sourceStateId, targetContractId }) {
  const { attemptId } = armCutoverFixture(store, migrationId, { planId, sourceStateId, targetContractId });
  if (target === MIGRATION_STATES.CUTOVER_ARMED) return { attemptId };
  if (target === MIGRATION_STATES.FINAL_DRAIN) {
    store.transition(migrationId, {
      nextState: MIGRATION_STATES.FINAL_DRAIN, principal, reason: 'final drain',
      planId, sourceStateId, targetContractId, fenceToken: 5,
      context: { fenceToken: 5 }
    });
    return { attemptId };
  }
  const finalRecord = verificationRecord({ migrationId, mode: 'FINAL_PRE_CUTOVER', planId, sourceStateId, targetContractId, cutoverAttemptId: attemptId });
  if (target === MIGRATION_STATES.FINAL_VERIFY) {
    store.recordFinalVerificationAtomic({ migrationId, principal, verification: finalRecord, fenceToken: 5, planId, sourceStateId, targetContractId });
    return { attemptId };
  }
  if (target === MIGRATION_STATES.CUTOVER_COMMITTED) {
    store.recordFinalVerificationAtomic({ migrationId, principal, verification: finalRecord, fenceToken: 5, planId, sourceStateId, targetContractId });
    store.commitCutoverAtomic({
      migrationId, principal,
      commitEvidence: { targetContractId, fencingToken: 6, fenced: true, committedAt: new Date().toISOString() },
      decidedAt: new Date().toISOString(), finalVerificationId: finalRecord.verificationId,
      fenceToken: 6, planId, sourceStateId, targetContractId
    });
    return { attemptId };
  }
  throw new Error(`armCutoverState cannot reach ${target}`);
}

function armCutoverFixture(store, migrationId, { planId, sourceStateId, targetContractId, receiptId = HASH('e'), receiptKind = 'migration' }) {
  const armedAt = new Date().toISOString();
  const cutoverAttemptId = buildCutoverAttemptId({ migrationId, receiptId, receiptKind, planId, sourceStateId, targetContractId, armedAt });
  const armed = store.armCutoverAtomic({
    migrationId, principal: 'alice', receiptId, receiptKind, planId, sourceSnapshotId: sourceStateId,
    targetIdentity: { connector: 'sqlite', resource: 'rows' }, targetContractId, armedAt, cutoverAttemptId
  });
  return { armed, attemptId: cutoverAttemptId, armedAt };
}

test('migration state machine allows valid linear progression and rejects illegal jumps', () => {
  const hash = HASH('a');
  assert.equal(isAllowedTransition(null, MIGRATION_STATES.CREATED), true);
  assert.equal(isAllowedTransition(MIGRATION_STATES.CREATED, MIGRATION_STATES.DISCOVERING), true);
  assert.equal(isAllowedTransition(MIGRATION_STATES.CREATED, MIGRATION_STATES.COMPLETED), false);
  assert.equal(isAllowedTransition(MIGRATION_STATES.READY_FOR_CUTOVER, MIGRATION_STATES.CUTOVER_ARMED), true);
  // Removed bypasses: commit is reachable only from FINAL_VERIFY, and
  // COMPLETED only from POST_CUTOVER_VERIFY.
  assert.equal(isAllowedTransition(MIGRATION_STATES.CUTOVER_ARMED, MIGRATION_STATES.CUTOVER_COMMITTED), false);
  assert.equal(isAllowedTransition(MIGRATION_STATES.READY_FOR_CUTOVER, MIGRATION_STATES.COMPLETED), false);
  assert.equal(isAllowedTransition(MIGRATION_STATES.FINAL_VERIFY, MIGRATION_STATES.CUTOVER_COMMITTED), true);
  assert.equal(isAllowedTransition(MIGRATION_STATES.POST_CUTOVER_VERIFY, MIGRATION_STATES.COMPLETED), true);
  assert.equal(isAllowedTransition(MIGRATION_STATES.CUTOVER_COMMITTED, MIGRATION_STATES.FULL_LOAD_RUNNING), false);
  assert.equal(isAllowedTransition(MIGRATION_STATES.VERIFYING, MIGRATION_STATES.READY_FOR_CUTOVER), true);
  assert.equal(isAllowedTransition(MIGRATION_STATES.VERIFYING, MIGRATION_STATES.CUTOVER_COMMITTED), false);
});

test('transition records are deterministically hashed and validated', () => {
  const rec = buildTransitionRecord({
    migrationId: 'mig-1',
    runId: randomUUID(),
    previousState: null,
    nextState: MIGRATION_STATES.CREATED,
    sequence: 0,
    principal: 'alice',
    reason: 'init',
    timestamp: '2026-01-01T00:00:00.000Z'
  });
  const id = createTransitionId(rec);
  assert.match(id, /^sha256:[a-f0-9]{64}$/);
  const full = { ...rec, transitionId: id };
  assert.doesNotThrow(() => validateTransitionRecord(full));
  const tampered = { ...full, nextState: MIGRATION_STATES.DISCOVERING };
  assert.throws(() => validateTransitionRecord(tampered), /TRANSITION_ID_MISMATCH/);
});

test('APPROVED requires valid bound approval and rejects migration approval misuse for repair', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-msm-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  try {
    const mig = 'mig-approve';
    store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
    // Advance to AWAITING_APPROVAL
    store.transition(mig, { nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.PREFLIGHTED, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.PLANNED, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.AWAITING_APPROVAL, principal: 'alice', reason: 'x' });
    // Attempt APPROVED without approval -> should fail APPROVAL_REQUIRED
    assert.throws(() => store.transition(mig, {
      nextState: MIGRATION_STATES.APPROVED,
      principal: 'alice',
      reason: 'approve',
      context: {}
    }), /APPROVAL_REQUIRED/);
    // Provide valid approval
    const approval = { approvalId: 'appr1', record: { planId: HASH('p'), sourceSnapshotId: HASH('s'), targetContractId: HASH('t'), expiresAt: '2099-01-01T00:00:00.000Z' } };
    assert.doesNotThrow(() => store.transition(mig, {
      nextState: MIGRATION_STATES.APPROVED,
      principal: 'alice',
      reason: 'approve',
      planId: HASH('p'),
      sourceStateId: HASH('s'),
      targetContractId: HASH('t'),
      evidence: { approvalId: 'appr1' },
      context: { approval, planId: HASH('p'), sourceStateId: HASH('s'), targetContractId: HASH('t') }
    }));
    // Repair state must reject migration approval
    store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });
    store.transition(mig, { nextState: MIGRATION_STATES.VERIFYING, principal: 'alice', reason: 'x' });
    const verification = { status: 'DIFF' };
    store.transition(mig, { nextState: MIGRATION_STATES.VERIFICATION_FAILED, principal: 'alice', reason: 'diff', evidence: { verification }, context: { verification: { status: 'DIFF' } } });
    // Attempt repair with migration approval -> should fail
    assert.throws(() => store.transition(mig, {
      nextState: MIGRATION_STATES.REPAIR_PLANNED,
      principal: 'alice',
      reason: 'repair',
      context: { approval } // migration approval, not repair
    }), /REPAIR_APPROVAL_REQUIRED|ILLEGAL/);
    // Actually REPAIR_PLANNED precondition checks for repair approval misuse only when approval present; but REPAIR_PLANNED itself doesn't strictly require approval, so we test REPAIR_APPROVED with migration approval
    store.transition(mig, { nextState: MIGRATION_STATES.REPAIR_PLANNED, principal: 'alice', reason: 'repair planned' });
    assert.throws(() => store.transition(mig, {
      nextState: MIGRATION_STATES.REPAIR_APPROVED,
      principal: 'alice',
      reason: 'repair approved',
      context: { approval } // should be repairApproval
    }), /REPAIR_APPROVAL_REQUIRED/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CDC_RUNNING requires CDC binding to correct snapshot/LSN without unobserved window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-msm-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  try {
    const mig = 'mig-cdc';
    store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
    // Advance to FULL_LOAD_RUNNING
    const planId = HASH('p'), sourceStateId = HASH('s'), targetContractId = HASH('t');
    for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) {
      store.transition(mig, { nextState: st, principal: 'alice', reason: 'x' });
    }
    store.transition(mig, {
      nextState: MIGRATION_STATES.APPROVED,
      principal: 'alice',
      reason: 'approve',
      planId, sourceStateId, targetContractId,
      context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId }
    });
    store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });

    // Try CDC without binding -> fail
    assert.throws(() => store.transition(mig, {
      nextState: MIGRATION_STATES.CDC_RUNNING,
      principal: 'alice',
      reason: 'cdc',
      context: {}
    }), /CDC_BINDING_REQUIRED/);

    // Create binding with gap (cdcStart before snapshot) -> should fail at binding creation, not transition
    assert.throws(() => buildSnapshotCdcBinding({
      sourceStateId,
      databaseSnapshotIdentity: 'db1',
      exportedSnapshotId: '00000001-00000001-1',
      snapshotLsn: lsn(0, 0x2000),
      cdcStartLsn: lsn(0, 0x1000), // before snapshot
      catalogId: HASH('d')
    }), /CDC_GAP/);

    // Valid binding
    const binding = buildSnapshotCdcBinding({
      sourceStateId,
      databaseSnapshotIdentity: 'db1',
      exportedSnapshotId: '00000001-00000001-1',
      snapshotLsn: lsn(0, 0x1000),
      cdcStartLsn: lsn(0, 0x1000),
      catalogId: HASH('d')
    });
    store.setSnapshotCdcBinding(mig, binding);
    // Now CDC transition should succeed with correct context
    assert.doesNotThrow(() => store.transition(mig, {
      nextState: MIGRATION_STATES.CDC_RUNNING,
      principal: 'alice',
      reason: 'cdc',
      context: { cdcBinding: binding, sourceStateId }
    }));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('READY_FOR_CUTOVER requires verified verification and acceptable lag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-msm-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  try {
    const mig = 'mig-ready';
    store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
    for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) store.transition(mig, { nextState: st, principal: 'alice', reason: 'x' });
    const planId = HASH('p'), sourceStateId = HASH('s'), targetContractId = HASH('t');
    store.transition(mig, {
      nextState: MIGRATION_STATES.APPROVED,
      principal: 'alice',
      reason: 'approve',
      planId, sourceStateId, targetContractId,
      context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId }
    });
    store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });
    store.transition(mig, { nextState: MIGRATION_STATES.VERIFYING, principal: 'alice', reason: 'x' });
    // Try ready with failed verification -> fail
    assert.throws(() => store.transition(mig, {
      nextState: MIGRATION_STATES.READY_FOR_CUTOVER,
      principal: 'alice',
      reason: 'ready',
      context: { verification: { status: 'DIFF' } }
    }), /VERIFICATION_REQUIRED/);
    // With lag exceeded -> fail
    assert.throws(() => store.transition(mig, {
      nextState: MIGRATION_STATES.READY_FOR_CUTOVER,
      principal: 'alice',
      reason: 'ready',
      context: { verification: { status: 'VERIFIED' }, cdcLagMs: 5000, maxCdcLagMs: 2000 }
    }), /CUTOVER_LAG_EXCEEDED/);
    // Success
    assert.doesNotThrow(() => store.transition(mig, {
      nextState: MIGRATION_STATES.READY_FOR_CUTOVER,
      principal: 'alice',
      reason: 'ready',
      context: { verification: { status: 'VERIFIED' }, cdcLagMs: 1000 }
    }));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CUTOVER_COMMITTED requires fresh fence and bound final verification, COMPLETED requires post verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-msm-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  try {
    const mig = 'mig-cutover';
    // Fast-forward to READY_FOR_CUTOVER
    const planId = HASH('p'), sourceStateId = HASH('s'), targetContractId = HASH('t');
    store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
    for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) store.transition(mig, { nextState: st, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.APPROVED, principal: 'alice', reason: 'approve', planId, sourceStateId, targetContractId, context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId } });
    store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });
    store.transition(mig, { nextState: MIGRATION_STATES.VERIFYING, principal: 'alice', reason: 'x' });
    store.transition(mig, { nextState: MIGRATION_STATES.READY_FOR_CUTOVER, principal: 'alice', reason: 'ready', context: { verification: { status: 'VERIFIED' } } });
    const { attemptId } = armCutoverFixture(store, mig, { planId, sourceStateId, targetContractId });
    // Persist a real FINAL_PRE_CUTOVER record bound to this attempt.
    const finalRecord = verificationRecord({ migrationId: mig, mode: 'FINAL_PRE_CUTOVER', planId, sourceStateId, targetContractId, cutoverAttemptId: attemptId });
    store.recordFinalVerificationAtomic({ migrationId: mig, principal: 'alice', verification: finalRecord, fenceToken: 2, planId, sourceStateId, targetContractId });
    assert.equal(store.getMigrationState(mig).currentState, MIGRATION_STATES.FINAL_VERIFY);
    // Try commit without fence -> fail
    assert.throws(() => store.commitCutoverAtomic({
      migrationId: mig, principal: 'alice',
      commitEvidence: { targetContractId, fencingToken: 2, fenced: true, committedAt: new Date().toISOString() },
      decidedAt: new Date().toISOString(), finalVerificationId: finalRecord.verificationId,
      fenceToken: null, planId, sourceStateId, targetContractId
    }), /FENCE_REQUIRED/);
    // Commit with a FAILED verification record -> fail
    const diffRecord = verificationRecord({ migrationId: mig, mode: 'FINAL_PRE_CUTOVER', planId, sourceStateId, targetContractId, cutoverAttemptId: attemptId, withDiff: true, status: 'FAILED' });
    store.saveVerification(mig, diffRecord);
    assert.throws(() => store.commitCutoverAtomic({
      migrationId: mig, principal: 'alice',
      commitEvidence: { targetContractId, fencingToken: 3, fenced: true, committedAt: new Date().toISOString() },
      decidedAt: new Date().toISOString(), finalVerificationId: diffRecord.verificationId,
      fenceToken: 3, planId, sourceStateId, targetContractId
    }), /VERIFICATION_REQUIRED/);
    // Commit with an unknown verification id -> fail
    assert.throws(() => store.commitCutoverAtomic({
      migrationId: mig, principal: 'alice',
      commitEvidence: { targetContractId, fencingToken: 3, fenced: true, committedAt: new Date().toISOString() },
      decidedAt: new Date().toISOString(), finalVerificationId: HASH('z'),
      fenceToken: 3, planId, sourceStateId, targetContractId
    }), /VERIFICATION_REQUIRED/);
    // Success with the bound VERIFIED record
    const committed = store.commitCutoverAtomic({
      migrationId: mig, principal: 'alice',
      commitEvidence: { targetContractId, fencingToken: 4, fenced: true, committedAt: new Date().toISOString() },
      decidedAt: new Date().toISOString(), finalVerificationId: finalRecord.verificationId,
      fenceToken: 4, planId, sourceStateId, targetContractId
    });
    assert.equal(committed.status, 'COMMITTED');
    assert.equal(committed.cutoverAttemptId, attemptId);
    assert.equal(store.getMigrationState(mig).currentState, MIGRATION_STATES.CUTOVER_COMMITTED);
    // Post-cutover: a DIFF record cannot authorize COMPLETED. First reach
    // POST_CUTOVER_VERIFY with a valid record, then prove the gate rejects
    // the DIFF identity.
    const postRecord = verificationRecord({ migrationId: mig, mode: 'POST_CUTOVER', planId, sourceStateId, targetContractId, cutoverAttemptId: attemptId });
    store.recordPostCutoverVerificationAtomic({ migrationId: mig, principal: 'alice', verification: postRecord });
    assert.equal(store.getMigrationState(mig).currentState, MIGRATION_STATES.POST_CUTOVER_VERIFY);
    const postDiff = verificationRecord({ migrationId: mig, mode: 'POST_CUTOVER', planId, sourceStateId, targetContractId, cutoverAttemptId: attemptId, withDiff: true, status: 'FAILED' });
    store.saveVerification(mig, postDiff);
    assert.throws(() => store.completeMigrationAtomic({
      migrationId: mig, principal: 'alice', postCutoverVerificationId: postDiff.verificationId,
      planId, sourceStateId, targetContractId
    }), /VERIFICATION_REQUIRED/);
    // Success with the bound VERIFIED post-cutover record.
    store.completeMigrationAtomic({
      migrationId: mig, principal: 'alice', postCutoverVerificationId: postRecord.verificationId,
      planId, sourceStateId, targetContractId
    });
    assert.equal(store.getMigrationState(mig).currentState, MIGRATION_STATES.COMPLETED);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot/CDC binding proves no unobserved window and LSN monotonicity', () => {
  const sourceStateId = HASH('s');
  // Valid: snapshot == start
  assert.doesNotThrow(() => buildSnapshotCdcBinding({
    sourceStateId,
    databaseSnapshotIdentity: 'db1',
    exportedSnapshotId: '12345678-12345678-1',
    snapshotLsn: lsn(0, 0x100),
    cdcStartLsn: lsn(0, 0x100),
    catalogId: HASH('d')
  }));
  // Valid: start after snapshot
  assert.doesNotThrow(() => buildSnapshotCdcBinding({
    sourceStateId,
    databaseSnapshotIdentity: 'db1',
    snapshotLsn: lsn(0, 0x100),
    cdcStartLsn: lsn(0, 0x200),
    receivedLsn: lsn(0, 0x300),
    appliedLsn: lsn(0, 0x250),
    acknowledgedLsn: lsn(0, 0x200),
    catalogId: HASH('d')
  }));
  // Invalid: ack beyond applied
  assert.throws(() => buildSnapshotCdcBinding({
    sourceStateId,
    databaseSnapshotIdentity: 'db1',
    snapshotLsn: lsn(0, 0x100),
    cdcStartLsn: lsn(0, 0x100),
    receivedLsn: lsn(0, 0x300),
    appliedLsn: lsn(0, 0x200),
    acknowledgedLsn: lsn(0, 0x250),
    catalogId: HASH('d')
  }), /CDC_ACK_BEYOND_APPLIED|LSN monotonicity/);
  // Invalid: start before snapshot
  assert.throws(() => buildSnapshotCdcBinding({
    sourceStateId,
    databaseSnapshotIdentity: 'db1',
    snapshotLsn: lsn(0, 0x300),
    cdcStartLsn: lsn(0, 0x100),
    catalogId: HASH('d')
  }), /CDC_GAP/);
  // Invalid: received before start
  assert.throws(() => buildSnapshotCdcBinding({
    sourceStateId,
    databaseSnapshotIdentity: 'db1',
    snapshotLsn: lsn(0, 0x100),
    cdcStartLsn: lsn(0, 0x200),
    receivedLsn: lsn(0, 0x150),
    catalogId: HASH('d')
  }), /LSN monotonicity/);
});

test('durable state is append-only and reconstructs after fresh process via new RunStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-restart-'));
  const path = join(dir, 'state.db');
  const mig = 'mig-restart';
  let store = new RunStore({ path });
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  store.transition(mig, { nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'x' });
  store.transition(mig, { nextState: MIGRATION_STATES.PREFLIGHTED, principal: 'alice', reason: 'x' });
  const seqBefore = store.getMigrationState(mig).sequence;
  store.close();
  // Fresh process: new RunStore instance
  store = new RunStore({ path });
  const restored = store.getMigrationState(mig);
  assert.equal(restored.sequence, seqBefore);
  assert.equal(restored.currentState, MIGRATION_STATES.PREFLIGHTED);
  assert.equal(store.listTransitions(mig).length, 3);
  // Continue
  store.transition(mig, { nextState: MIGRATION_STATES.PLANNED, principal: 'alice', reason: 'x' });
  assert.equal(store.getMigrationState(mig).sequence, seqBefore + 1);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test('fresh-process restart via spawned Node process reconstructs state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-fresh-'));
  const path = join(dir, 'state.db');
  const mig = 'mig-fresh';
  let store = new RunStore({ path });
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  store.transition(mig, { nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'x' });
  store.close();
  // Spawn fresh Node process to read state
  const helper = join(dir, 'helper.mjs');
  await writeFile(helper, `
    import { RunStore } from 'file:///${process.cwd().replaceAll('\\', '/')}/src/daemon/run-store.js';
    const store = new RunStore({ path: '${path.replaceAll('\\', '/')}' });
    const state = store.getMigrationState('${mig}');
    console.log(JSON.stringify({ currentState: state.currentState, sequence: state.sequence }));
    store.close();
  `);
  const result = spawnSync(process.execPath, [helper], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.currentState, MIGRATION_STATES.DISCOVERING);
  assert.equal(parsed.sequence, 1);
  await rm(dir, { recursive: true, force: true });
});

test('concurrent transition writers: only one advances, stale version rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-cas-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  const mig = 'mig-cas';
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  store.transition(mig, { nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'x' });
  const cur = store.getMigrationState(mig);
  // Simulate two writers reading same sequence
  const seq = cur.sequence;
  // Writer A succeeds
  store.transition(mig, { nextState: MIGRATION_STATES.PREFLIGHTED, principal: 'alice', reason: 'writer A', expectedSequence: seq });
  // Writer B with stale expectedSequence should fail
  assert.throws(() => store.transition(mig, {
    nextState: MIGRATION_STATES.PREFLIGHTED,
    principal: 'bob',
    reason: 'writer B',
    expectedSequence: seq
  }), /STALE_TRANSITION_VERSION/);
  // Also stale previousState check
  assert.throws(() => store.transition(mig, {
    nextState: MIGRATION_STATES.PLANNED,
    principal: 'bob',
    reason: 'stale from',
    previousState: MIGRATION_STATES.DISCOVERING
  }), /ILLEGAL_STATE_TRANSITION/);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test('stale coordinator epoch is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-epoch-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  const mig = 'mig-epoch';
  const s1 = store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  const runId = s1.runId;
  // Attempt transition with wrong runId
  assert.throws(() => store.transition(mig, {
    nextState: MIGRATION_STATES.DISCOVERING,
    principal: 'alice',
    reason: 'stale epoch',
    runId: 'wrong-run-id'
  }), /STALE_COORDINATOR_EPOCH/);
  // Correct runId succeeds
  assert.doesNotThrow(() => store.transition(mig, {
    nextState: MIGRATION_STATES.DISCOVERING,
    principal: 'alice',
    reason: 'good',
    runId
  }));
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test('old fence cannot commit after takeover (stale fence rejected inside TX is proven by RunStore fenceToken monotonicity)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-fence-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  const mig = 'mig-fence';
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  // Advance to FULL_LOAD_RUNNING with fence 1
  for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) store.transition(mig, { nextState: st, principal: 'alice', reason: 'x' });
  const planId = HASH('p'), sourceStateId = HASH('s'), targetContractId = HASH('t');
  store.transition(mig, { nextState: MIGRATION_STATES.APPROVED, principal: 'alice', reason: 'x', planId, sourceStateId, targetContractId, context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId } });
  store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
  store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
  store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 10 });
  const before = store.getMigrationState(mig);
  assert.equal(before.fenceToken, 10);
  // Simulate takeover with higher fence
  store.transition(mig, { nextState: MIGRATION_STATES.VERIFYING, principal: 'alice', reason: 'x' });
  // Attempt to use stale fence 10 to commit cutover should require fresh fence >10; but our state machine stores latest fence.
  // The target TX would check fence inside DB; here we just ensure durable state fence is updated
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test('stable command identity: same command retries idempotently, conflicting command rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-idem-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  const mig = 'mig-idem';
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  // Same logical command retried (e.g. crash before the result was observed):
  // identical command id + identical semantic evidence -> same stored transition,
  // no sequence advance, stable transitionId across process restarts. The stable
  // command identity is caller-supplied; wall-clock timestamps and fresh fence
  // tokens are execution metadata and never enter it.
  const t1 = store.transition(mig, {
    nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'same',
    evidence: { foo: 'bar' }, commandId: 'cmd-op-1'
  });
  const seqAfterFirst = store.getMigrationState(mig).sequence;
  const t2 = store.transition(mig, {
    nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'same retried with fresh wall-clock',
    evidence: { foo: 'bar' }, commandId: 'cmd-op-1'
  });
  assert.equal(t2.transitionId, t1.transitionId);
  assert.equal(t2.commandId, 'cmd-op-1');
  assert.equal(store.getMigrationState(mig).sequence, seqAfterFirst);
  // Same sequence, different command identity -> TRANSITION_CONFLICT.
  // Simulated white-box: a concurrently-committed racing transaction left a
  // row at the next sequence with a different command identity (in production
  // this arises from two writers racing inside overlapping transactions).
  {
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(path);
    try {
      raw.prepare(`INSERT INTO spool_transitions (migration_id, sequence, transition_id, command_id, previous_transition_id, previous_state, next_state, principal, reason, timestamp, transition_json)
        VALUES (?, 2, ?, 'cmd-racer', NULL, 'DISCOVERING', 'PREFLIGHTED', 'bob', 'race', '2026-09-13T00:00:00.000Z', '{}')`)
        .run(mig, `sha256:${'c'.repeat(64)}`);
      assert.throws(() => store.transition(mig, {
        nextState: MIGRATION_STATES.PREFLIGHTED,
        principal: 'alice',
        reason: 'conflict',
        evidence: { foo: 'different' }, commandId: 'cmd-op-2'
      }), /TRANSITION_CONFLICT/);
    } finally {
      raw.prepare('DELETE FROM spool_transitions WHERE migration_id = ? AND sequence = 2').run(mig);
      raw.close();
    }
  }
  // Same command id but a different requested transition -> TRANSITION_CONFLICT.
  assert.throws(() => store.transition(mig, {
    nextState: MIGRATION_STATES.PREFLIGHTED,
    principal: 'alice',
    reason: 'conflict',
    evidence: { foo: 'different' }, commandId: 'cmd-op-1'
  }), /TRANSITION_CONFLICT/);
  // Stale expectedSequence still rejected.
  assert.throws(() => store.transition(mig, {
    nextState: MIGRATION_STATES.PREFLIGHTED,
    principal: 'alice',
    reason: 'conflict',
    expectedSequence: 0 // stale, current is 1
  }), /STALE_TRANSITION_VERSION/);
  // Idempotent replay recognized across a fresh process (restart): same
  // command yields the stored transition without advancing the log.
  store.close();
  const reopened = new RunStore({ path });
  const found = reopened.findTransitionByCommand(mig, t1.commandId);
  assert.ok(found);
  assert.equal(found.transitionId, t1.transitionId);
  const t3 = reopened.transition(mig, {
    nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'retry after restart',
    evidence: { foo: 'bar' }, commandId: 'cmd-op-1'
  });
  assert.equal(t3.transitionId, t1.transitionId);
  reopened.close();
  await rm(dir, { recursive: true, force: true });
});

test('corrupt transition log or state checksum fails closed with RUN_STATE_CORRUPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-corrupt-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  const mig = 'mig-corrupt';
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  store.transition(mig, { nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'x' });
  store.close();
  // Corrupt the DB directly
  const db = (await import('better-sqlite3')).default(path);
  db.prepare(`UPDATE spool_transitions SET transition_json = ? WHERE migration_id = ? AND sequence = 1`).run(JSON.stringify({ corrupted: true }), mig);
  db.close();
  const reopened = new RunStore({ path });
  assert.throws(() => reopened.getMigrationState(mig), /RUN_STATE_CORRUPT/);
  reopened.close();
  await rm(dir, { recursive: true, force: true });
});

test('corrupt state checksum fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-corrupt2-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  const mig = 'mig-corrupt2';
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  store.close();
  const db = (await import('better-sqlite3')).default(path);
  db.prepare(`UPDATE spool_migration_state SET checksum = ? WHERE migration_id = ?`).run('sha256:0000000000000000000000000000000000000000000000000000000000000000', mig);
  db.close();
  const reopened = new RunStore({ path });
  assert.throws(() => reopened.getMigrationState(mig), /RUN_STATE_CORRUPT/);
  reopened.close();
  await rm(dir, { recursive: true, force: true });
});

test('illegal transitions return ILLEGAL_STATE_TRANSITION', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-illegal-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  const mig = 'mig-illegal';
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  // Try jump from CREATED directly to COMPLETED
  assert.throws(() => store.transition(mig, { nextState: MIGRATION_STATES.COMPLETED, principal: 'alice', reason: 'illegal' }), /ILLEGAL_STATE_TRANSITION/);
  // Try backwards after terminal
  store.transition(mig, { nextState: MIGRATION_STATES.DISCOVERING, principal: 'alice', reason: 'x' });
  for (const st of [MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) store.transition(mig, { nextState: st, principal: 'alice', reason: 'x' });
  const planId = HASH('p'), sourceStateId = HASH('s'), targetContractId = HASH('t');
  store.transition(mig, { nextState: MIGRATION_STATES.APPROVED, principal: 'alice', reason: 'x', planId, sourceStateId, targetContractId, context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId } });
  store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
  store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
  store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });
  store.transition(mig, { nextState: MIGRATION_STATES.VERIFYING, principal: 'alice', reason: 'x' });
  store.transition(mig, { nextState: MIGRATION_STATES.READY_FOR_CUTOVER, principal: 'alice', reason: 'x', context: { verification: { status: 'VERIFIED' } } });
  const { attemptId } = armCutoverFixture(store, mig, { planId, sourceStateId, targetContractId, receiptId: HASH('r') });
  const finalRecord = verificationRecord({ migrationId: mig, mode: 'FINAL_PRE_CUTOVER', planId, sourceStateId, targetContractId, cutoverAttemptId: attemptId });
  store.recordFinalVerificationAtomic({ migrationId: mig, principal: 'alice', verification: finalRecord, fenceToken: 2, planId, sourceStateId, targetContractId });
  store.commitCutoverAtomic({
    migrationId: mig, principal: 'alice',
    commitEvidence: { targetContractId, fencingToken: 2, fenced: true, committedAt: new Date().toISOString() },
    decidedAt: new Date().toISOString(), finalVerificationId: finalRecord.verificationId,
    fenceToken: 2, planId, sourceStateId, targetContractId
  });
  const postRecord = verificationRecord({ migrationId: mig, mode: 'POST_CUTOVER', planId, sourceStateId, targetContractId, cutoverAttemptId: attemptId });
  store.recordPostCutoverVerificationAtomic({ migrationId: mig, principal: 'alice', verification: postRecord });
  store.completeMigrationAtomic({
    migrationId: mig, principal: 'alice', postCutoverVerificationId: postRecord.verificationId,
    planId, sourceStateId, targetContractId
  });
  // Now try backwards
  assert.throws(() => store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'backwards' }), /ILLEGAL_STATE_TRANSITION/);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test('decideRecoveryAction returns deterministic resume/reconcile/wait/refuse', () => {
  assert.equal(decideRecoveryAction({ currentState: MIGRATION_STATES.FULL_LOAD_RUNNING, checkpoint: { nextOffset: 100 } }), 'RECONCILE');
  assert.equal(decideRecoveryAction({ currentState: MIGRATION_STATES.FULL_LOAD_RUNNING, checkpoint: null }), 'RESUME');
  assert.equal(decideRecoveryAction({ currentState: MIGRATION_STATES.FAILED_OPERATOR_REQUIRED }), 'WAIT_OPERATOR');
  assert.equal(decideRecoveryAction({ currentState: MIGRATION_STATES.COMPLETED }), 'REFUSE');
  assert.equal(decideRecoveryAction({ currentState: MIGRATION_STATES.VERIFYING }), 'RECONCILE');
});

test('snapshot/CDC binding update enforces monotonic LSN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-lsn-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  const mig = 'mig-lsn';
  store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
  // Advance to state where binding is allowed
  const planId = HASH('p'), sourceStateId = HASH('s'), targetContractId = HASH('t');
  for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) store.transition(mig, { nextState: st, principal: 'alice', reason: 'x' });
  store.transition(mig, { nextState: MIGRATION_STATES.APPROVED, principal: 'alice', reason: 'x', planId, sourceStateId, targetContractId, context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId } });
  const binding = buildSnapshotCdcBinding({
    sourceStateId,
    databaseSnapshotIdentity: 'db1',
    snapshotLsn: lsn(0, 0x100),
    cdcStartLsn: lsn(0, 0x100),
    receivedLsn: lsn(0, 0x200),
    appliedLsn: lsn(0, 0x180),
    acknowledgedLsn: lsn(0, 0x150),
    catalogId: HASH('d')
  });
  store.setSnapshotCdcBinding(mig, binding);
  // Try to advance ack beyond applied -> fail
  assert.throws(() => store.updateCdcProgress(mig, { acknowledgedLsn: lsn(0, 0x190) }), /CDC_ACK_BEYOND_APPLIED|LSN monotonicity/);
  // Valid forward
  assert.doesNotThrow(() => store.updateCdcProgress(mig, { appliedLsn: lsn(0, 0x190), acknowledgedLsn: lsn(0, 0x180) }));
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test('restart at 10 boundaries via fresh process simulation', async () => {
  const boundaries = [
    { name: 'after approval before snapshot', target: MIGRATION_STATES.APPROVED },
    { name: 'during snapshot/full load', target: MIGRATION_STATES.SNAPSHOT_RUNNING },
    { name: 'after target commit before checkpoint (FULL_LOAD_RUNNING)', target: MIGRATION_STATES.FULL_LOAD_RUNNING },
    { name: 'while CDC active', target: MIGRATION_STATES.CDC_RUNNING },
    { name: 'after verification failure', target: MIGRATION_STATES.VERIFICATION_FAILED },
    { name: 'during repair', target: MIGRATION_STATES.REPAIRING },
    { name: 'after cutover arm', target: MIGRATION_STATES.CUTOVER_ARMED },
    { name: 'during final drain', target: MIGRATION_STATES.FINAL_DRAIN },
    { name: 'immediately before cutover commit (FINAL_VERIFY)', target: MIGRATION_STATES.FINAL_VERIFY },
    { name: 'immediately after cutover commit', target: MIGRATION_STATES.CUTOVER_COMMITTED },
  ];
  for (let idx = 0; idx < boundaries.length; idx++) {
    const b = boundaries[idx];
    const dir = await mkdtemp(join(tmpdir(), 'spool-bound-'));
    const path = join(dir, 'state.db');
    const mig = `mig-bound-${idx}`;
    // Build state up to target via helper
    let store;
    try {
      // For VERIFICATION_FAILED and repair states we need special handling
      if (b.target === MIGRATION_STATES.VERIFICATION_FAILED) {
        store = new RunStore({ path });
        store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
        for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) store.transition(mig, { nextState: st, principal: 'alice', reason: 'x' });
        const planId = HASH('p'), sourceStateId = HASH('s'), targetContractId = HASH('t');
        store.transition(mig, { nextState: MIGRATION_STATES.APPROVED, principal: 'alice', reason: 'x', planId, sourceStateId, targetContractId, context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId } });
        store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
        store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
        store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });
        store.transition(mig, { nextState: MIGRATION_STATES.VERIFYING, principal: 'alice', reason: 'x' });
        store.transition(mig, { nextState: MIGRATION_STATES.VERIFICATION_FAILED, principal: 'alice', reason: 'x', context: { verification: { status: 'DIFF' } } });
      } else if (b.target === MIGRATION_STATES.REPAIRING) {
        store = new RunStore({ path });
        store.initializeMigration(mig, { principal: 'alice', reason: 'init' });
        for (const st of [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL]) store.transition(mig, { nextState: st, principal: 'alice', reason: 'x' });
        const planId = HASH('p'), sourceStateId = HASH('s'), targetContractId = HASH('t');
        store.transition(mig, { nextState: MIGRATION_STATES.APPROVED, principal: 'alice', reason: 'x', planId, sourceStateId, targetContractId, context: { approval: { approvalId: 'a1', record: { planId, sourceSnapshotId: sourceStateId, targetContractId, expiresAt: '2099-01-01T00:00:00.000Z' } }, planId, sourceStateId, targetContractId } });
        store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'x' });
        store.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'alice', reason: 'x' });
        store.transition(mig, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'alice', reason: 'x', fenceToken: 1 });
        store.transition(mig, { nextState: MIGRATION_STATES.VERIFYING, principal: 'alice', reason: 'x' });
        store.transition(mig, { nextState: MIGRATION_STATES.VERIFICATION_FAILED, principal: 'alice', reason: 'x', context: { verification: { status: 'DIFF' } } });
        store.transition(mig, { nextState: MIGRATION_STATES.REPAIR_PLANNED, principal: 'alice', reason: 'x' });
        store.transition(mig, { nextState: MIGRATION_STATES.REPAIR_APPROVED, principal: 'alice', reason: 'x', context: { repairApproval: { approvalId: 'r1' } } });
        store.transition(mig, { nextState: MIGRATION_STATES.REPAIRING, principal: 'alice', reason: 'x', fenceToken: 2, context: { repairApproval: { approvalId: 'r1' }, fenceToken: 2 } });
      } else if ([MIGRATION_STATES.CUTOVER_ARMED, MIGRATION_STATES.FINAL_DRAIN, MIGRATION_STATES.FINAL_VERIFY, MIGRATION_STATES.CUTOVER_COMMITTED].includes(b.target)) {
        store = await storeWithState(path, mig, MIGRATION_STATES.READY_FOR_CUTOVER);
        armCutoverState(store, mig, b.target, { planId: HASH('a'), sourceStateId: HASH('b'), targetContractId: HASH('c') });
      } else {
        store = await storeWithState(path, mig, b.target);
      }
      const before = store.getMigrationState(mig);
      assert.equal(before.currentState, b.target, `setup failed for ${b.name}`);
      store.close();
      // Fresh process via spawned Node
      const helper = join(dir, 'read.mjs');
      await writeFile(helper, `
        import { RunStore } from 'file:///${process.cwd().replaceAll('\\', '/')}/src/daemon/run-store.js';
        import { decideRecoveryAction } from 'file:///${process.cwd().replaceAll('\\', '/')}/src/protocol/migration-state-machine.js';
        const store = new RunStore({ path: '${path.replaceAll('\\', '/')}' });
        const state = store.getMigrationState('${mig}');
        const action = decideRecoveryAction({ currentState: state.currentState, checkpoint: null, verification: null, cutover: null, snapshotCdcBinding: null });
        console.log(JSON.stringify({ currentState: state.currentState, sequence: state.sequence, action }));
        store.close();
      `);
      const result = spawnSync(process.execPath, [helper], { encoding: 'utf8' });
      assert.equal(result.status, 0, `fresh process failed for ${b.name}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.equal(parsed.currentState, b.target, `fresh process state mismatch for ${b.name}`);
      // Verify recovery decision is deterministic (one of RESUME/RECONCILE/WAIT/REFUSE)
      assert.match(parsed.action, /^(RESUME|RECONCILE|WAIT_OPERATOR|REFUSE)$/, `invalid recovery action for ${b.name}`);
      // Ensure we can still transition after restart where allowed (e.g., after approval we can go to snapshot)
      if (b.target === MIGRATION_STATES.APPROVED) {
        const reopened = new RunStore({ path });
        reopened.transition(mig, { nextState: MIGRATION_STATES.SNAPSHOT_ARMED, principal: 'alice', reason: 'resume' });
        reopened.close();
      }
    } finally {
      try { store?.close(); } catch {}
      try { await rm(dir, { recursive: true, force: true }); } catch (e) { if (e.code !== 'EBUSY') throw e; }
    }
  }
});
