import { markDisposableQualification } from '../../src/platform/disposable-qualification.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { createMssqlTargetRuntime } from '../../src/connectors/mssql/runtime.js';
import { inspectMssqlTarget } from '../../src/connectors/mssql/preflight.js';
import { acquireMssqlLease, releaseMssqlLease, MssqlTarget } from '../../src/connectors/mssql/target.js';
import { SpoolCommandService } from '../../src/daemon/command-service.js';
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
const secretRef = { provider: 'env', key: 'SPOOL_TEST_MSSQL_PASSWORD' };
const broker = new CredentialBroker();
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;

function tableRef(table) {
  return {
    connector: 'mssql', connectionId: 'mssql-target', resource: `${database}.${table}`,
    endpoint, database, table, identity: { user }, secretRef
  };
}

function schema() {
  return [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false }
  ];
}

async function reset(table) {
  const pool = new sql.ConnectionPool(mssqlPoolConfig(user, password));
  await pool.connect();
  try {
    await pool.request().query(`IF OBJECT_ID('dbo.${table}', 'U') IS NOT NULL DROP TABLE dbo.${table}`);
    await pool.request().query(`CREATE TABLE dbo.${table} (id INT PRIMARY KEY, name NVARCHAR(64) NOT NULL)`);
  } finally { await pool.close(); }
}

test('SQL Server target commits fenced batches with ledger evidence and refuses stale writers', { skip: !enabled }, async () => {
  await ensureMssqlDatabase();
  const table = 'mssql_tgt_fence';
  await reset(table);
  const runtime = createMssqlTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectMssqlTarget({ targetRef: tableRef(table), targetSchema: schema(), credentialBroker: broker });
  assert.equal(preflight.status, 'READY');
  const execution = runtime.createExecution({ migrationId: 'mssql_fence_001', targetRef: tableRef(table) });
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    const input = {
      batchIdentity: `sha256:${'c'.repeat(64)}`,
      migrationId: 'mssql_fence_001',
      planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      mappingRevision: 1,
      rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }],
      fencingToken: lease.fencingToken,
      targetContractId: preflight.targetContractId
    };
    const committed = await target.commitBatch(input);
    assert.equal(committed.status, 'COMMITTED_EXACT');
    assert.equal(committed.alreadyCommitted, false);
    const again = await target.commitBatch(input);
    assert.equal(again.alreadyCommitted, true);
    const reconciled = await target.reconcileTargetCommit({ ...input, payloadHash: committed.payloadHash, rowCount: 2 });
    assert.equal(reconciled.status, 'COMMITTED_EXACT');
    const unknown = await target.reconcileTargetCommit({ ...input, batchIdentity: `sha256:${'d'.repeat(64)}`, payloadHash: committed.payloadHash, rowCount: 2 });
    assert.equal(unknown.status, 'NOT_COMMITTED');

    const probeResource = 'mssql-test:fence:probe';
    const probeLease = await acquireMssqlLease({ targetRef: tableRef(table), credentialBroker: broker, resource: probeResource, owner: 'probe-a', ttlMs: 60_000 });
    const probeTarget = new MssqlTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: probeResource, fenceOwner: 'probe-a' });
    try {
      await releaseMssqlLease({ targetRef: tableRef(table), credentialBroker: broker, resource: probeResource, owner: 'probe-a', fencingToken: probeLease.fencingToken });
      const takenOver = await acquireMssqlLease({ targetRef: tableRef(table), credentialBroker: broker, resource: probeResource, owner: 'probe-b', ttlMs: 60_000 });
      assert.ok(takenOver.fencingToken !== probeLease.fencingToken);
      await assert.rejects(
        () => probeTarget.commitBatch({ ...input, batchIdentity: `sha256:${'e'.repeat(64)}`, fencingToken: probeLease.fencingToken }),
        error => error?.code === 'STALE_FENCE'
      );
    } finally {
      probeTarget.close();
    }
  } finally {
    await execution.close();
  }
});

