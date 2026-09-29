import test from 'node:test';
import assert from 'node:assert/strict';

const hash = digit => `sha256:${digit.repeat(64)}`;

async function loadProtocol() {
  return import('../src/protocol/svmp.js');
}

test('SVMP exposes the canonical success path and explicit exceptional states', async () => {
  const { SVMP_STATES, SVMP_SUCCESS_PATH, SVMP_EXCEPTION_STATES } = await loadProtocol();
  assert.deepEqual(SVMP_SUCCESS_PATH, [
    SVMP_STATES.DISCOVERED,
    SVMP_STATES.SNAPSHOTTED,
    SVMP_STATES.PLANNED,
    SVMP_STATES.VALIDATED,
    SVMP_STATES.AUTHORIZED,
    SVMP_STATES.EXECUTING,
    SVMP_STATES.RECONCILING,
    SVMP_STATES.VERIFYING,
    SVMP_STATES.VERIFIED,
    SVMP_STATES.CUTOVER_ARMED,
    SVMP_STATES.FINAL_DRAIN,
    SVMP_STATES.FINAL_VERIFY,
    SVMP_STATES.CUTOVER_COMMITTED
  ]);
  assert.deepEqual([...SVMP_EXCEPTION_STATES].sort(), [
    'AUTHORITY_EXPIRED', 'COMMIT_UNKNOWN', 'COMPENSATION_REQUIRED', 'LEASE_LOST',
    'RECONCILIATION_CONFLICT', 'SOURCE_DRIFT', 'TARGET_DRIFT', 'VERIFICATION_FAILED'
  ]);
});

test('SVMP rejects phase skipping and allows only declared recovery transitions', async () => {
  const { SVMP_STATES, assertSvmpTransition } = await loadProtocol();
  for (let index = 0; index < 8; index += 1) {
    assert.equal(assertSvmpTransition(SVMP_STATES[Object.keys(SVMP_STATES)[index]], SVMP_STATES[Object.keys(SVMP_STATES)[index + 1]]), true);
  }
  assert.throws(() => assertSvmpTransition('DISCOVERED', 'AUTHORIZED'), error => error?.code === 'SVMP_INVALID_TRANSITION');
  assert.throws(() => assertSvmpTransition('VERIFIED', 'EXECUTING'), error => error?.code === 'SVMP_INVALID_TRANSITION');
  assert.equal(assertSvmpTransition('COMMIT_UNKNOWN', 'RECONCILING'), true);
  assert.equal(assertSvmpTransition('VERIFICATION_FAILED', 'COMPENSATION_REQUIRED'), true);
  assert.throws(() => assertSvmpTransition('LEASE_LOST', 'EXECUTING'), error => error?.code === 'SVMP_INVALID_TRANSITION');
});

