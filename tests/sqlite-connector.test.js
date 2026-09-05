import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteConnector } from '../src/connectors/sqlite.js';
import { validateConnector } from '../src/connectors/contract.js';

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), 'spool-sqlite-'));
  const dbPath = join(root, 'data.db');
  try { return await fn(dbPath); } finally { await rm(root, { recursive: true, force: true }); }
}

function seed(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER)');
  const insert = db.prepare('INSERT INTO customers (id, name, active) VALUES (?, ?, ?)');
  insert.run(1, 'Ada', 1);
  insert.run(2, 'Grace', 0);
  insert.run(3, 'Linus', 1);
  db.close();
}

test('sqlite connector validates as a real transactional connector', async () => withDb(async dbPath => {
  seed(dbPath);
  const connector = new SQLiteConnector({ database: dbPath });
  const manifest = validateConnector(connector);
  assert.equal(manifest.name, 'sqlite');
  assert.equal(manifest.capabilities.transactions, true);
  assert.equal(manifest.capabilities.upsert, true);
  assert.equal(manifest.capabilities.ddl, true);
  assert.equal(typeof connector.query, 'undefined');
}));

test('sqlite discovery returns columns and integer primary key without exposing SQL execution', async () => withDb(async dbPath => {
  seed(dbPath);
  const connector = new SQLiteConnector({ database: dbPath });
  const connection = await connector.validateConfig({ database: dbPath });
  const discovered = await connector.discover({ connection }, { resource: 'customers' });
  assert.equal(discovered.resource, 'customers');
  assert.deepEqual(discovered.primaryKey, ['id']);
  assert.deepEqual(discovered.columns.map(column => column.name), ['id', 'name', 'active']);
  assert.equal(discovered.rowCount, 3);
  assert.equal(typeof connector.query, 'undefined');
  await connector.close();
}));

test('sqlite source read paginates by integer primary key in bounded batches', async () => withDb(async dbPath => {
  seed(dbPath);
  const connector = new SQLiteConnector({ database: dbPath });
  const connection = await connector.validateConfig({ database: dbPath });
  const batches = [];
  for await (const batch of connector.read({ connection }, { resource: 'customers', batchSize: 2 })) batches.push(batch);
  assert.deepEqual(batches.map(batch => batch.rows.length), [2, 1]);
  assert.deepEqual(batches.at(-1).cursor, { primaryKey: 'id', value: 3, offset: 3 });
  assert.deepEqual(batches.flatMap(batch => batch.rows).map(row => row.name), ['Ada', 'Grace', 'Linus']);
  await connector.close();
}));

test('sqlite target create_insert commits real rows and verifies count', async () => withDb(async dbPath => {
  const connector = new SQLiteConnector({ database: dbPath });
  const connection = await connector.validateConfig({ database: dbPath });
  const targetSchema = [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false }
  ];
  const plan = await connector.planWrite({ connection }, { resource: 'people', targetSchema, mode: 'create_insert' });
  assert.equal(plan.strategy, 'create_insert');
  const ack = await connector.write({ connection }, { resource: 'people', targetSchema, mode: 'create_insert' }, [
    { rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }], cursor: { offset: 2 } }
  ]);
  assert.equal(ack.committedRows, 2);
  assert.match(ack.checkpointToken, /^sqlite:/);
  const verification = await connector.verify({ connection }, { resource: 'people', expectedRows: 2 });
  assert.equal(verification.ok, true);
  assert.equal(verification.targetRows, 2);
  assert.equal(verification.sampleHash.startsWith('sha256:'), true);
  await connector.close();
}));

test('sqlite upsert updates existing key and inserts new key inside transaction', async () => withDb(async dbPath => {
  seed(dbPath);
  const connector = new SQLiteConnector({ database: dbPath });
  const connection = await connector.validateConfig({ database: dbPath });
  const targetSchema = [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false },
    { name: 'active', type: 'integer', nullable: true }
  ];
  const ack = await connector.write({ connection }, { resource: 'customers', targetSchema, mode: 'upsert', keyFields: ['id'] }, [
    { rows: [{ id: 2, name: 'Grace Hopper', active: 1 }, { id: 4, name: 'Margaret', active: 1 }], cursor: { offset: 2 } }
  ]);
  assert.equal(ack.committedRows, 2);
  const rows = [];
  for await (const batch of connector.read({ connection }, { resource: 'customers', batchSize: 10 })) rows.push(...batch.rows);
  assert.equal(rows.find(row => row.id === 2).name, 'Grace Hopper');
  assert.equal(rows.find(row => row.id === 4).name, 'Margaret');
  await connector.close();
}));

test('sqlite rejects arbitrary resource SQL instead of acting as a SQL proxy', async () => withDb(async dbPath => {
  seed(dbPath);
  const connector = new SQLiteConnector({ database: dbPath });
  const connection = await connector.validateConfig({ database: dbPath });
  await assert.rejects(() => connector.discover({ connection }, { resource: 'customers; DROP TABLE customers' }), /INVALID_SQLITE_RESOURCE|RESOURCE_NOT_FOUND/);
  await connector.close();
}));
