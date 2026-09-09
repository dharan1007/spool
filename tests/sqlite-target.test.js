import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTarget } from '../src/connectors/sqlite/target.js';

const IDS = {
  batchIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  migrationId: 'mig_001',
  planId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  sourceSnapshotId: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  mappingRevision: 1
};

async function withDatabase(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-sqlite-'));
  const path = join(dir, 'target.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function countRows(path) {
  const db = new DatabaseSync(path);
  try {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM customers').get().count);
  } finally {
    db.close();
  }
}

test('SQLite commits target rows and reconciliation ledger atomically', async () => {
  await withDatabase(async path => {
    const target = new SqliteTarget({ path, table: 'customers' });
    const result = target.commitBatch({ ...IDS, rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }] });
    assert.equal(result.status, 'COMMITTED_EXACT');
    assert.equal(result.rowCount, 2);
    assert.equal(countRows(path), 2);

    const reconciliation = target.reconcileTargetCommit({
      ...IDS,
      rowCount: result.rowCount,
      payloadHash: result.payloadHash
    });
    assert.equal(reconciliation.status, 'COMMITTED_EXACT');
    target.close();
  });
});

test('failed target writes roll back both migrated rows and ledger evidence', async () => {
  await withDatabase(async path => {
    const target = new SqliteTarget({ path, table: 'customers' });
    assert.throws(() => target.commitBatch({ ...IDS, rows: [{ id: 1, name: 'Ada' }, { id: 1, name: 'Duplicate' }] }));
    assert.equal(countRows(path), 0);
    assert.equal(target.reconcileTargetCommit({ ...IDS, rowCount: 2, payloadHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' }).status, 'NOT_COMMITTED');
    target.close();
  });
});

test('exact batch replay is idempotent and does not duplicate rows', async () => {
  await withDatabase(async path => {
    const target = new SqliteTarget({ path, table: 'customers' });
    const input = { ...IDS, rows: [{ id: 1, name: 'Ada' }] };
    const first = target.commitBatch(input);
    const replay = target.commitBatch(input);
    assert.equal(first.status, 'COMMITTED_EXACT');
    assert.equal(replay.status, 'COMMITTED_EXACT');
    assert.equal(replay.alreadyCommitted, true);
    assert.equal(countRows(path), 1);
    target.close();
  });
});

test('same batch identity with different payload is a conflict', async () => {
  await withDatabase(async path => {
    const target = new SqliteTarget({ path, table: 'customers' });
    target.commitBatch({ ...IDS, rows: [{ id: 1, name: 'Ada' }] });
    assert.throws(
      () => target.commitBatch({ ...IDS, rows: [{ id: 2, name: 'Changed' }] }),
      /BATCH_IDENTITY_CONFLICT/
    );
    assert.equal(countRows(path), 1);
    target.close();
  });
});
