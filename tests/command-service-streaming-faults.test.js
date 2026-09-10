import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';

function requestFor(sourcePath, targetPath, migrationId) {
  return {
    migrationId,
    principal: 'operator:stream-faults',
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
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true },
        target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true }
      }
    }
  };
}

async function fixture(sourceBytes, { maxSourceBytes = 2 * 1024 * 1024 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-stream-faults-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'rows.csv');
  const targetPath = join(targetRoot, 'rows.db');
  await writeFile(sourcePath, sourceBytes);
  const db = new Database(targetPath);
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    snapshotDir: join(dir, 'snapshots'),
    maxSourceBytes,
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.0-fault-test', commitSha: '3123456789abcdef0123456789abcdef01234567' }
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

test('streamed Local Runner rejects invalid UTF-8 crossing the default read boundary before mutation', async () => {
  const prefix = Buffer.from('id,name\n1,');
  const filler = Buffer.alloc(64 * 1024 - prefix.length - 1, 0x61);
  const source = Buffer.concat([prefix, filler, Buffer.from([0xc3, 0x28]), Buffer.from('\n')]);
  const f = await fixture(source);
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'stream_invalid_utf8');
    await assert.rejects(() => f.service.inspect(request), error => error?.code === 'INVALID_SOURCE_ENCODING');
    assert.equal(targetIsUntouched(f.targetPath), true);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('streamed Local Runner rejects an unterminated quoted record near EOF before mutation', async () => {
  const f = await fixture('id,name\n1,Ada\n2,"unterminated');
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'stream_unclosed_quote');
    await assert.rejects(() => f.service.inspect(request), error => error?.code === 'UNCLOSED_QUOTE');
    assert.equal(targetIsUntouched(f.targetPath), true);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('durable streamed prepare enforces the configured source ceiling without target mutation', async () => {
  const f = await fixture(`id,name\n1,${'x'.repeat(4096)}\n`, { maxSourceBytes: 1024 });
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'stream_source_ceiling');
    await assert.rejects(() => f.service.inspect(request), error => error?.code === 'SOURCE_TOO_LARGE');
    assert.equal(targetIsUntouched(f.targetPath), true);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('source deletion after approval fails SOURCE_CHANGED before target mutation', async () => {
  const f = await fixture('id,name\n1,Ada\n2,Lin\n');
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'stream_source_deleted');
    const approval = await f.service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'source-deleted' });
    await unlink(f.sourcePath);
    await assert.rejects(() => f.service.run(request, { approval }), error => error?.code === 'SOURCE_CHANGED');
    assert.equal(targetIsUntouched(f.targetPath), true);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('SQLite write lock acquired after streamed approval fails closed with no migrated rows or ledger evidence', { timeout: 15_000 }, async () => {
  const f = await fixture('id,name\n1,Ada\n2,Lin\n3,Grace\n');
  let blocker;
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'stream_target_locked');
    const approval = await f.service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'target-locked' });
    blocker = new Database(f.targetPath);
    blocker.pragma('busy_timeout = 50');
    blocker.exec('BEGIN IMMEDIATE;');
    await assert.rejects(
      () => f.service.run(request, { approval }),
      error => error?.code === 'SQLITE_BUSY' || /busy|locked/i.test(String(error?.message ?? ''))
    );
    blocker.exec('ROLLBACK;');
    blocker.close();
    blocker = null;
    assert.equal(targetIsUntouched(f.targetPath), true);
  } finally {
    if (blocker) {
      try { blocker.exec('ROLLBACK;'); } catch {}
      blocker.close();
    }
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
