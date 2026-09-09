import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMigration } from '../src/execution/verify.js';

const a = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const b = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('verification proves row accounting and exact ledger completeness', () => {
  const report = verifyMigration({
    sourceRows: 100,
    writtenRows: 95,
    rejectedRows: 3,
    filteredRows: 2,
    expectedBatchIdentities: [a, b],
    ledgerEntries: [{ batchIdentity: a, rowCount: 50 }, { batchIdentity: b, rowCount: 45 }]
  });
  assert.equal(report.status, 'VERIFIED');
  assert.equal(report.accounting.unexplainedRows, 0);
  assert.equal(report.ledger.complete, true);
});

test('verification fails closed on unexplained rows or missing/conflicting ledger evidence', () => {
  assert.throws(() => verifyMigration({
    sourceRows: 100, writtenRows: 90, rejectedRows: 3, filteredRows: 2,
    expectedBatchIdentities: [a], ledgerEntries: [{ batchIdentity: a, rowCount: 90 }]
  }), /ROW_ACCOUNTING_MISMATCH/);

  assert.throws(() => verifyMigration({
    sourceRows: 10, writtenRows: 10, rejectedRows: 0, filteredRows: 0,
    expectedBatchIdentities: [a, b], ledgerEntries: [{ batchIdentity: a, rowCount: 10 }]
  }), /LEDGER_INCOMPLETE/);

  assert.throws(() => verifyMigration({
    sourceRows: 10, writtenRows: 10, rejectedRows: 0, filteredRows: 0,
    expectedBatchIdentities: [a], ledgerEntries: [{ batchIdentity: a, rowCount: 10 }, { batchIdentity: a, rowCount: 10 }]
  }), /LEDGER_CONFLICT/);
});