test('SVMP cutover arms only from verified evidence and commits, aborts or re-arms explicitly', async () => {
  const { SVMP_STATES, assertSvmpTransition, listSvmpTransitions } = await loadProtocol();
  assert.equal(assertSvmpTransition('VERIFIED', 'CUTOVER_ARMED'), true);
  // No direct CUTOVER_ARMED -> CUTOVER_COMMITTED bypass: commit requires FINAL_VERIFY.
  assert.throws(() => assertSvmpTransition('CUTOVER_ARMED', 'CUTOVER_COMMITTED'), error => error?.code === 'SVMP_INVALID_TRANSITION');
  assert.equal(assertSvmpTransition('CUTOVER_ARMED', 'FINAL_DRAIN'), true);
  assert.equal(assertSvmpTransition('CUTOVER_ARMED', 'FINAL_VERIFY'), true);
  assert.equal(assertSvmpTransition('FINAL_DRAIN', 'FINAL_VERIFY'), true);
  assert.equal(assertSvmpTransition('FINAL_VERIFY', 'CUTOVER_COMMITTED'), true);
  assert.equal(assertSvmpTransition('CUTOVER_ARMED', 'CUTOVER_ABORTED'), true);
  assert.equal(assertSvmpTransition('FINAL_VERIFY', 'CUTOVER_ABORTED'), true);
  assert.equal(assertSvmpTransition('CUTOVER_ARMED', 'TARGET_DRIFT'), true);
  assert.equal(assertSvmpTransition('CUTOVER_ABORTED', 'CUTOVER_ARMED'), true);
  assert.deepEqual(listSvmpTransitions('CUTOVER_COMMITTED'), []);
  assert.deepEqual(listSvmpTransitions('CUTOVER_ABORTED'), ['CUTOVER_ARMED']);
  assert.throws(() => assertSvmpTransition('VERIFYING', 'CUTOVER_ARMED'), error => error?.code === 'SVMP_INVALID_TRANSITION');
  assert.throws(() => assertSvmpTransition('VERIFICATION_FAILED', 'CUTOVER_ARMED'), error => error?.code === 'SVMP_INVALID_TRANSITION');
  assert.throws(() => assertSvmpTransition('CUTOVER_COMMITTED', 'CUTOVER_ARMED'), error => error?.code === 'SVMP_INVALID_TRANSITION');
  assert.throws(() => assertSvmpTransition('CUTOVER_ARMED', 'VERIFIED'), error => error?.code === 'SVMP_INVALID_TRANSITION');
  assert.equal(SVMP_STATES.CUTOVER_ARMED, 'CUTOVER_ARMED');
});

test('SVMP mutation identity set binds all eight correctness identities deterministically', async () => {
  const { createSvmpIdentitySet } = await loadProtocol();
  const first = createSvmpIdentitySet({
    sourceStateId: hash('1'), planId: hash('2'), targetStateId: hash('3'), authorityId: hash('4'),
    executionId: hash('5'), evidenceId: hash('6'), verificationId: hash('7'), receiptId: hash('8')
  });
  const second = createSvmpIdentitySet({
    receiptId: hash('8'), verificationId: hash('7'), evidenceId: hash('6'), executionId: hash('5'),
    authorityId: hash('4'), targetStateId: hash('3'), planId: hash('2'), sourceStateId: hash('1')
  });
  assert.equal(first.identitySetId, second.identitySetId);
  assert.deepEqual(first, second);
  assert.match(first.identitySetId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.identities), true);
});

test('SVMP mutation identity set rejects missing, malformed, or secret-shaped identity material', async () => {
  const { createSvmpIdentitySet } = await loadProtocol();
  const valid = {
    sourceStateId: hash('1'), planId: hash('2'), targetStateId: hash('3'), authorityId: hash('4'),
    executionId: hash('5'), evidenceId: hash('6'), verificationId: hash('7'), receiptId: hash('8')
  };
  assert.throws(() => createSvmpIdentitySet({ ...valid, authorityId: undefined }), error => error?.code === 'SVMP_INVALID_IDENTITY');
  assert.throws(() => createSvmpIdentitySet({ ...valid, targetStateId: 'postgres://user:secret@example/db' }), error => error?.code === 'SVMP_INVALID_IDENTITY');
  assert.throws(() => createSvmpIdentitySet({ ...valid, extra: hash('9') }), error => error?.code === 'SVMP_UNKNOWN_IDENTITY_FIELD');
});

test('SVMP normative terms are versioned and machine-readable', async () => {
  const { SVMP_PROTOCOL, SVMP_SEMANTICS } = await loadProtocol();
  assert.equal(SVMP_PROTOCOL.name, 'SPOOL Verified Mutation Protocol');
  assert.equal(SVMP_PROTOCOL.shortName, 'SVMP');
  assert.equal(SVMP_PROTOCOL.version, 1);
  for (const term of ['authorized', 'committed', 'idempotent', 'reconciled', 'verified']) {
    assert.equal(typeof SVMP_SEMANTICS[term], 'string');
    assert.ok(SVMP_SEMANTICS[term].length > 40, `${term} semantic definition is too weak`);
  }
});
