import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { createMysqlTargetRuntime } from '../../src/connectors/mysql/runtime.js';
import { inspectMysqlTarget } from '../../src/connectors/mysql/preflight.js';
import { acquireMysqlLease, releaseMysqlLease, MysqlTarget } from '../../src/connectors/mysql/target.js';
import { SpoolCommandService } from '../../src/daemon/command-service.js';

const endpoint = process.env.SPOOL_TEST_MYSQL_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_MYSQL_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_MYSQL_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_MYSQL_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_MYSQL_PASSWORD' };
const broker = new CredentialBroker();
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;

function tableRef(table, connectionId = 'mysql-target') {
  return {
    connector: 'mysql', connectionId, resource: `${database}.${table}`,
    endpoint, database, table, identity: { user }, secretRef
  };
}

function schema() {
  return [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false }
  ];
}

function connectionConfig() {
  const url = new URL(endpoint);
  return { host: url.hostname, port: Number(url.port || 3306), user, password, database };
}

async function adminConnection() {
  return mysql.createConnection(connectionConfig());
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

async function reset(table) {
  const connection = await adminConnection();
  try {
    await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    await connection.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)`);
  } finally { await connection.end(); }
}

test('MySQL target commits fenced batches with ledger evidence and refuses stale writers', { skip: !enabled }, async () => {
  await waitForServer();
  const table = 'mysql_tgt_fence';
  await reset(table);
  const runtime = createMysqlTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectMysqlTarget({ targetRef: tableRef(table), targetSchema: schema(), credentialBroker: broker });
  assert.equal(preflight.status, 'READY');
  const execution = runtime.createExecution({ migrationId: 'mysql_fence_001', targetRef: tableRef(table) });
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    const input = {
      batchIdentity: `sha256:${'c'.repeat(64)}`,
      migrationId: 'mysql_fence_001',
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

    const probeResource = 'mysql-test:fence:probe';
    const probeLease = await acquireMysqlLease({ targetRef: tableRef(table), credentialBroker: broker, resource: probeResource, owner: 'probe-a', ttlMs: 60_000 });
    const probeTarget = new MysqlTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: probeResource, fenceOwner: 'probe-a' });
    try {
      await releaseMysqlLease({ targetRef: tableRef(table), credentialBroker: broker, resource: probeResource, owner: 'probe-a', fencingToken: probeLease.fencingToken });
      const takenOver = await acquireMysqlLease({ targetRef: tableRef(table), credentialBroker: broker, resource: probeResource, owner: 'probe-b', ttlMs: 60_000 });
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

test('MySQL target refuses contract drift', { skip: !enabled }, async () => {
  await waitForServer();
  const table = 'mysql_tgt_contract';
  await reset(table);
  const runtime = createMysqlTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectMysqlTarget({ targetRef: tableRef(table), targetSchema: schema(), credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'mysql_contract_001', targetRef: tableRef(table) });
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    const client = await adminConnection();
    try {
      await client.query(`ALTER TABLE \`${table}\` ADD COLUMN nick VARCHAR(64) NULL`);
    } finally { await client.end(); }
    await assert.rejects(
      () => target.commitBatch({
        batchIdentity: `sha256:${'f'.repeat(64)}`,
        migrationId: 'mysql_contract_001',
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
    principal: 'operator:mysql-target',
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
  const dir = await mkdtemp(join(tmpdir(), 'spool-mysql-target-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'rows.csv');
  await writeFile(sourcePath, 'id,name\n1,Ada\n2,Lin\n3,Grace\n');
  const service = await SpoolCommandService.create({
    sourceRoot, targetRoot, snapshotDir: join(dir, 'snapshots'),
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-mysql-test', commitSha: '4123456789abcdef0123456789abcdef01234567' }
  });
  return { dir, sourcePath, service };
}

test('filesystem-to-MySQL migration completes with ledger evidence', { skip: !enabled }, async t => {
  await waitForServer();
  const table = 'mysql_tgt_e2e';
  await reset(table);
  const { dir, sourcePath, service } = await serviceFixture();
  t.after(async () => { try { service.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  try {
    const request = migrationRequest(sourcePath, table, 'mysql_e2e_001');
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'mysql-e2e' });
    assert.ok(approval.record.effects.includes('mysql:insert_rows'));
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.deepEqual(result.receipt.record.counts, { sourceRows: 3, writtenRows: 3, rejectedRows: 0, filteredRows: 0 });
    const check = await adminConnection();
    try {
      const [rows] = await check.query(`SELECT id, name FROM \`${table}\` ORDER BY id`);
      assert.deepEqual(rows.map(row => ({ id: Number(row.id), name: row.name })), [
        { id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }, { id: 3, name: 'Grace' }
      ]);
    } finally { await check.end(); }
  } finally {
    service.close();
  }
});

test('MySQL target refuses content-exact verification and bulk writes', { skip: !enabled }, async t => {
  await waitForServer();
  const table = 'mysql_tgt_capability';
  await reset(table);
  const { dir, sourcePath, service } = await serviceFixture();
  t.after(async () => { try { service.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  try {
    const exact = migrationRequest(sourcePath, table, 'mysql_capability_exact',
      ['row_accounting', 'ledger_complete', 'content_exact']);
    exact.planInput.capabilityAssumptions.target.readAfterWriteVerification = true;
    await assert.rejects(() => service.inspect(exact), error => error?.code === 'CONTENT_VERIFICATION_CAPABILITY_REQUIRED');

    const bulk = migrationRequest(sourcePath, table, 'mysql_capability_bulk');
    bulk.planInput.writeStrategy = { mode: 'insert', batchSize: 2, bulk: true };
    await assert.rejects(() => service.inspect(bulk), error => error?.code === 'BULK_WRITE_CAPABILITY_REQUIRED');
  } finally {
    service.close();
  }
});
