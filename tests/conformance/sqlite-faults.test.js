import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SqliteTarget } from '../../src/connectors/sqlite/target.js';
import { inspectSqliteTarget } from '../../src/connectors/sqlite/preflight.js';

const planId = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const sourceSnapshotId = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const schema = [
  { name: 'id', type: 'integer', nullable: false },
  { name: 'name', type: 'string', nullable: false }
];

async function databaseFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-faults-'));
  const path = join(dir, 'target.db');
  const db = new Database(path);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  try { await fn({ dir, path }); } finally { await rm(dir, { recursive: true, force: true }); }
}

function batch(path, batchIdentity, rows, targetContractId) {
  return {
    migrationId: 'mig_faults_001', planId, sourceSnapshotId, mappingRevision: 1,
    batchIdentity, targetContractId,
    targetIdentity: { connector: 'sqlite', connectionId: 'dst', resource: 'customers', path, table: 'customers' }, rows
  };
}

test('Gate B fault: external schema drift is rejected inside the write transaction with zero migrated rows', async () => {
  await databaseFixture(async ({ path }) => {
    const preflight = inspectSqliteTarget({ path, table: 'customers', targetSchema: schema });
    const target = new SqliteTarget({ path, table: 'customers' });
    const external = new Database(path);
    external.exec('CREATE INDEX ix_customers_name ON customers(name);');
    external.close();
    assert.throws(() => target.commitBatch(batch(
      path,
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      [{ id: 1, name: 'Ada' }],
      preflight.targetContractId
    )), /TARGET_CONTRACT_CHANGED/);
    target.close();
    const verify = new Database(path, { readonly: true });
    assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM customers').get().count), 0);
    assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM __spool_batch_ledger').get().count), 0);
    verify.close();
  });
});

test('Gate B fault: SQLite lock contention fails without rows or ledger evidence', async () => {
  await databaseFixture(async ({ path }) => {
    const target = new SqliteTarget({ path, table: 'customers', busyTimeoutMs: 30 });
    const blocker = new Database(path);
    blocker.exec('BEGIN EXCLUSIVE;');
    assert.throws(() => target.commitBatch(batch(
      path,
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      [{ id: 1, name: 'Locked' }],
      null
    )), error => /locked|busy/i.test(String(error?.message)) || error?.code === 'SQLITE_BUSY');
    blocker.exec('ROLLBACK;');
    blocker.close();
    assert.equal(target.ledgerEntries().length, 0);
    target.close();
    const verify = new Database(path, { readonly: true });
    assert.equal(Number(verify.prepare('SELECT COUNT(*) AS count FROM customers').get().count), 0);
    verify.close();
  });
});

test('Gate B fault: corrupt database files fail target preflight before execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-corrupt-'));
  const path = join(dir, 'corrupt.db');
  try {
    await writeFile(path, Buffer.from('not-a-sqlite-database\u0000garbage'));
    assert.throws(() => inspectSqliteTarget({ path, table: 'customers', targetSchema: schema }), /TARGET_PREFLIGHT_FAILED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Gate B fault: triggers are rejected because they introduce undeclared target side effects', async () => {
  await databaseFixture(async ({ path }) => {
    const db = new Database(path);
    db.exec("CREATE TRIGGER customers_ai AFTER INSERT ON customers BEGIN UPDATE customers SET name=name WHERE id=NEW.id; END;");
    db.close();
    assert.throws(() => inspectSqliteTarget({ path, table: 'customers', targetSchema: schema }), /TARGET_TRIGGER_UNSUPPORTED/);
  });
});

test('Gate B fault: unwritable SQLite targets fail closed on POSIX systems', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-readonly-'));
  const lockedDir = join(dir, 'locked');
  await mkdir(lockedDir);
  const path = join(lockedDir, 'target.db');
  const db = new Database(path);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  try {
    await chmod(path, 0o444);
    await chmod(lockedDir, 0o555);
    assert.throws(() => {
      const target = new SqliteTarget({ path, table: 'customers', busyTimeoutMs: 30 });
      try {
        target.commitBatch(batch(
          path,
          'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          [{ id: 1, name: 'Readonly' }],
          null
        ));
      } finally { target.close(); }
    });
  } finally {
    await chmod(lockedDir, 0o755).catch(() => {});
    await chmod(path, 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
