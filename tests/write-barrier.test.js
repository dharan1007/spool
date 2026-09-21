import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITE_BARRIER_KINDS,
  describeBarrierKind,
  barrierIdentity,
  attestOperatorBarrier
} from '../src/cutover/write-barrier.js';

test('barrier kinds are explicit: unimplemented routers fail, never stub', () => {
  assert.deepEqual([...WRITE_BARRIER_KINDS], ['DATABASE_READ_ONLY', 'EXTERNAL_OPERATOR_BARRIER']);
  assert.equal(describeBarrierKind('DATABASE_READ_ONLY'), 'DATABASE_READ_ONLY');
  assert.equal(describeBarrierKind('EXTERNAL_OPERATOR_BARRIER'), 'EXTERNAL_OPERATOR_BARRIER');
  assert.throws(() => describeBarrierKind('APPLICATION_GATE'), /WRITE_BARRIER_UNSUPPORTED/);
  assert.throws(() => describeBarrierKind('PROXY_ROUTER'), /WRITE_BARRIER_UNSUPPORTED/);
  assert.throws(() => describeBarrierKind('MAGIC'), /WRITE_BARRIER_UNKNOWN/);
});

test('operator attestation requires every field and never claims zero-downtime', () => {
  const barrier = attestOperatorBarrier({
    migrationId: 'mig-1',
    principal: 'operator:oncall',
    statement: 'Application writes frozen at deploy freeze-4821; source quiesced.',
    finalLsn: '0/4A1B2C0',
    routingDecision: 'traffic stays on source until cutover commit'
  });
  assert.equal(barrier.kind, 'EXTERNAL_OPERATOR_BARRIER');
  assert.equal(barrier.zeroDowntime, false);
  assert.match(barrier.barrierId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(barrier.finalLsn, '0/4A1B2C0');
  assert.equal(barrier.attestation.principal, 'operator:oncall');
  assert.throws(() => attestOperatorBarrier({ migrationId: 'm', principal: '', statement: 'x', finalLsn: '0/1' }), /INVALID_BARRIER_ATTESTATION/);
  assert.throws(() => attestOperatorBarrier({ migrationId: 'm', principal: 'p', statement: '   ', finalLsn: '0/1' }), /INVALID_BARRIER_ATTESTATION/);
  assert.throws(() => attestOperatorBarrier({ migrationId: 'm', principal: 'p', statement: 'x', finalLsn: 'bogus' }), /INVALID_BARRIER_ATTESTATION/);
  assert.throws(() => attestOperatorBarrier({ migrationId: '', principal: 'p', statement: 'x', finalLsn: '0/1' }), /INVALID_BARRIER_REQUEST/);
});

test('barrier identity binds migration, kind, time, LSN and attestation', () => {
  const base = { migrationId: 'mig-1', kind: 'EXTERNAL_OPERATOR_BARRIER', acquiredAt: '2026-09-21T00:00:00.000Z', finalLsn: '0/4A1B2C0', attestation: { a: 1 } };
  const first = barrierIdentity(base);
  assert.equal(first, barrierIdentity(structuredClone(base)));
  assert.notEqual(barrierIdentity({ ...base, finalLsn: '0/4A1B2D0' }), first);
  assert.notEqual(barrierIdentity({ ...base, kind: 'DATABASE_READ_ONLY' }), first);
  assert.notEqual(barrierIdentity({ ...base, migrationId: 'mig-2' }), first);
  assert.throws(() => barrierIdentity({ ...base, finalLsn: 'nope' }), /INVALID_BARRIER_REQUEST/);
});
