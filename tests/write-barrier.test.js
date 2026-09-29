import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITE_BARRIER_KINDS,
  describeBarrierKind,
  barrierIdentity,
  attestOperatorBarrier,
  assertOperatorBarrier,
  acquireDatabaseReadOnlyBarrier
} from '../src/cutover/write-barrier.js';

test('barrier kinds expose only mechanisms that can actually fence writes', () => {
  assert.deepEqual([...WRITE_BARRIER_KINDS], ['POSTGRES_TABLE_SHARE_LOCK', 'EXTERNAL_OPERATOR_BARRIER']);
  assert.equal(describeBarrierKind('POSTGRES_TABLE_SHARE_LOCK'), 'POSTGRES_TABLE_SHARE_LOCK');
  assert.equal(describeBarrierKind('EXTERNAL_OPERATOR_BARRIER'), 'EXTERNAL_OPERATOR_BARRIER');
  assert.throws(
    () => describeBarrierKind('DATABASE_READ_ONLY'),
    error => error?.code === 'WRITE_BARRIER_UNSAFE'
  );
  assert.throws(() => describeBarrierKind('APPLICATION_GATE'), /WRITE_BARRIER_UNSUPPORTED/);
  assert.throws(() => describeBarrierKind('PROXY_ROUTER'), /WRITE_BARRIER_UNSUPPORTED/);
  assert.throws(() => describeBarrierKind('MAGIC'), /WRITE_BARRIER_UNKNOWN/);
});

test('legacy DATABASE_READ_ONLY acquisition is disabled fail-closed', async () => {
  await assert.rejects(
    () => acquireDatabaseReadOnlyBarrier(),
    error => error?.code === 'WRITE_BARRIER_UNSAFE'
  );
});

test('operator attestation is attempt-bound, HMAC-authenticated and never claims zero-downtime', () => {
  const signingKey = '0123456789abcdef0123456789abcdef';
  const cutoverAttemptId = 'sha256:' + 'a'.repeat(64);
  const barrier = attestOperatorBarrier({
    migrationId: 'mig-1',
    cutoverAttemptId,
    principal: 'operator:oncall',
    statement: 'Application writes frozen at deploy freeze-4821; source quiesced.',
    finalLsn: '0/4A1B2C0',
    routingDecision: 'traffic stays on source until cutover commit'
  }, { signingKey });
  assert.equal(barrier.kind, 'EXTERNAL_OPERATOR_BARRIER');
  assert.equal(barrier.zeroDowntime, false);
  assert.match(barrier.barrierId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(barrier.finalLsn, '0/4A1B2C0');
  assert.equal(barrier.attestation.principal, 'operator:oncall');
  assert.equal(barrier.attestation.cutoverAttemptId, cutoverAttemptId);
  assert.match(barrier.signature, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(assertOperatorBarrier(barrier, {
    signingKey, migrationId: 'mig-1', cutoverAttemptId, principal: 'operator:oncall'
  }), true);
  assert.throws(
    () => assertOperatorBarrier(barrier, {
      signingKey: 'fedcba9876543210fedcba9876543210',
      migrationId: 'mig-1',
      cutoverAttemptId,
      principal: 'operator:oncall'
    }),
    error => error?.code === 'CUTOVER_SOURCE_BARRIER_SIGNATURE_INVALID'
  );
  assert.throws(
    () => assertOperatorBarrier({ ...barrier, attestation: { ...barrier.attestation, routingDecision: 'tampered' } }, {
      signingKey, migrationId: 'mig-1', cutoverAttemptId, principal: 'operator:oncall'
    }),
    error => error?.code === 'CUTOVER_SOURCE_BARRIER_INVALID'
  );
  assert.throws(
    () => assertOperatorBarrier(barrier, {
      signingKey, migrationId: 'mig-1', cutoverAttemptId: 'sha256:' + 'b'.repeat(64), principal: 'operator:oncall'
    }),
    error => error?.code === 'CUTOVER_SOURCE_BARRIER_ATTEMPT_MISMATCH'
  );
  assert.throws(() => attestOperatorBarrier({ migrationId: 'm', cutoverAttemptId, principal: '', statement: 'x', finalLsn: '0/1', routingDecision: 'freeze' }, { signingKey }), /INVALID_BARRIER_ATTESTATION/);
  assert.throws(() => attestOperatorBarrier({ migrationId: 'm', cutoverAttemptId, principal: 'p', statement: '   ', finalLsn: '0/1', routingDecision: 'freeze' }, { signingKey }), /INVALID_BARRIER_ATTESTATION/);
  assert.throws(() => attestOperatorBarrier({ migrationId: 'm', cutoverAttemptId, principal: 'p', statement: 'x', finalLsn: 'bogus', routingDecision: 'freeze' }, { signingKey }), /INVALID_BARRIER_ATTESTATION/);
  assert.throws(() => attestOperatorBarrier({ migrationId: 'm', cutoverAttemptId, principal: 'p', statement: 'x', finalLsn: '0/1', routingDecision: '' }, { signingKey }), /INVALID_BARRIER_ATTESTATION/);
  assert.throws(() => attestOperatorBarrier({ migrationId: '', cutoverAttemptId, principal: 'p', statement: 'x', finalLsn: '0/1', routingDecision: 'freeze' }, { signingKey }), /INVALID_BARRIER_REQUEST/);
});

test('barrier identity binds migration, kind, time, LSN and attestation', () => {
  const base = {
    migrationId: 'mig-1',
    kind: 'POSTGRES_TABLE_SHARE_LOCK',
    acquiredAt: '2026-09-21T00:00:00.000Z',
    finalLsn: '0/4A1B2C0',
    attestation: { schema: 'public', table: 'orders', backendPid: 42 }
  };
  const first = barrierIdentity(base);
  assert.equal(first, barrierIdentity(structuredClone(base)));
  assert.notEqual(barrierIdentity({ ...base, finalLsn: '0/4A1B2D0' }), first);
  assert.notEqual(barrierIdentity({ ...base, kind: 'EXTERNAL_OPERATOR_BARRIER' }), first);
  assert.notEqual(barrierIdentity({ ...base, migrationId: 'mig-2' }), first);
  assert.notEqual(barrierIdentity({ ...base, attestation: { ...base.attestation, table: 'customers' } }), first);
  assert.throws(() => barrierIdentity({ ...base, finalLsn: 'nope' }), /INVALID_BARRIER_REQUEST/);
});
