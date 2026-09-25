import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { CredentialBroker } from '../src/daemon/credential-broker.js';
import { inspectMysqlTarget } from '../src/connectors/mysql/preflight.js';
import { ensureMysqlMetadata, MysqlTarget } from '../src/connectors/mysql/target.js';

const endpoint = process.env.SPOOL_TEST_MYSQL_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_MYSQL_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_MYSQL_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_MYSQL_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_MYSQL_PASSWORD' };
const broker = new CredentialBroker();

function ref(table) {
  return {
    connector: 'mysql',
    connectionId: 'industrial-redteam',
    resource: `${database}.${table}`,
    endpoint,
    database,
    table,
    identity: { user },
    secretRef
  };
}

function schema() {
  return [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false }
  ];
}

async function connection() {
  const url = new URL(endpoint);
  return mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user,
    password,
    database
  });
}

const H = c => 'sha256:' + c.repeat(64);
let seq = 0;
function batch(table, contract, rows) {
  seq += 1;
  return {
    batchIdentity: H((seq % 15).toString(16)),
    migrationId: `industrial-mysql-redteam-${table}`,
    planId: H('a'),
    sourceSnapshotId: H('b'),
    mappingRevision: 1,
    rows,
    targetContractId: contract
  };
}

test('MySQL exact commit rejects nontransactional MyISAM targets and never leaves partial writes after rollback', { skip: !enabled, timeout: 120_000 }, async t => {
  const table = `rt_myisam_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const c = await connection();
  t.after(async () => {
    try { await c.query(`DROP TABLE IF EXISTS \`${table}\``); } catch {}
    await c.end();
  });

  await c.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL) ENGINE=MyISAM`);
  const preflight = await inspectMysqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });

  assert.notEqual(
    preflight.status,
    'READY',
    'nontransactional MyISAM target was accepted into a runtime that advertises transactions + atomicBatchLedger'
  );
});

test('MySQL failed batch cannot leave target rows without matching ledger evidence on a nontransactional engine', { skip: !enabled, timeout: 120_000 }, async t => {
  const table = `rt_myisam_partial_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const c = await connection();
  t.after(async () => {
    try { await c.query(`DROP TABLE IF EXISTS \`${table}\``); } catch {}
    await c.end();
  });

  await c.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL) ENGINE=MyISAM`);
  await c.query(`INSERT INTO \`${table}\` (id, name) VALUES (2, 'existing')`);
  const preflight = await inspectMysqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  await ensureMysqlMetadata({ targetRef: ref(table), credentialBroker: broker });

  const target = new MysqlTarget({ targetRef: ref(table), credentialBroker: broker, requireFencing: false });
  const input = batch(table, preflight.targetContractId, [
    { id: 1, name: 'partial-write-must-rollback' },
    { id: 2, name: 'duplicate-causes-error' }
  ]);

  await assert.rejects(target.commitBatch(input));
  const [rows] = await c.query(`SELECT id, name FROM \`${table}\` ORDER BY id`);
  assert.deepEqual(
    rows.map(r => Number(r.id)),
    [2],
    'failed COMMIT_EXACT batch left a partial target write because target engine is nontransactional'
  );
});

test('MySQL target contract rejects a BEFORE INSERT trigger that mutates source values', { skip: !enabled, timeout: 120_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const table = `rt_trig_${suffix}`;
  const trigger = `rt_trig_bi_${suffix}`;
  const c = await connection();
  t.after(async () => {
    try { await c.query(`DROP TRIGGER IF EXISTS \`${trigger}\``); } catch {}
    try { await c.query(`DROP TABLE IF EXISTS \`${table}\``); } catch {}
    await c.end();
  });

  await c.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL) ENGINE=InnoDB`);
  await c.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON \`${table}\`
    FOR EACH ROW SET NEW.name = CONCAT('mutated-', NEW.name)`);

  await assert.rejects(
    inspectMysqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker }),
    error => /TRIGGER|TARGET_CONTRACT|UNSUPPORTED/i.test(String(error?.code ?? error?.message ?? error)),
    'trigger-bearing MySQL target was accepted even though target-side mutation is outside the approved source payload'
  );
});

test('MySQL target contract changes when VARCHAR width changes', { skip: !enabled, timeout: 120_000 }, async t => {
  const table = `rt_width_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const c = await connection();
  t.after(async () => {
    try { await c.query(`DROP TABLE IF EXISTS \`${table}\``); } catch {}
    await c.end();
  });

  await c.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL) ENGINE=InnoDB`);
  const before = await inspectMysqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  await c.query(`ALTER TABLE \`${table}\` MODIFY name VARCHAR(8) NOT NULL`);
  const after = await inspectMysqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  assert.notEqual(after.targetContractId, before.targetContractId,
    'narrowing VARCHAR(64) to VARCHAR(8) left the MySQL target contract unchanged');
});
