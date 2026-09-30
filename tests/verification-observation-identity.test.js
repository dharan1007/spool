import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verificationSemanticId,
  assertVerificationIdentity,
  VERIFICATION_MODE
} from '../src/protocol/verification-coordinator.js';

function base(overrides = {}) {
  return {
    schemaVersion: 1,
    migrationId: 'obs-test',
    mode: VERIFICATION_MODE.FINAL_PRE_CUTOVER,
    planId: 'sha256:' + '1'.repeat(64),
    mappingRevision: 1,
    sourceStateId: 'sha256:' + '2'.repeat(64),
    targetContractId: 'sha256:' + '3'.repeat(64),
    cutoverAttemptId: 'sha256:' + '4'.repeat(64),
    sourceBoundary: { snapshotId: 'sha256:' + '2'.repeat(64) },
    targetBoundary: { contractId: 'sha256:' + '3'.repeat(64) },
    cdc: null,
    counts: { sourceRows: 2, validRows: 2, invalidRows: 0 },
    contentRoot: 'sha256:' + '5'.repeat(64),
    levels: { required: ['ROW_COUNT'], completed: ['ROW_COUNT'] },
    invariants: null,
    release: { version: 'test', commitSha: 'a'.repeat(40) },
    ...overrides
  };
}

test('historical schema-v1 verification identity remains deterministic without observationId', () => {
  const first = base();
  const second = structuredClone(first);
  assert.equal(verificationSemanticId(first), verificationSemanticId(second));
});

test('schema-v2 cutover observation identity makes equally successful reruns distinct', () => {
  const first = base({
    schemaVersion: 2,
    observationId: 'sha256:' + '6'.repeat(64)
  });
  const second = base({
    schemaVersion: 2,
    observationId: 'sha256:' + '7'.repeat(64)
  });
  assert.notEqual(verificationSemanticId(first), verificationSemanticId(second));
});

test('schema-v2 persisted cutover proof binds observationId against tampering', () => {
  const semantic = base({
    schemaVersion: 2,
    observationId: 'sha256:' + '8'.repeat(64)
  });
  const record = {
    ...semantic,
    verificationId: verificationSemanticId(semantic),
    fenceToken: 11,
    startedAt: '2026-09-22T00:00:00.000Z',
    completedAt: '2026-09-22T00:00:01.000Z',
    contentProof: null,
    status: 'VERIFIED'
  };
  assert.equal(assertVerificationIdentity(record), record.verificationId);
  assert.throws(
    () => assertVerificationIdentity({ ...record, observationId: 'sha256:' + '9'.repeat(64) }),
    /VERIFICATION_ID_MISMATCH/
  );
  assert.throws(
    () => assertVerificationIdentity({ ...record, observationId: 'not-a-hash' }),
    /VERIFICATION_ID_MISMATCH/
  );
});
