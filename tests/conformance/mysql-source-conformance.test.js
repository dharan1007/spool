import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { createMysqlSourceRuntime } from '../../src/connectors/mysql/source.js';
import { SOURCE_STATE_KINDS } from '../../src/protocol/state-descriptors.js';

const endpoint = process.env.SPOOL_TEST_MYSQL_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_MYSQL_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_MYSQL_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_MYSQL_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_MYSQL_PASSWORD' };
const broker = new CredentialBroker();

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

function tableRef(table) {
  return {
    connector: 'mysql', connectionId: 'mysql-source', resource: `${database}.${table}`,
    endpoint, database, table, identity: { user }, secretRef
  };
}

function connectionConfig() {
  const url = new URL(endpoint);
  return { host: url.hostname, port: Number(url.port || 3306), user, password, database };
}

async function adminConnection() {
  const connection = await mysql.createConnection(connectionConfig());
  return connection;
}

async function waitForServer(timeoutMs = 120000) {
  const started = Date.now();
  for (;;) {
    try {
      const connection = await adminConnection();
      try {
        await connection.query('SELECT 1');
        return;
      } finally { await connection.end(); }
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for MySQL');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function reset(table = 'mysql_src_items') {
  const connection = await adminConnection();
  try {
    await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    await connection.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL, created DATETIME NOT NULL)`);
    for (let id = 1; id <= 5; id += 1) {
      await connection.query(`INSERT INTO \`${table}\`(id,name,created) VALUES (?,?,?)`, [id, `item-${id}`, `2026-03-0${id} 05:06:07`]);
    }
  } finally { await connection.end(); }
}

test('MySQL source streams exact snapshot contents with snapshot identity', { skip: !enabled }, async () => {
  await waitForServer();
  await reset();
  const runtime = createMysqlSourceRuntime({ credentialBroker: broker });
  const seen = await runtime.withSnapshot(tableRef('mysql_src_items'), async snapshot => {
    assert.equal(snapshot.sourceState.kind, SOURCE_STATE_KINDS.MYSQL);
    assert.match(snapshot.sourceState.state.serverUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.match(snapshot.sourceState.state.snapshot.trxId, /^\d+$/);
    assert.equal(snapshot.sourceState.state.snapshot.isolationLevel, 'REPEATABLE READ');
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

test('MySQL snapshot hides concurrent writes committed after snapshot start', { skip: !enabled }, async () => {
  await waitForServer();
  await reset();
  const runtime = createMysqlSourceRuntime({ credentialBroker: broker });
  await runtime.withSnapshot(tableRef('mysql_src_items'), async snapshot => {
    const iterator = snapshot.batches()[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value.rows.length, 2);
    const writer = await adminConnection();
    try {
      await writer.query('INSERT INTO `mysql_src_items`(id,name,created) VALUES (999,\'late\',\'2026-01-01 00:00:00\')');
      await writer.query('UPDATE `mysql_src_items` SET name=\'changed\' WHERE id=1');
    } finally { await writer.end(); }
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
  const check = await adminConnection();
  try {
    const [rows] = await check.query('SELECT COUNT(*) AS n FROM `mysql_src_items`');
    assert.equal(Number(rows[0].n), 6);
  } finally { await check.end(); }
});

test('MySQL source requires a primary key for deterministic traversal', { skip: !enabled }, async () => {
  await waitForServer();
  const connection = await adminConnection();
  try {
    await connection.query('DROP TABLE IF EXISTS `mysql_src_nopk`');
    await connection.query('CREATE TABLE `mysql_src_nopk` (id INT NOT NULL, name VARCHAR(64) NOT NULL)');
  } finally { await connection.end(); }
  const runtime = createMysqlSourceRuntime({ credentialBroker: broker });
  await assert.rejects(
    runtime.withSnapshot(tableRef('mysql_src_nopk'), async () => {}),
    error => error?.code === 'MYSQL_SOURCE_ORDER_REQUIRED'
  );
});
