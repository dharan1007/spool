import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';

function manifest(sourcePath, targetPath) {
  return {
    migrationId: 'mig_service_001',
    principal: 'operator:alice',
    planInput: {
      planRevision: 1,
      sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'customers.csv', path: sourcePath },
      targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'customers', path: targetPath, table: 'customers' },
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false }
      ],
      mapping: [
        { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
        { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
      ],
      mappingRevision: 1,
      writeStrategy: { mode: 'insert', batchSize: 2 },
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
    }
  };
}

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-service-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'customers.csv');
  const targetPath = join(targetRoot, 'customers.db');
  await writeFile(sourcePath, 'id,name\n1, Ada \n2,Lin\nbad,Rejected\n');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.0.0-test', commitSha: '0123456789abcdef0123456789abcdef01234567' }
  });
  try { await fn({ service, sourcePath, targetPath }); }
  finally { service.close(); await rm(dir, { recursive: true, force: true }); }
}

function targetRows(path) {
  const db = new Database(path);
  try { return db.prepare('SELECT id, name FROM customers ORDER BY id').all().map(row => ({ id: Number(row.id), name: row.name })); }
  finally { db.close(); }
}

test('command service enforces approval and executes verified fenced CSV-to-SQLite migration', async () => {
  await fixture(async ({ service, sourcePath, targetPath }) => {
    const request = manifest(sourcePath, targetPath);
    const inspected = await service.inspect(request);
    assert.equal(inspected.sourceRows, 3);
    assert.match(inspected.sourceSnapshotId, /^sha256:/);
    assert.match(inspected.targetContractId, /^sha256:/);
    assert.equal(inspected.targetPreflight.status, 'READY');

    const plan = await service.plan(request);
    assert.match(plan.planId, /^sha256:/);
    const dry = await service.dryRun(request);
    assert.equal(dry.validRows, 2);
    assert.equal(dry.invalidRows, 1);
    assert.equal(dry.targetContractId, inspected.targetContractId);
    assert.throws(() => service.runSyncGuard(), /ASYNC_COMMAND_ONLY/);
    await assert.rejects(() => service.run(request), /APPROVAL_REQUIRED/);

    const approval = await service.approve(request, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      nonce: 'approval-001'
    });
    assert.equal(approval.record.targetContractId, inspected.targetContractId);
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.verification.status, 'VERIFIED');
    assert.match(result.receipt.receiptId, /^sha256:/);
    assert.equal(result.receipt.record.targetContractId, inspected.targetContractId);
    assert.deepEqual(targetRows(targetPath), [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }]);

    const status = service.status(request.migrationId);
    assert.equal(status.status, 'COMPLETE');
    assert.equal(service.receipt(request.migrationId).receiptId, result.receipt.receiptId);

    const replay = await service.run(request, { approval });
    assert.equal(replay.receipt.receiptId, result.receipt.receiptId);
    assert.equal(targetRows(targetPath).length, 2);
  });
});

test('approval is invalidated if source snapshot changes before execution', async () => {
  await fixture(async ({ service, sourcePath, targetPath }) => {
    const request = manifest(sourcePath, targetPath);
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'approval-002' });
    await writeFile(sourcePath, 'id,name\n1,Ada\n2,Lin\n3,Changed\n');
    await assert.rejects(() => service.run(request, { approval }), /APPROVAL_BINDING_MISMATCH/);
    assert.equal(targetRows(targetPath).length, 0);
  });
});

test('approval is invalidated if the live SQLite target contract changes after approval', async () => {
  await fixture(async ({ service, sourcePath, targetPath }) => {
    const request = manifest(sourcePath, targetPath);
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'approval-003' });
    const db = new Database(targetPath);
    db.exec('CREATE UNIQUE INDEX ux_customers_name ON customers(name);');
    db.close();
    await assert.rejects(() => service.run(request, { approval }), /APPROVAL_BINDING_MISMATCH/);
    assert.equal(targetRows(targetPath).length, 0);
  });
});
