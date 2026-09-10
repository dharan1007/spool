import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';

function requestFor(sourcePath, targetPath, { migrationId = 'stream_service_001', batchSize = 127 } = {}) {
  return {
    migrationId,
    principal: 'operator:stream-test',
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
      writeStrategy: { mode: 'insert', batchSize },
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
    }
  };
}

async function fixture(rowCount = 1200) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-stream-service-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  const snapshotDir = join(dir, 'snapshots');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'rows.csv');
  const targetPath = join(targetRoot, 'rows.db');
  let csv = 'id,name\n';
  for (let i = 1; i <= rowCount; i += 1) csv += `${i}, User ${i} \n`;
  csv += 'bad,Rejected\n';
  await writeFile(sourcePath, csv, 'utf8');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  const statePath = join(targetRoot, 'spool-state.db');
  const options = {
    sourceRoot, targetRoot, statePath, snapshotDir,
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.0-test', commitSha: '1123456789abcdef0123456789abcdef01234567' }
  };
  const service = await SpoolCommandService.create(options);
  return { dir, sourcePath, targetPath, snapshotDir, options, service };
}

function targetStats(path) {
  const db = new Database(path);
  try {
    return {
      rows: Number(db.prepare('SELECT count(*) AS n FROM rows').get().n),
      ledgers: Number(db.prepare('SELECT count(*) AS n FROM __spool_batch_ledger').get().n)
    };
  } catch {
    return { rows: 0, ledgers: 0 };
  } finally { db.close(); }
}

async function allSnapshotFiles(root) {
  const found = [];
  async function walk(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  }
  await walk(root);
  return found;
}

test('inspect and dry-run use a durable per-migration snapshot with exact streamed row counts', async () => {
  const f = await fixture();
  try {
    const request = requestFor(f.sourcePath, f.targetPath);
    const inspected = await f.service.inspect(request);
    assert.equal(inspected.sourceRows, 1201);
    assert.equal(inspected.sourceSchema.length, 2);
    const snapshots = await allSnapshotFiles(f.snapshotDir);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].includes(':'), false);
    const dry = await f.service.dryRun(request);
    assert.equal(dry.processedRows, 1201);
    assert.equal(dry.validRows, 1200);
    assert.equal(dry.invalidRows, 1);
    assert.equal(JSON.stringify(dry).includes(f.snapshotDir), false);
    assert.equal((await allSnapshotFiles(f.snapshotDir)).length, 1);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('approved execution loads the exact durable snapshot and fails SOURCE_CHANGED before target mutation', async () => {
  const f = await fixture(20);
  try {
    const request = requestFor(f.sourcePath, f.targetPath, { migrationId: 'stream_source_change', batchSize: 5 });
    const approval = await f.service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'stream-source-change' });
    assert.equal((await allSnapshotFiles(f.snapshotDir)).length, 1);
    await appendFile(f.sourcePath, '21,Changed after approval\n', 'utf8');
    await assert.rejects(
      f.service.run(request, { approval }),
      error => error?.code === 'SOURCE_CHANGED'
    );
    assert.deepEqual(targetStats(f.targetPath), { rows: 0, ledgers: 0 });
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('approved snapshot survives service restart and verified completion cleans it without changing receipt semantics', async () => {
  const f = await fixture(25);
  let service = f.service;
  try {
    const request = requestFor(f.sourcePath, f.targetPath, { migrationId: 'stream_restart', batchSize: 7 });
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'stream-restart' });
    const approvedId = approval.record.sourceSnapshotId;
    service.close();
    service = await SpoolCommandService.create(f.options);
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.verification.status, 'VERIFIED');
    assert.equal(result.receipt.record.sourceSnapshotId, approvedId);
    assert.deepEqual(result.receipt.record.counts, { sourceRows: 26, writtenRows: 25, rejectedRows: 1, filteredRows: 0 });
    assert.deepEqual(targetStats(f.targetPath), { rows: 25, ledgers: 4 });
    assert.equal((await allSnapshotFiles(f.snapshotDir)).length, 0);
  } finally {
    service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
