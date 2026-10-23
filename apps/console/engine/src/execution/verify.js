import { fail } from '../core/errors.js';

const HASH = /^sha256:[a-f0-9]{64}$/;

function count(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_VERIFICATION_INPUT', `${name} must be a non-negative safe integer`);
  return value;
}

function batchId(value) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_VERIFICATION_INPUT', 'Batch identities must be canonical sha256 values');
  return value;
}

export function verifyMigration(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_VERIFICATION_INPUT', 'Verification input must be an object');
  const sourceRows = count('sourceRows', input.sourceRows);
  const writtenRows = count('writtenRows', input.writtenRows);
  const rejectedRows = count('rejectedRows', input.rejectedRows);
  const filteredRows = count('filteredRows', input.filteredRows);
  const accountedRows = writtenRows + rejectedRows + filteredRows;
  const unexplainedRows = sourceRows - accountedRows;
  if (unexplainedRows !== 0) {
    fail('ROW_ACCOUNTING_MISMATCH', 'Migration row accounting is not exact', {
      sourceRows, writtenRows, rejectedRows, filteredRows, unexplainedRows
    });
  }

  if (!Array.isArray(input.expectedBatchIdentities)) fail('INVALID_VERIFICATION_INPUT', 'expectedBatchIdentities must be an array');
  if (!Array.isArray(input.ledgerEntries)) fail('INVALID_VERIFICATION_INPUT', 'ledgerEntries must be an array');
  const expected = input.expectedBatchIdentities.map(batchId);
  if (new Set(expected).size !== expected.length) fail('INVALID_VERIFICATION_INPUT', 'Expected batch identities must be unique');

  const ledger = new Map();
  let ledgerRowCount = 0;
  for (const entry of input.ledgerEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('INVALID_VERIFICATION_INPUT', 'Ledger entries must be objects');
    const id = batchId(entry.batchIdentity);
    const rows = count('ledger rowCount', Number(entry.rowCount));
    if (ledger.has(id)) fail('LEDGER_CONFLICT', 'Ledger contains duplicate batch identity evidence', { batchIdentity: id });
    ledger.set(id, rows);
    ledgerRowCount += rows;
  }

  const missing = expected.filter(id => !ledger.has(id));
  const unexpected = [...ledger.keys()].filter(id => !expected.includes(id));
  if (missing.length || unexpected.length) {
    fail('LEDGER_INCOMPLETE', 'Ledger does not exactly match the expected committed batches', { missing, unexpected });
  }
  if (ledgerRowCount !== writtenRows) {
    fail('LEDGER_ROW_COUNT_MISMATCH', 'Ledger committed-row total does not match verified written rows', { ledgerRowCount, writtenRows });
  }

  return Object.freeze({
    status: 'VERIFIED',
    accounting: Object.freeze({ sourceRows, writtenRows, rejectedRows, filteredRows, unexplainedRows: 0 }),
    ledger: Object.freeze({ complete: true, batchCount: expected.length, rowCount: ledgerRowCount })
  });
}