test('SQL Server target refuses contract drift', { skip: !enabled }, async () => {
  await ensureMssqlDatabase();
  const table = 'mssql_tgt_contract';
  await reset(table);
  const runtime = createMssqlTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectMssqlTarget({ targetRef: tableRef(table), targetSchema: schema(), credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'mssql_contract_001', targetRef: tableRef(table) });
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    const drift = new sql.ConnectionPool(mssqlPoolConfig(user, password));
    await drift.connect();
    try {
      await drift.request().query(`ALTER TABLE dbo.${table} ADD nick NVARCHAR(64) NULL`);
    } finally { await drift.close(); }
    await assert.rejects(
      () => target.commitBatch({
        batchIdentity: `sha256:${'f'.repeat(64)}`,
        migrationId: 'mssql_contract_001',
        planId: PLAN_ID,
        sourceSnapshotId: SNAPSHOT_ID,
        mappingRevision: 1,
        rows: [{ id: 1, name: 'Ada' }],
        fencingToken: lease.fencingToken,
        targetContractId: preflight.targetContractId
      }),
      error => error?.code === 'TARGET_CONTRACT_CHANGED'
    );
  } finally {
    await execution.close();
  }
});

function migrationRequest(sourcePath, targetTable, migrationId, checks = ['row_accounting', 'ledger_complete']) {
  return {
    migrationId,
    principal: 'operator:mssql-target',
    planInput: {
      planRevision: 1,
      sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'rows.csv', path: sourcePath },
      targetRef: tableRef(targetTable),
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false }
      ],
      mapping: [
        { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
        { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
      ],
      mappingRevision: 1,
      writeStrategy: { mode: 'insert', batchSize: 2 },
      verification: { checks },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true },
        target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true }
      }
    }
  };
}

async function serviceFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-mssql-target-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'rows.csv');
  await writeFile(sourcePath, 'id,name\n1,Ada\n2,Lin\n3,Grace\n');
  const service = await SpoolCommandService.create({
    qualification: await markDisposableQualification(dir),
    sourceRoot, targetRoot, snapshotDir: join(dir, 'snapshots'),
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-mssql-test', commitSha: '5123456789abcdef0123456789abcdef01234567' }
  });
  return { dir, sourcePath, service };
}

test('filesystem-to-SQL Server migration completes with ledger evidence', { skip: !enabled }, async t => {
  await ensureMssqlDatabase();
  const table = 'mssql_tgt_e2e';
  await reset(table);
  const { dir, sourcePath, service } = await serviceFixture();
  t.after(async () => { try { service.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  try {
    const request = migrationRequest(sourcePath, table, 'mssql_e2e_001');
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'mssql-e2e' });
    assert.ok(approval.record.effects.includes('mssql:insert_rows'));
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.deepEqual(result.receipt.record.counts, { sourceRows: 3, writtenRows: 3, rejectedRows: 0, filteredRows: 0 });
    const check = new sql.ConnectionPool(mssqlPoolConfig(user, password));
    await check.connect();
    try {
      const rows = await check.request().query(`SELECT id, name FROM dbo.${table} ORDER BY id`);
      assert.deepEqual(rows.recordset.map(row => ({ id: Number(row.id), name: row.name })), [
        { id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }, { id: 3, name: 'Grace' }
      ]);
    } finally { await check.close(); }
  } finally {
    service.close();
  }
});

test('SQL Server target refuses content-exact verification and bulk writes', { skip: !enabled }, async t => {
  await ensureMssqlDatabase();
  const table = 'mssql_tgt_capability';
  await reset(table);
  const { dir, sourcePath, service } = await serviceFixture();
  t.after(async () => { try { service.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  try {
    const exact = migrationRequest(sourcePath, table, 'mssql_capability_exact',
      ['row_accounting', 'ledger_complete', 'content_exact']);
    exact.planInput.capabilityAssumptions.target.readAfterWriteVerification = true;
    await assert.rejects(() => service.inspect(exact), error => error?.code === 'CONTENT_VERIFICATION_CAPABILITY_REQUIRED');

    const bulk = migrationRequest(sourcePath, table, 'mssql_capability_bulk');
    bulk.planInput.writeStrategy = { mode: 'insert', batchSize: 2, bulk: true };
    await assert.rejects(() => service.inspect(bulk), error => error?.code === 'BULK_WRITE_CAPABILITY_REQUIRED');
  } finally {
    service.close();
  }
});
