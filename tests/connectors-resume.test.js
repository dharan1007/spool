import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FilesystemConnector } from '../src/connectors/filesystem.js';
import { SQLiteConnector } from '../src/connectors/sqlite.js';

test('filesystem read resumes strictly after persisted row offset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-fs-resume-'));
  try {
    const resource = 'rows.jsonl';
    await writeFile(join(root, resource), [1, 2, 3, 4, 5].map(id => JSON.stringify({ id })).join('\n') + '\n');
    const connector = new FilesystemConnector({ root });
    const connection = await connector.validateConfig({ root });
    const rows = [];
    for await (const batch of connector.read({ connection }, { resource, batchSize: 2, cursor: { offset: 2 } })) rows.push(...batch.rows);
    assert.deepEqual(rows.map(row => row.id), [3, 4, 5]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sqlite integer-primary-key read resumes strictly after persisted cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-sqlite-resume-'));
  const database = join(root, 'data.db');
  try {
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)');
    for (const [id, name] of [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']]) insert.run(id, name);
    db.close();

    const connector = new SQLiteConnector({ database });
    const connection = await connector.validateConfig({ database });
    const rows = [];
    for await (const batch of connector.read({ connection }, {
      resource: 'customers',
      batchSize: 2,
      cursor: { primaryKey: 'id', value: 2, offset: 2 }
    })) rows.push(...batch.rows);
    assert.deepEqual(rows.map(row => row.id), [3, 4]);
    await connector.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sqlite source identity changes when row content changes without changing row count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-sqlite-identity-'));
  const database = join(root, 'data.db');
  try {
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO customers VALUES (1, 'Ada'), (2, 'Grace')");
    db.close();

    const connector = new SQLiteConnector({ database });
    const connection = await connector.validateConfig({ database });
    const before = await connector.discover({ connection }, { resource: 'customers' });
    await connector.close();

    const mutate = new DatabaseSync(database);
    mutate.prepare('UPDATE customers SET name = ? WHERE id = ?').run('Changed', 2);
    mutate.close();

    const second = new SQLiteConnector({ database });
    const secondConnection = await second.validateConfig({ database });
    const after = await second.discover({ connection: secondConnection }, { resource: 'customers' });
    assert.equal(before.rowCount, after.rowCount);
    assert.notEqual(before.identity, after.identity);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sqlite checksum capability is backed by a full deterministic checksum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-sqlite-checksum-'));
  const database = join(root, 'data.db');
  try {
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO customers VALUES (1, 'Ada'), (2, 'Grace')");
    db.close();
    const connector = new SQLiteConnector({ database });
    const connection = await connector.validateConfig({ database });
    const verification = await connector.verify({ connection }, { resource: 'customers', expectedRows: 2 });
    assert.match(verification.checksum, /^sha256:[a-f0-9]{64}$/);
    assert.ok(verification.checks.some(check => check.name === 'full_checksum' && check.ok === true));
    await connector.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
