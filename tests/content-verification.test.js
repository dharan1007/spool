import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyContentProjection } from '../src/execution/content-verification.js';
import { createRepairPlan } from '../src/execution/repair-plan.js';

const PLAN_ID = `sha256:${'1'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'2'.repeat(64)}`;
const TARGET_CONTRACT_ID = `sha256:${'3'.repeat(64)}`;
const targetIdentity = Object.freeze({ connector: 'postgres', resource: 'public.orders' });

const expected = Object.freeze([
  Object.freeze({ tenant_id: 1, id: 10, name: 'alpha', amount: 12.5 }),
  Object.freeze({ tenant_id: 1, id: 11, name: 'beta', amount: 20 }),
  Object.freeze({ tenant_id: 2, id: 10, name: 'gamma', amount: 30 })
]);

const config = Object.freeze({
  primaryKey: ['tenant_id', 'id'],
  columns: ['tenant_id', 'id', 'name', 'amount']
});

test('content verification is deterministic and independent of row order', () => {
  const first = verifyContentProjection({ expectedRows: expected, actualRows: [...expected].reverse(), ...config });
  const second = verifyContentProjection({ expectedRows: [...expected].reverse(), actualRows: expected, ...config });
  assert.equal(first.status, 'VERIFIED');
  assert.equal(second.status, 'VERIFIED');
  assert.equal(first.verificationId, second.verificationId);
  assert.equal(first.expected.rootHash, second.expected.rootHash);
  assert.equal(first.actual.rootHash, second.actual.rootHash);
  assert.equal(first.diff.total, 0);
});

test('content verification classifies missing, mismatch and unexpected rows exactly', () => {
  const actual = [
    { tenant_id: 1, id: 10, name: 'alpha', amount: 12.5 },
    { tenant_id: 1, id: 11, name: 'changed', amount: 20 },
    { tenant_id: 9, id: 99, name: 'extra', amount: 1 }
  ];
  const result = verifyContentProjection({ expectedRows: expected, actualRows: actual, ...config });
  assert.equal(result.status, 'DIFF');
  assert.deepEqual(result.diff.counts, { missing: 1, mismatch: 1, unexpected: 1 });
  assert.equal(result.diff.total, 3);
  assert.deepEqual(result.diff.entries.map(entry => entry.kind), ['MISMATCH', 'MISSING', 'UNEXPECTED']);
  assert.equal(result.diff.entries[0].key.tenant_id, 1);
  assert.equal(result.diff.entries[0].key.id, 11);
  assert.equal(result.diff.entries[0].expectedRow.name, 'beta');
  assert.equal(result.diff.entries[0].actualRow.name, 'changed');
});

test('content verification compares only declared projection columns', () => {
  const actual = expected.map(row => ({ ...row, server_default: 'ignored' }));
  const result = verifyContentProjection({ expectedRows: expected, actualRows: actual, ...config });
  assert.equal(result.status, 'VERIFIED');
});

test('content verification rejects duplicate primary keys on either side', () => {
  assert.throws(
    () => verifyContentProjection({ expectedRows: [...expected, { ...expected[0] }], actualRows: expected, ...config }),
    error => error?.code === 'DUPLICATE_EXPECTED_PRIMARY_KEY'
  );
  assert.throws(
    () => verifyContentProjection({ expectedRows: expected, actualRows: [...expected, { ...expected[0] }], ...config }),
    error => error?.code === 'DUPLICATE_ACTUAL_PRIMARY_KEY'
  );
});

test('repair plan is deterministic and binds every operation to verification evidence', () => {
  const actual = [
    { tenant_id: 1, id: 10, name: 'alpha', amount: 12.5 },
    { tenant_id: 1, id: 11, name: 'changed', amount: 20 },
    { tenant_id: 9, id: 99, name: 'extra', amount: 1 }
  ];
  const verification = verifyContentProjection({ expectedRows: expected, actualRows: actual, ...config });
  const input = {
    migrationId: 'migration-1',
    planId: PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    targetIdentity,
    targetContractId: TARGET_CONTRACT_ID,
    verification
  };
  const first = createRepairPlan(input);
  const second = createRepairPlan(input);
  assert.equal(first.repairPlanId, second.repairPlanId);
  assert.equal(first.verificationId, verification.verificationId);
  assert.deepEqual(first.operations.map(operation => operation.effect), ['UPDATE', 'INSERT', 'DELETE']);
  assert.equal(first.operations[0].precondition.actualRowHash, verification.diff.entries[0].actualRowHash);
  assert.equal(first.operations[1].precondition.absent, true);
  assert.equal(first.operations[2].precondition.actualRowHash, verification.diff.entries[2].actualRowHash);
});

test('verified content cannot produce a repair plan', () => {
  const verification = verifyContentProjection({ expectedRows: expected, actualRows: expected, ...config });
  assert.throws(
    () => createRepairPlan({ migrationId: 'migration-1', planId: PLAN_ID, sourceSnapshotId: SNAPSHOT_ID, targetIdentity, targetContractId: TARGET_CONTRACT_ID, verification }),
    error => error?.code === 'REPAIR_NOT_REQUIRED'
  );
});
