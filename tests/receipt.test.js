import test from 'node:test';
import assert from 'node:assert/strict';
import { createMigrationReceipt, createRepairReceipt } from '../src/execution/receipt.js';

const input = () => ({
  release: { version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
  migrationId: 'mig_receipt_001',
  planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceSnapshotId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  targetIdentity: { connector: 'sqlite', connectionId: 'dst', resource: 'customers', path: '/srv/spool/customers.db', secretRef: { provider: 'env', key: 'DB_PASSWORD' } },
  batchIdentities: ['sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'],
  counts: { sourceRows: 10, writtenRows: 9, rejectedRows: 1, filteredRows: 0 },
  violationsSummary: [{ code: 'INVALID_DATE', count: 1 }],
  verification: { status: 'VERIFIED', accounting: { unexplainedRows: 0 }, ledger: { complete: true } },
  startedAt: '2026-09-09T10:00:00.000Z',
  completedAt: '2026-09-09T10:01:00.000Z'
});

test('receipt hash is deterministic, semantic, and excludes secret references', () => {
  const a = createMigrationReceipt(input());
  const bInput = input();
  bInput.counts = { filteredRows: 0, rejectedRows: 1, writtenRows: 9, sourceRows: 10 };
  const b = createMigrationReceipt(bInput);
  assert.equal(a.receiptId, b.receiptId);
  assert.match(a.receiptId, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(a), /DB_PASSWORD|secretRef/);

  const changed = input();
  changed.counts.writtenRows = 8;
  assert.notEqual(createMigrationReceipt(changed).receiptId, a.receiptId);
});

const repairInput = () => ({
  release: { version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
  migrationId: 'mig_repair_receipt_001',
  repairApprovalId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  repairPlanIds: ['sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  planId: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  sourceSnapshotId: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  targetIdentity: { connector: 'postgres', connectionId: 'dst', resource: 'public.orders' },
  targetContractId: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  opCounts: { insert: 1, update: 2, delete: 0, alreadyApplied: 1 },
  verification: { status: 'VERIFIED', level: 'CONTENT_EXACT', rowCount: 5, rootHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
  startedAt: '2026-09-09T10:00:00.000Z',
  completedAt: '2026-09-09T10:02:00.000Z'
});

test('repair receipt is deterministic and bound to the repair approval, plans and re-verification', () => {
  const a = createRepairReceipt(repairInput());
  const b = createRepairReceipt(repairInput());
  assert.equal(a.receiptId, b.receiptId);
  assert.match(a.receiptId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(a.record.kind, 'repair');

  const changed = repairInput();
  changed.opCounts = { insert: 1, update: 1, delete: 0, alreadyApplied: 2 };
  assert.notEqual(createRepairReceipt(changed).receiptId, a.receiptId);
});

test('repair receipt requires exact re-verification and a bound approval identity', () => {
  const unverified = repairInput();
  unverified.verification = { status: 'DIFF' };
  assert.throws(() => createRepairReceipt(unverified), /REPAIR_RECEIPT_REQUIRES_REVERIFICATION/);

  const unapproved = repairInput();
  delete unapproved.repairApprovalId;
  assert.throws(() => createRepairReceipt(unapproved), /INVALID_RECEIPT_INPUT/);

  const unplanned = repairInput();
  unplanned.repairPlanIds = [];
  assert.throws(() => createRepairReceipt(unplanned), /INVALID_REPAIR_RECEIPT_INPUT/);
});
