import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SqliteTarget } from '../src/connectors/sqlite/target.js';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-bool-'));
  const path = join(dir, 'target.db');
  const db = new Database(path);
  db.exec('CREATE TABLE flags (id INTEGER PRIMARY KEY, active INTEGER NOT NULL) STRICT;');
  db.close();
  try { await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('Gate B stores semantic booleans as deterministic SQLite 1/0 values', async () => {
  await fixture(async path => {
    const target = new SqliteTarget({ path, table: 'flags' });
    target.commitBatch({
      migrationId: 'mig_bool',
      planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceSnapshotId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      mappingRevision: 1,
      batchIdentity: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      rows: [{ id: 1, active: true }, { id: 2, active: false }]
    });
    target.close();
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('SELECT id, active FROM flags ORDER BY id').all().map(row => ({ id: Number(row.id), active: Number(row.active) }));
    db.close();
    assert.deepEqual(rows, [{ id: 1, active: 1 }, { id: 2, active: 0 }]);
  });
});
