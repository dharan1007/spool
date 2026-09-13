import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundApproval } from '../src/platform/approval.js';
import { createRepairApproval, assertRepairApproval } from '../src/platform/repair-approval.js';

const signingKey = 'local-test-repair-approval-key';
const PLAN_ID = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SNAPSHOT_ID = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REPAIR_PLAN_A = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const REPAIR_PLAN_B = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

const base = () => ({
  migrationId: 'mig_repair_001',
  repairPlanIds: [REPAIR_PLAN_A, REPAIR_PLAN_B],
  planId: PLAN_ID,
  sourceSnapshotId: SNAPSHOT_ID,
  targetIdentity: { connector: 'postgres', connectionId: 'dst', resource: 'public.orders' },
  targetContractId: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  effects: ['postgres:apply_repair', 'postgres:read_after_write_verify'],
  principal: 'operator:repairs',
  expiresAt: '2026-09-09T12:00:00.000Z',
  nonce: 'repair-nonce-001'
});

test('repair approval verifies only for the exact approved repair semantics', () => {
  const binding = base();
  const approval = createRepairApproval(binding, { signingKey });
  assert.equal(approval.kind, 'repair');
  assert.match(approval.approvalId, /^sha256:[a-f0-9]{64}$/);
  assert.match(approval.signature, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.deepEqual(approval.record.repairPlanIds, [REPAIR_PLAN_A, REPAIR_PLAN_B].sort());
  assert.equal(assertRepairApproval(approval, binding, { signingKey, now: '2026-09-09T11:00:00.000Z' }), true);

  for (const mutate of [
    x => { x.repairPlanIds = [REPAIR_PLAN_A]; },
    x => { x.migrationId = 'mig_repair_002'; },
    x => { x.sourceSnapshotId = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; },
    x => { x.targetContractId = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; },
    x => { x.effects = ['postgres:apply_repair']; },
    x => { x.principal = 'operator:intruder'; }
  ]) {
    const changed = base();
    mutate(changed);
    assert.throws(() => assertRepairApproval(approval, changed, { signingKey, now: '2026-09-09T11:00:00.000Z' }), /REPAIR_APPROVAL_BINDING_MISMATCH/);
  }
});

test('repair approval expires and tampering with serialized evidence invalidates signature', () => {
  const binding = base();
  const approval = createRepairApproval(binding, { signingKey });
  assert.throws(
    () => assertRepairApproval(approval, binding, { signingKey, now: '2026-09-09T12:00:00.001Z' }),
    /REPAIR_APPROVAL_EXPIRED/
  );
  const tampered = structuredClone(approval);
  tampered.record.repairPlanIds = [REPAIR_PLAN_A];
  assert.throws(
    () => assertRepairApproval(tampered, binding, { signingKey, now: '2026-09-09T11:00:00.000Z' }),
    /REPAIR_APPROVAL_SIGNATURE_INVALID/
  );
  assert.throws(
    () => assertRepairApproval(approval, binding, { signingKey: 'wrong-signing-key-0000000000000000', now: '2026-09-09T11:00:00.000Z' }),
    /REPAIR_APPROVAL_SIGNATURE_INVALID/
  );
});

test('a migration approval can never authorize repair execution', () => {
  const migrationApproval = createBoundApproval({
    migrationId: 'mig_repair_001',
    planId: PLAN_ID,
    planRevision: 1,
    sourceSnapshotId: SNAPSHOT_ID,
    targetIdentity: { connector: 'postgres', connectionId: 'dst', resource: 'public.orders' },
    effects: ['postgres:apply_repair', 'postgres:read_after_write_verify'],
    writeStrategy: { mode: 'insert', batchSize: 2 },
    principal: 'operator:repairs',
    expiresAt: '2026-09-09T12:00:00.000Z',
    nonce: 'repair-nonce-001'
  }, { signingKey });
  assert.throws(
    () => assertRepairApproval(migrationApproval, base(), { signingKey, now: '2026-09-09T11:00:00.000Z' }),
    /INVALID_REPAIR_APPROVAL/
  );
});

test('repair approval binding rejects empty, duplicate and malformed repair plan identities', () => {
  for (const repairPlanIds of [[], [REPAIR_PLAN_A, REPAIR_PLAN_A], ['not-a-hash'], 'sha256:abc']) {
    assert.throws(
      () => createRepairApproval({ ...base(), repairPlanIds }, { signingKey }),
      /INVALID_REPAIR_APPROVAL_BINDING/
    );
  }
});
