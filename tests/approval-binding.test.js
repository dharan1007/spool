import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundApproval, assertBoundApproval } from '../src/platform/approval.js';

const signingKey = 'local-test-approval-key';
const base = () => ({
  migrationId: 'mig_approval_001',
  planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  planRevision: 3,
  sourceSnapshotId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  targetIdentity: { connector: 'sqlite', connectionId: 'dst', resource: 'customers', path: '/srv/spool/customers.db' },
  effects: ['insert_rows', 'create_ledger'],
  writeStrategy: { mode: 'insert', batchSize: 500 },
  principal: 'operator:alice',
  expiresAt: '2026-09-09T12:00:00.000Z',
  nonce: 'nonce-001'
});

test('bound approval verifies only for the exact approved migration semantics', () => {
  const binding = base();
  const approval = createBoundApproval(binding, { signingKey });
  assert.match(approval.approvalId, /^sha256:[a-f0-9]{64}$/);
  assert.match(approval.signature, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(assertBoundApproval(approval, binding, { signingKey, now: '2026-09-09T11:00:00.000Z' }), true);

  for (const mutate of [
    x => { x.planRevision = 4; },
    x => { x.sourceSnapshotId = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'; },
    x => { x.targetIdentity.resource = 'orders'; },
    x => { x.effects = ['insert_rows', 'drop_table']; },
    x => { x.writeStrategy = { mode: 'replace', batchSize: 500 }; },
    x => { x.principal = 'operator:bob'; }
  ]) {
    const changed = base();
    mutate(changed);
    assert.throws(() => assertBoundApproval(approval, changed, { signingKey, now: '2026-09-09T11:00:00.000Z' }), /APPROVAL_BINDING_MISMATCH/);
  }
});

test('approval expires and tampering with serialized evidence invalidates signature', () => {
  const binding = base();
  const approval = createBoundApproval(binding, { signingKey });
  assert.throws(
    () => assertBoundApproval(approval, binding, { signingKey, now: '2026-09-09T12:00:00.001Z' }),
    /APPROVAL_EXPIRED/
  );
  const tampered = structuredClone(approval);
  tampered.record.writeStrategy.mode = 'replace';
  assert.throws(
    () => assertBoundApproval(tampered, binding, { signingKey, now: '2026-09-09T11:00:00.000Z' }),
    /APPROVAL_SIGNATURE_INVALID/
  );
});
