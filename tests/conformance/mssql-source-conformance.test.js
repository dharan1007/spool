import test from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { createMssqlSourceRuntime } from '../../src/connectors/mssql/source.js';
import { SOURCE_STATE_KINDS } from '../../src/protocol/state-descriptors.js';
import {
  MSSQL_TEST_ENABLED as enabled,
  MSSQL_TEST_ENV,
  ensureMssqlDatabase,
  mssqlPoolConfig
} from './mssql-helpers.js';

const endpoint = MSSQL_TEST_ENV.endpoint;
const database = MSSQL_TEST_ENV.database;
const user = MSSQL_TEST_ENV.user;
const password = MSSQL_TEST_ENV.password;
const readerUser = MSSQL_TEST_ENV.readerUser;
const readerPassword = MSSQL_TEST_ENV.readerPassword;
const secretRef = { provider: 'env', key: 'SPOOL_TEST_MSSQL_PASSWORD' };
const readerSecretRef = { provider: 'env', key: 'SPOOL_TEST_MSSQL_READER_PASSWORD' };
const broker = new CredentialBroker();

async function saPool(asDatabase = 'master') {
  const pool = new sql.ConnectionPool(mssqlPoolConfig(user, password, asDatabase));
  await pool.connect();
  return pool;
}

function tableRef(table, asUser = readerUser, refSecret = readerSecretRef) {
  return {
    connector: 'mssql', connectionId: 'mssql-source', resource: `${database}.${table}`,
    endpoint, database, table, identity: { user: asUser }, secretRef: refSecret
  };
}

async function reset(table = 'mssql_src_items') {
  const pool = await saPool(database);
  try {
    await pool.request().query(`IF OBJECT_ID('dbo.${table}', 'U') IS NOT NULL DROP TABLE dbo.${table}`);
    await pool.request().query(`CREATE TABLE dbo.${table} (id INT PRIMARY KEY, name NVARCHAR(64) NOT NULL, created DATETIME2 NOT NULL)`);
    for (let id = 1; id <= 5; id += 1) {
      await pool.request()
        .input('p1', id)
        .input('p2', `item-${id}`)
        .input('p3', `2026-03-0${id} 05:06:07`)
        .query(`INSERT INTO dbo.${table} (id, name, created) VALUES (@p1, @p2, @p3)`);
    }
  } finally { await pool.close(); }
}

test('SQL Server source streams exact snapshot contents with snapshot identity', { skip: !enabled }, async () => {
  await ensureMssqlDatabase();
  await reset();
  const runtime = createMssqlSourceRuntime({ credentialBroker: broker });
  const seen = await runtime.withSnapshot(tableRef('mssql_src_items'), async snapshot => {
    assert.equal(snapshot.sourceState.kind, SOURCE_STATE_KINDS.MSSQL);
    assert.match(snapshot.sourceState.state.snapshot.sessionId, /^\d+$/);
    assert.equal(snapshot.sourceState.state.snapshot.isolationLevel, 'SNAPSHOT');
    assert.deepEqual(snapshot.contract.primaryKey, ['id']);
    const rows = [];
    for await (const batch of snapshot.batches()) rows.push(...batch.rows);
    return rows;
  });
  assert.equal(seen.length, 5);
  assert.deepEqual(seen.map(row => Number(row.id)), [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.map(row => row.name), ['item-1', 'item-2', 'item-3', 'item-4', 'item-5']);
  assert.ok(seen.every(row => row.created instanceof Date));
  assert.equal(seen[0].created.toISOString(), '2026-03-01T05:06:07.000Z');
});

test('SQL Server snapshot hides concurrent writes committed after snapshot start', { skip: !enabled }, async () => {
  await ensureMssqlDatabase();
  await reset();
  const runtime = createMssqlSourceRuntime({ credentialBroker: broker });
  await runtime.withSnapshot(tableRef('mssql_src_items'), async snapshot => {
    const iterator = snapshot.batches()[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value.rows.length, 2);
    const writer = new sql.ConnectionPool(mssqlPoolConfig(user, password));
    await writer.connect();
    try {
      await writer.request().query('INSERT INTO dbo.mssql_src_items (id, name, created) VALUES (999, \'late\', \'2026-01-01\')');
      await writer.request().query('UPDATE dbo.mssql_src_items SET name = \'changed\' WHERE id = 1');
    } finally { await writer.close(); }
    const rest = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      rest.push(...step.value.rows);
    }
    const ids = [...first.value.rows, ...rest].map(row => Number(row.id));
    assert.deepEqual(ids, [1, 2, 3, 4, 5]);
    assert.equal([...first.value.rows, ...rest].find(row => Number(row.id) === 1).name, 'item-1');
  }, { batchSize: 2 });
  const check = new sql.ConnectionPool(mssqlPoolConfig(user, password));
  await check.connect();
  try {
    const count = await check.request().query('SELECT COUNT(*) AS n FROM dbo.mssql_src_items');
    assert.equal(Number(count.recordset[0].n), 6);
  } finally { await check.close(); }
});

test('SQL Server source requires a primary key for deterministic traversal', { skip: !enabled }, async () => {
  await ensureMssqlDatabase();
  const pool = await saPool(database);
  try {
    await pool.request().query('IF OBJECT_ID(\'dbo.mssql_src_nopk\', \'U\') IS NOT NULL DROP TABLE dbo.mssql_src_nopk');
    await pool.request().query('CREATE TABLE dbo.mssql_src_nopk (id INT NOT NULL, name NVARCHAR(64) NOT NULL)');
  } finally { await pool.close(); }
  const runtime = createMssqlSourceRuntime({ credentialBroker: broker });
  await assert.rejects(
    runtime.withSnapshot(tableRef('mssql_src_nopk'), async () => {}),
    error => error?.code === 'MSSQL_SOURCE_ORDER_REQUIRED'
  );
});

test('SQL Server source refuses snapshots for principals with mutating rights', { skip: !enabled }, async () => {
  await ensureMssqlDatabase();
  await reset();
  const runtime = createMssqlSourceRuntime({ credentialBroker: broker });
  const saRef = {
    connector: 'mssql', connectionId: 'mssql-source', resource: `${database}.mssql_src_items`,
    endpoint, database, table: 'mssql_src_items', identity: { user }, secretRef
  };
  await assert.rejects(
    runtime.withSnapshot(saRef, async () => {}),
    error => error?.code === 'MSSQL_SOURCE_NOT_READ_ONLY'
  );
});
