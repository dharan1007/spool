import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { CredentialBroker } from '../src/daemon/credential-broker.js';
import { inspectMssqlTarget } from '../src/connectors/mssql/preflight.js';
import { ensureMssqlMetadata, MssqlTarget } from '../src/connectors/mssql/target.js';
import { ensureMssqlDatabase, mssqlPoolConfig, MSSQL_TEST_ENV } from './conformance/mssql-helpers.js';

const endpoint = process.env.SPOOL_TEST_MSSQL_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_MSSQL_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_MSSQL_USER ?? 'sa';
const password = process.env.SPOOL_TEST_MSSQL_PASSWORD ?? '';
const enabled = Boolean(endpoint && password && process.env.SPOOL_TEST_MSSQL_READER_PASSWORD);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_MSSQL_PASSWORD' };
const broker = new CredentialBroker();

function ref(table) {
  return {
    connector: 'mssql',
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

async function pool() {
  const p = new sql.ConnectionPool(mssqlPoolConfig(user, password));
  await p.connect();
  return p;
}

const H = c => 'sha256:' + c.repeat(64);
let seq = 0;
function batch(table, contract, rows) {
  seq += 1;
  return {
    batchIdentity: H((seq % 15).toString(16)),
    migrationId: `industrial-mssql-redteam-${table}`,
    planId: H('a'),
    sourceSnapshotId: H('b'),
    mappingRevision: 1,
    rows,
    targetContractId: contract
  };
}

test('SQL Server target contract rejects INSTEAD OF INSERT triggers', { skip: !enabled, timeout: 180_000 }, async t => {
  await ensureMssqlDatabase();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const table = `rt_trig_${suffix}`;
  const trigger = `rt_trig_io_${suffix}`;
  const p = await pool();
  t.after(async () => {
    try { await p.request().query(`IF OBJECT_ID('dbo.${trigger}', 'TR') IS NOT NULL DROP TRIGGER dbo.[${trigger}]`); } catch {}
    try { await p.request().query(`IF OBJECT_ID('dbo.${table}', 'U') IS NOT NULL DROP TABLE dbo.[${table}]`); } catch {}
    await p.close();
  });

  await p.request().query(`CREATE TABLE dbo.[${table}] (id INT PRIMARY KEY, name NVARCHAR(64) NOT NULL)`);
  await p.request().query(`
    CREATE TRIGGER dbo.[${trigger}] ON dbo.[${table}]
    INSTEAD OF INSERT
    AS
    BEGIN
      SET NOCOUNT ON;
      INSERT INTO dbo.[${table}] (id, name)
      SELECT id, CONCAT(N'mutated-', name)
      FROM inserted
      WHERE id <> 2;
    END
  `);

  await assert.rejects(
    inspectMssqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker }),
    error => /TRIGGER|TARGET_CONTRACT|UNSUPPORTED/i.test(String(error?.code ?? error?.message ?? error)),
    'INSTEAD OF-triggered SQL Server target was accepted into exactCommitEvidence mode'
  );
});

test('SQL Server COMMITTED_EXACT cannot coexist with an INSTEAD OF trigger that suppresses/mutates rows', { skip: !enabled, timeout: 180_000 }, async t => {
  await ensureMssqlDatabase();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const table = `rt_exact_${suffix}`;
  const trigger = `rt_exact_io_${suffix}`;
  const p = await pool();
  t.after(async () => {
    try { await p.request().query(`IF OBJECT_ID('dbo.${trigger}', 'TR') IS NOT NULL DROP TRIGGER dbo.[${trigger}]`); } catch {}
    try { await p.request().query(`IF OBJECT_ID('dbo.${table}', 'U') IS NOT NULL DROP TABLE dbo.[${table}]`); } catch {}
    await p.close();
  });

  await p.request().query(`CREATE TABLE dbo.[${table}] (id INT PRIMARY KEY, name NVARCHAR(64) NOT NULL)`);
  const preflight = await inspectMssqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  await ensureMssqlMetadata({ targetRef: ref(table), credentialBroker: broker });

  await p.request().query(`
    CREATE TRIGGER dbo.[${trigger}] ON dbo.[${table}]
    INSTEAD OF INSERT
    AS
    BEGIN
      SET NOCOUNT ON;
      INSERT INTO dbo.[${table}] (id, name)
      SELECT id, CONCAT(N'mutated-', name)
      FROM inserted
      WHERE id <> 2;
    END
  `);

  const target = new MssqlTarget({ targetRef: ref(table), credentialBroker: broker, requireFencing: false });
  let committed = null;
  try {
    committed = await target.commitBatch(batch(table, preflight.targetContractId, [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Lin' }
    ]));
  } catch (error) {
    assert.match(String(error?.code ?? error?.message ?? error), /TARGET_CONTRACT_CHANGED|TRIGGER|UNSUPPORTED/i);
    return;
  }

  assert.notEqual(committed.status, 'COMMITTED_EXACT',
    'SQL Server returned COMMITTED_EXACT even though an INSTEAD OF trigger can suppress and mutate the requested rows');
});

test('SQL Server target contract changes when NVARCHAR width changes', { skip: !enabled, timeout: 180_000 }, async t => {
  await ensureMssqlDatabase();
  const table = `rt_width_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const p = await pool();
  t.after(async () => {
    try { await p.request().query(`IF OBJECT_ID('dbo.${table}', 'U') IS NOT NULL DROP TABLE dbo.[${table}]`); } catch {}
    await p.close();
  });

  await p.request().query(`CREATE TABLE dbo.[${table}] (id INT PRIMARY KEY, name NVARCHAR(64) NOT NULL)`);
  const before = await inspectMssqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  await p.request().query(`ALTER TABLE dbo.[${table}] ALTER COLUMN name NVARCHAR(8) NOT NULL`);
  const after = await inspectMssqlTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  assert.notEqual(after.targetContractId, before.targetContractId,
    'narrowing NVARCHAR(64) to NVARCHAR(8) left the SQL Server target contract unchanged');
});
