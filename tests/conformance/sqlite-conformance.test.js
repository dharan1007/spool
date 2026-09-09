import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../../src/daemon/command-service.js';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-conformance-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'customers.csv');
  const targetPath = join(targetRoot, 'customers.db');
  await writeFile(sourcePath, 'id,name,joined_at\n1,Ada,2026-01-02\n2,Lin,2026-01-03\nbad,Rejected,2026-01-04\n3,Grace,2026-01-05\n');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, joined_at TEXT);');
  db.close();
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.0.0-conformance', commitSha: '0123456789abcdef0123456789abcdef01234567' }
  });
  try { await fn({ service, sourcePath, targetPath }); }
  finally { service.close(); await rm(dir, { recursive: true, force: true }); }
}

function request(sourcePath, targetPath) {
  return {
    migrationId: 'mig_conformance_001',
    principal: 'conformance:runner',
    planInput: {
      planRevision: 1,
      sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'customers.csv', path: sourcePath },
      targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'customers', path: targetPath, table: 'customers' },
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false },
        { name: 'joined_at', type: 'date', nullable: true }
      ],
      mapping: [
        { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
        { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } },
        { target: 'joined_at', expr: { op: 'cast_date', value: { op: 'field', name: 'joined_at' } } }
      ],
      mappingRevision: 1,
      writeStrategy: { mode: 'insert', batchSize: 2 },
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, idempotentReplay: true, fencing: true } }
    }
  };
}

test('Gate B conformance: real filesystem CSV to SQLite is approved, fenced, verified, receipted and idempotent', async () => {
  await fixture(async ({ service, sourcePath, targetPath }) => {
    const migration = request(sourcePath, targetPath);
    const inspection = await service.inspect(migration);
    assert.equal(inspection.targetPreflight.status, 'READY');
    assert.match(inspection.targetContractId, /^sha256:/);
    const dry = await service.dryRun(migration);
    assert.deepEqual({ processed: dry.processedRows, valid: dry.validRows, invalid: dry.invalidRows }, { processed: 4, valid: 3, invalid: 1 });
    const approval = await service.approve(migration, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'conformance-approval' });
    const result = await service.run(migration, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.verification.status, 'VERIFIED');
    assert.equal(result.receipt.record.targetContractId, inspection.targetContractId);
    assert.deepEqual(result.receipt.record.counts, { sourceRows: 4, writtenRows: 3, rejectedRows: 1, filteredRows: 0 });

    const db = new Database(targetPath, { readonly: true });
    const rows = db.prepare('SELECT id, name, joined_at FROM customers ORDER BY id').all().map(row => ({ ...row, id: Number(row.id) }));
    const ledger = db.prepare('SELECT batch_identity, row_count FROM __spool_batch_ledger WHERE migration_id=? ORDER BY rowid').all(migration.migrationId);
    db.close();
    assert.deepEqual(rows, [
      { id: 1, name: 'Ada', joined_at: '2026-01-02' },
      { id: 2, name: 'Lin', joined_at: '2026-01-03' },
      { id: 3, name: 'Grace', joined_at: '2026-01-05' }
    ]);
    assert.equal(ledger.length, 2);
    assert.equal(ledger.reduce((sum, row) => sum + Number(row.row_count), 0), 3);

    const replay = await service.run(migration, { approval });
    assert.equal(replay.replay, true);
    assert.equal(replay.receipt.receiptId, result.receipt.receiptId);
    const verifyDb = new Database(targetPath, { readonly: true });
    assert.equal(Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM customers').get().count), 3);
    assert.equal(Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM __spool_batch_ledger WHERE migration_id=?').get(migration.migrationId).count), 2);
    verifyDb.close();
  });
});
