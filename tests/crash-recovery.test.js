import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTarget } from '../src/connectors/sqlite/target.js';
import { MigrationRunner } from '../src/execution/migration-runner.js';

const planId = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const sourceSnapshotId = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

async function setup(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-crash-'));
  const path = join(dir, 'target.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  try { await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

function count(path) {
  const db = new DatabaseSync(path);
  try { return Number(db.prepare('SELECT COUNT(*) AS count FROM customers').get().count); }
  finally { db.close(); }
}

test('commit-before-checkpoint crash reconciles exact target commit before replay', async () => {
  await setup(async path => {
    const target = new SqliteTarget({ path, table: 'customers' });
    let checkpoint = null;
    const checkpointStore = {
      load: () => checkpoint,
      save: value => { checkpoint = value; }
    };
    const runner = new MigrationRunner({ target, checkpointStore });
    const batch = {
      migrationId: 'mig_crash_001',
      planId,
      sourceSnapshotId,
      mappingRevision: 1,
      sourceRange: { start: 0, endExclusive: 2 },
      targetIdentity: { connector: 'sqlite', connectionId: 'dst', resource: 'customers', path },
      rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }]
    };

    assert.throws(() => runner.runBatch(batch, { faultAfterTargetCommit: true }), /FAULT_AFTER_TARGET_COMMIT/);
    assert.equal(count(path), 2);
    assert.equal(checkpoint, null);

    const recovered = runner.runBatch(batch);
    assert.equal(recovered.status, 'COMMITTED_EXACT');
    assert.equal(recovered.recovered, true);
    assert.equal(count(path), 2);
    assert.equal(checkpoint.nextOffset, 2);
    assert.equal(checkpoint.lastBatchIdentity, recovered.batchIdentity);
    target.close();
  });
});

test('runner fails closed on reconciliation conflict instead of replaying', async () => {
  await setup(async path => {
    const target = new SqliteTarget({ path, table: 'customers' });
    const checkpointStore = { load: () => null, save: () => assert.fail('must not checkpoint conflict') };
    const runner = new MigrationRunner({ target, checkpointStore });
    const original = {
      migrationId: 'mig_conflict_001',
      planId,
      sourceSnapshotId,
      mappingRevision: 1,
      sourceRange: { start: 0, endExclusive: 1 },
      targetIdentity: { connector: 'sqlite', connectionId: 'dst', resource: 'customers', path },
      rows: [{ id: 1, name: 'Ada' }]
    };
    const first = runner.runBatch(original);
    assert.equal(first.status, 'COMMITTED_EXACT');

    const conflictingTarget = new SqliteTarget({ path, table: 'customers' });
    const conflictingRunner = new MigrationRunner({ target: conflictingTarget, checkpointStore });
    const changed = { ...original, rows: [{ id: 2, name: 'Changed' }] };
    assert.throws(() => conflictingRunner.runBatch(changed), /TARGET_RECONCILIATION_CONFLICT/);
    assert.equal(count(path), 1);
    conflictingTarget.close();
    target.close();
  });
});
