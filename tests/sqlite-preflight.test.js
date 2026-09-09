import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { inspectSqliteTarget } from '../src/connectors/sqlite/preflight.js';

async function withDb(sql, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-preflight-'));
  const path = join(dir, 'target.db');
  const db = new Database(path);
  db.exec(sql);
  db.close();
  try { await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

const schema = [
  { name: 'id', type: 'integer', nullable: false },
  { name: 'name', type: 'string', nullable: false },
  { name: 'joined_at', type: 'date', nullable: true }
];

test('preflight proves a compatible ordinary SQLite target and returns a semantic contract id', async () => {
  await withDb('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, joined_at TEXT); CREATE UNIQUE INDEX ux_customers_name ON customers(name);', async path => {
    const result = inspectSqliteTarget({ path, table: 'customers', targetSchema: schema });
    assert.equal(result.status, 'READY');
    assert.match(result.targetContractId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.columns.length, 3);
    assert.equal(result.indexes.length, 1);
  });
});

test('preflight rejects missing tables, incompatible affinity and required extra columns', async () => {
  await withDb('CREATE TABLE customers (id INTEGER PRIMARY KEY, name INTEGER NOT NULL, joined_at TEXT, tenant TEXT NOT NULL);', async path => {
    assert.throws(() => inspectSqliteTarget({ path, table: 'missing', targetSchema: schema }), /TARGET_TABLE_NOT_FOUND/);
    assert.throws(() => inspectSqliteTarget({ path, table: 'customers', targetSchema: schema }), /TARGET_SCHEMA_INCOMPATIBLE/);
  });
});

test('preflight rejects a target that is stricter-nullable than the declared contract', async () => {
  await withDb('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, joined_at TEXT NOT NULL);', async path => {
    assert.throws(() => inspectSqliteTarget({ path, table: 'customers', targetSchema: schema }), /TARGET_SCHEMA_INCOMPATIBLE/);
  });
});

test('Gate B rejects target triggers and contract identity changes when indexes change', async () => {
  await withDb('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, joined_at TEXT);', async path => {
    const first = inspectSqliteTarget({ path, table: 'customers', targetSchema: schema });
    const db = new Database(path);
    db.exec('CREATE INDEX ix_customers_joined_at ON customers(joined_at);');
    db.close();
    const second = inspectSqliteTarget({ path, table: 'customers', targetSchema: schema });
    assert.notEqual(first.targetContractId, second.targetContractId);

    const triggered = new Database(path);
    triggered.exec("CREATE TRIGGER customers_ai AFTER INSERT ON customers BEGIN UPDATE customers SET name = name WHERE id = NEW.id; END;");
    triggered.close();
    assert.throws(() => inspectSqliteTarget({ path, table: 'customers', targetSchema: schema }), /TARGET_TRIGGER_UNSUPPORTED/);
  });
});
