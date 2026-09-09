import test from 'node:test';
import assert from 'node:assert/strict';
import { createMigrationReceipt } from '../src/execution/receipt.js';

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
