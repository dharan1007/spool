import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { SpoolCommandService } from '../../src/daemon/command-service.js';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { createPostgresTargetRuntime } from '../../src/connectors/postgres/runtime.js';
import { inspectPostgresTarget } from '../../src/connectors/postgres/preflight.js';
import { createMigrationPlan } from '../../src/platform/plan.js';
import { createBatchIdentity } from '../../src/execution/batch-identity.js';
import { MigrationRunner } from '../../src/execution/migration-runner.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

function targetRef(table) {
  return {
    connector: 'postgres',
    connectionId: 'pg-test',
    resource: `public.${table}`,
    endpoint,
    database,
    schema: 'public',
    table,
    identity: { user },
    secretRef
  };
}

function targetSchema() {
  return [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false }
  ];
}

async function adminClient() {
  const url = new URL(endpoint);
  const client = new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database,
    user,
    password,
    ssl: false
  });
  await client.connect();
  return client;
}

async function reset(table) {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${table.replaceAll('"', '""')}" CASCADE`);
    await client.query(`CREATE TABLE public."${table.replaceAll('"', '""')}" (id integer PRIMARY KEY, name text NOT NULL)`);
  } finally {
    await client.end();
  }
}

async function rows(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`SELECT id, name FROM public."${table.replaceAll('"', '""')}" ORDER BY id`);
    return result.rows.map(row => ({ id: Number(row.id), name: row.name }));
  } finally {
    await client.end();
  }
}

function request(sourcePath, table, migrationId) {
  return {
    migrationId,
    principal: 'operator:postgres-ci',
    planInput: {
      planRevision: 1,
      sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'customers.csv', path: sourcePath },
      targetRef: targetRef(table),
      targetSchema: targetSchema(),
      mapping: [
        { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
        { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
      ],
      mappingRevision: 1,
      writeStrategy: { mode: 'insert', batchSize: 2 },
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
    }
  };
}

test('CSV-to-PostgreSQL command service is approval-bound, verified, replay-safe, and secret-free', { skip: !enabled }, async () => {
  const table = 'spool_pg_e2e';
  await reset(table);
  const dir = await mkdtemp(join(tmpdir(), 'spool-pg-e2e-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'customers.csv');
  await writeFile(sourcePath, 'id,name\n1, Ada \n2,Lin\nbad,Rejected\n');
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.1-test', commitSha: '0123456789abcdef0123456789abcdef01234567' }
  });
  try {
    const migration = request(sourcePath, table, 'pg_e2e_001');
    const inspected = await service.inspect(migration);
    assert.equal(inspected.targetPreflight.status, 'READY');
    assert.match(inspected.targetContractId, /^sha256:/);
    await assert.rejects(() => service.run(migration), /APPROVAL_REQUIRED/);

    const approval = await service.approve(migration, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-e2e-approval' });
    const result = await service.run(migration, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.verification.status, 'VERIFIED');
    assert.deepEqual(await rows(table), [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }]);

    const serialized = JSON.stringify(result.receipt);
    assert.doesNotMatch(serialized, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(serialized, /SPOOL_TEST_PG_PASSWORD/);

    const replay = await service.run(migration, { approval });
    assert.equal(replay.replay, true);
    assert.equal(replay.receipt.receiptId, result.receipt.receiptId);
    assert.equal((await rows(table)).length, 2);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL commit-before-checkpoint crash reconciles exactly without duplicate rows', { skip: !enabled }, async () => {
  const table = 'spool_pg_recovery';
  await reset(table);
  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const input = {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'source.csv', path: '/tmp/source.csv' },
    targetRef: targetRef(table),
    targetSchema: targetSchema(),
    mapping: [
      { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
      { target: 'name', expr: { op: 'field', name: 'name' } }
    ],
    mappingRevision: 1,
    writeStrategy: { mode: 'insert', batchSize: 2 },
    verification: { checks: ['row_accounting', 'ledger_complete'] },
    risk: { level: 'medium', approvals: ['target_write'] },
    capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
  };
  const normalized = await runtime.normalizePlanInput(input);
  const plan = await createMigrationPlan(normalized);
  const preflight = await inspectPostgresTarget({ targetRef: plan.targetRef, targetSchema: plan.targetSchema, credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'pg_recovery_001', targetRef: plan.targetRef });
  let checkpoint = null;
  const checkpointStore = {
    load: async () => checkpoint,
    save: async value => { checkpoint = structuredClone(value); }
  };
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    const runner = new MigrationRunner({ target, checkpointStore });
    const sourceSnapshotId = `sha256:${'1'.repeat(64)}`;
    const sourceRange = { start: 0, endExclusive: 2 };
    const batchIdentity = createBatchIdentity({
      migrationId: 'pg_recovery_001', planId: plan.planId, sourceSnapshotId,
      mappingRevision: plan.mappingRevision, sourceRange, targetIdentity: plan.targetRef
    });
    const batch = {
      batchIdentity,
      migrationId: 'pg_recovery_001', planId: plan.planId, sourceSnapshotId,
      mappingRevision: plan.mappingRevision, sourceRange, targetIdentity: plan.targetRef,
      targetContractId: preflight.targetContractId,
      rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }], fencingToken: lease.fencingToken
    };

    await assert.rejects(() => runner.runBatchAsync(batch, { faultAfterTargetCommit: true }), /FAULT_AFTER_TARGET_COMMIT/);
    assert.equal(checkpoint, null);
    assert.deepEqual(await rows(table), [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }]);

    const recovered = await runner.runBatchAsync(batch);
    assert.equal(recovered.recovered, true);
    assert.equal(checkpoint.nextOffset, 2);
    assert.equal((await rows(table)).length, 2);
  } finally {
    await execution.close();
  }
});

