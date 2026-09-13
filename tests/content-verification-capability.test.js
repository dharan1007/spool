import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';

function requestFor(sourcePath, targetPath, migrationId, { declaredCapability = false } = {}) {
  return {
    migrationId,
    principal: 'operator:content-capability',
    planInput: {
      planRevision: 1,
      sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'rows.csv', path: sourcePath },
      targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'rows', path: targetPath, table: 'rows' },
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
      verification: { checks: ['row_accounting', 'ledger_complete', 'content_exact'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true },
        target: {
          transactions: true,
          atomicBatchLedger: true,
          reconcileAfterCrash: true,
          fencing: true,
          readAfterWriteVerification: declaredCapability
        }
      }
    }
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-content-capability-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'rows.csv');
  const targetPath = join(targetRoot, 'rows.db');
  await writeFile(sourcePath, 'id,name\n1,Ada\n2,Lin\n');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    snapshotDir: join(dir, 'snapshots'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.0-capability-test', commitSha: '4123456789abcdef0123456789abcdef01234567' }
  });
  return { dir, sourcePath, targetPath, service };
}

function targetIsUntouched(path) {
  const db = new Database(path, { readonly: true });
  try {
    const rows = Number(db.prepare('SELECT COUNT(*) AS n FROM rows').get().n);
    let ledgers = 0;
    try { ledgers = Number(db.prepare('SELECT COUNT(*) AS n FROM __spool_batch_ledger').get().n); }
    catch { ledgers = 0; }
    return rows === 0 && ledgers === 0;
  } finally { db.close(); }
}

test('content_exact is rejected before any target mutation when the plan does not declare read-after-write capability', async () => {
  const f = await fixture();
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'capability_undeclared');
    await assert.rejects(() => f.service.inspect(request), error => error?.code === 'CONTENT_VERIFICATION_CAPABILITY_UNDECLARED');
    assert.equal(targetIsUntouched(f.targetPath), true);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('content_exact is rejected before any target mutation when the target connector cannot verify read-after-write content', async () => {
  const f = await fixture();
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'capability_required', { declaredCapability: true });
    await assert.rejects(() => f.service.inspect(request), error => error?.code === 'CONTENT_VERIFICATION_CAPABILITY_REQUIRED');
    assert.equal(targetIsUntouched(f.targetPath), true);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});