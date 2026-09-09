import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';

test('canonical CRM export runs through the production CSV-to-SQLite path with deterministic evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-crm-example-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'source.csv');
  const targetPath = join(targetRoot, 'target.db');
  await writeFile(sourcePath, await readFile('examples/crm-export/source.csv'));
  const targetSql = await readFile('examples/crm-export/target.sql', 'utf8');
  const targetDb = new Database(targetPath);
  targetDb.exec(targetSql);
  targetDb.close();
  const request = JSON.parse(await readFile('examples/crm-export/request.json', 'utf8'));
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: 'crm-example-test', commitSha: '0123456789abcdef0123456789abcdef01234567' }
  });
  try {
    const inspection = await service.inspect(request);
    assert.equal(inspection.sourceRows, 5);
    assert.equal(inspection.targetPreflight.status, 'READY');
    const dry = await service.dryRun(request);
    assert.deepEqual({ valid: dry.validRows, invalid: dry.invalidRows }, { valid: 3, invalid: 2 });
    const codes = new Set(dry.violations.map(item => item.code));
    assert.ok(codes.has('AMBIGUOUS_DATE_FORMAT'));
    assert.ok(codes.has('INVALID_NUMBER'));

    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'crm-example' });
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.verification.status, 'VERIFIED');
    assert.deepEqual(result.receipt.record.counts, { sourceRows: 5, writtenRows: 3, rejectedRows: 2, filteredRows: 0 });
    assert.equal(result.receipt.record.targetContractId, inspection.targetContractId);

    const db = new Database(targetPath, { readonly: true });
    const rows = db.prepare('SELECT customer_id, full_name, monthly_fee, joined_on, is_active FROM customers ORDER BY customer_id').all()
      .map(row => ({ ...row, customer_id: Number(row.customer_id), monthly_fee: Number(row.monthly_fee), is_active: Number(row.is_active) }));
    const ledgerCount = Number(db.prepare('SELECT COUNT(*) AS count FROM __spool_batch_ledger WHERE migration_id=?').get(request.migrationId).count);
    db.close();
    assert.deepEqual(rows, [
      { customer_id: 1001, full_name: 'Ada Lovelace', monthly_fee: 1299, joined_on: '2026-01-02', is_active: 1 },
      { customer_id: 1002, full_name: 'Lin Chen', monthly_fee: 1299, joined_on: '2026-04-03', is_active: 0 },
      { customer_id: 1004, full_name: 'Noor Khan', monthly_fee: 99, joined_on: '2026-02-28', is_active: 1 }
    ]);
    assert.equal(ledgerCount, 3);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