test('PostgreSQL rejects stale fencing tokens and target-contract drift before mutation', { skip: !enabled }, async () => {
  const table = 'spool_pg_fence';
  await reset(table);
  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const ref = targetRef(table);
  const preflight = await inspectPostgresTarget({ targetRef: ref, targetSchema: targetSchema(), credentialBroker: broker });
  const first = runtime.createExecution({ migrationId: 'pg_fence_first', targetRef: ref });
  const firstLease = await first.renewLease();
  const staleTarget = first.openTarget();
  await first.close();

  const second = runtime.createExecution({ migrationId: 'pg_fence_second', targetRef: ref });
  try {
    const secondLease = await second.renewLease();
    assert.ok(secondLease.fencingToken > firstLease.fencingToken);
    await assert.rejects(() => staleTarget.commitBatch({
      batchIdentity: `sha256:${'2'.repeat(64)}`,
      migrationId: 'pg_fence_first', planId: `sha256:${'3'.repeat(64)}`,
      sourceSnapshotId: `sha256:${'4'.repeat(64)}`, mappingRevision: 1,
      rows: [{ id: 1, name: 'stale' }], fencingToken: firstLease.fencingToken,
      targetContractId: preflight.targetContractId
    }), error => error?.code === 'POSTGRES_TARGET_CLOSED' || error?.code === 'STALE_FENCE');

    const liveTarget = second.openTarget();
    const client = await adminClient();
    try { await client.query(`CREATE UNIQUE INDEX spool_pg_fence_name_uq ON public.${table}(name)`); }
    finally { await client.end(); }
    await assert.rejects(() => liveTarget.commitBatch({
      batchIdentity: `sha256:${'5'.repeat(64)}`,
      migrationId: 'pg_fence_second', planId: `sha256:${'6'.repeat(64)}`,
      sourceSnapshotId: `sha256:${'7'.repeat(64)}`, mappingRevision: 1,
      rows: [{ id: 2, name: 'changed' }], fencingToken: secondLease.fencingToken,
      targetContractId: preflight.targetContractId
    }), error => error?.code === 'TARGET_CONTRACT_CHANGED');
    assert.deepEqual(await rows(table), []);
  } finally {
    await second.close();
  }
});
