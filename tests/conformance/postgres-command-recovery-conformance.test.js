import { markDisposableQualification } from '../../src/platform/disposable-qualification.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { SpoolCommandService } from '../../src/daemon/command-service.js';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { loadMaterializedSnapshot, streamMaterializedRows } from '../../src/connectors/materialized-snapshot.js';
import { createPostgresTargetRuntime } from '../../src/connectors/postgres/runtime.js';
import { MigrationEngine } from '../../src/core/migration.js';
import { createMigrationPlan } from '../../src/platform/plan.js';
import { MigrationRunner } from '../../src/execution/migration-runner.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };

async function adminClient() {
  const url = new URL(endpoint);
  const client = new Client({ host: url.hostname, port: Number(url.port || 5432), database, user, password, ssl: false });
  await client.connect();
  return client;
}

function pgRef(table, connectionId) {
  return {
    connector: 'postgres',
    connectionId,
    resource: `public.${table}`,
    endpoint,
    database,
    schema: 'public',
    table,
    identity: { user },
    secretRef
  };
}

async function reset(sourceTable, targetTable, count = 5) {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${sourceTable}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${targetTable}" CASCADE`);
    await client.query(`CREATE TABLE public."${sourceTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${targetTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= count; id += 1) {
      await client.query(`INSERT INTO public."${sourceTable}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
    }
  } finally {
    await client.end();
  }
}

async function tableRows(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`SELECT id,name FROM public."${table}" ORDER BY id`);
    return result.rows.map(row => ({ id: Number(row.id), name: row.name }));
  } finally {
    await client.end();
  }
}

function request(sourceTable, targetTable, migrationId, batchSize = 2) {
  return {
    migrationId,
    principal: 'operator:postgres-recovery-ci',
    planInput: {
      planRevision: 1,
      sourceRef: pgRef(sourceTable, 'pg-source'),
      targetRef: pgRef(targetTable, 'pg-target'),
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false }
      ],
      mapping: [
        { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
        { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
      ],
      mappingRevision: 1,
      writeStrategy: { mode: 'insert', batchSize },
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true, durableMaterialization: true },
        target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true }
      }
    }
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-pg-recovery-'));
  const sourceRoot = join(dir, 'source-root');
  const targetRoot = join(dir, 'target-root');
  const snapshotDir = join(dir, 'snapshots');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const options = {
    qualification: await markDisposableQualification(dir),
    sourceRoot,
    targetRoot,
    snapshotDir,
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-test', commitSha: '2123456789abcdef0123456789abcdef01234567' }
  };
  return { dir, snapshotDir, options, service: await SpoolCommandService.create(options) };
}

async function firstApprovedBatch({ service, snapshotDir, migration, approval }) {
  const runtime = createPostgresTargetRuntime({ credentialBroker: new CredentialBroker(), leaseTtlMs: 60_000 });
  const normalized = await runtime.normalizePlanInput(migration.planInput);
  const plan = await createMigrationPlan(normalized);
  assert.equal(plan.planId, approval.record.planId);
  const materialized = await loadMaterializedSnapshot({
    snapshotDir: join(snapshotDir, encodeURIComponent(migration.migrationId)),
    snapshotId: approval.record.sourceSnapshotId
  });
  const accumulator = new MigrationEngine().createAccumulator(plan.mapping, plan.mappingRevision, plan.targetSchema);
  const rows = [];
  for await (const { rowIndex, row } of streamMaterializedRows(materialized)) {
    if (rowIndex >= plan.writeStrategy.batchSize) break;
    const transformed = accumulator.process(row, rowIndex);
    if (transformed.ok) rows.push(transformed.row);
  }
  return { runtime, plan, rows };
}

test('PostgreSQL durable source resumes a commit-before-checkpoint crash without duplicates after service restart', { skip: !enabled }, async () => {
  const sourceTable = 'spool_pg_source_recovery';
  const targetTable = 'spool_pg_target_recovery';
  await reset(sourceTable, targetTable, 5);
  const f = await fixture();
  let service = f.service;
  let execution = null;
  try {
    const migration = request(sourceTable, targetTable, 'pg_source_recovery_001', 2);
    const inspected = await service.inspect(migration);
    const approval = await service.approve(migration, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-source-recovery' });
    const prepared = await firstApprovedBatch({ service, snapshotDir: f.snapshotDir, migration, approval });
    execution = prepared.runtime.createExecution({ migrationId: migration.migrationId, targetRef: prepared.plan.targetRef });
    const lease = await execution.renewLease();
    const runner = new MigrationRunner({ target: execution.openTarget(), checkpointStore: service.runs.checkpointStore(migration.migrationId) });

    await assert.rejects(
      () => runner.runBatchAsync({
        migrationId: migration.migrationId,
        planId: prepared.plan.planId,
        sourceSnapshotId: approval.record.sourceSnapshotId,
        mappingRevision: prepared.plan.mappingRevision,
        sourceRange: { start: 0, endExclusive: 2 },
        targetIdentity: prepared.plan.targetRef,
        targetContractId: inspected.targetContractId,
        rows: prepared.rows,
        fencingToken: lease.fencingToken
      }, { faultAfterTargetCommit: true }),
      error => error?.code === 'FAULT_AFTER_TARGET_COMMIT'
    );
    assert.equal(await service.runs.checkpointStore(migration.migrationId).load(), null);
    assert.deepEqual(await tableRows(targetTable), [
      { id: 1, name: 'source-1' },
      { id: 2, name: 'source-2' }
    ]);

    await execution.close();
    execution = null;
    service.close();

    const sourceMutation = await adminClient();
    try {
      await sourceMutation.query(`TRUNCATE public."${sourceTable}"`);
      await sourceMutation.query(`INSERT INTO public."${sourceTable}"(id,name) VALUES (999,'replacement-source')`);
    } finally {
      await sourceMutation.end();
    }

    service = await SpoolCommandService.create(f.options);
    const completed = await service.run(migration, { approval });
    assert.equal(completed.status, 'COMPLETE');
    assert.equal(completed.verification.status, 'VERIFIED');
    assert.equal(completed.receipt.record.sourceSnapshotId, approval.record.sourceSnapshotId);
    assert.deepEqual(completed.receipt.record.counts, { sourceRows: 5, writtenRows: 5, rejectedRows: 0, filteredRows: 0 });
    assert.deepEqual(await tableRows(targetTable), [
      { id: 1, name: 'source-1' },
      { id: 2, name: 'source-2' },
      { id: 3, name: 'source-3' },
      { id: 4, name: 'source-4' },
      { id: 5, name: 'source-5' }
    ]);
  } finally {
    if (execution) await execution.close();
    service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('corrupt approved PostgreSQL snapshot fails before any target mutation', { skip: !enabled }, async () => {
  const sourceTable = 'spool_pg_source_corrupt';
  const targetTable = 'spool_pg_target_corrupt';
  await reset(sourceTable, targetTable, 3);
  const f = await fixture();
  try {
    const migration = request(sourceTable, targetTable, 'pg_source_corrupt_001', 2);
    const approval = await f.service.approve(migration, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-source-corrupt' });
    const materialized = await loadMaterializedSnapshot({
      snapshotDir: join(f.snapshotDir, encodeURIComponent(migration.migrationId)),
      snapshotId: approval.record.sourceSnapshotId
    });
    const chunk = materialized.snapshot.chunks[0];
    await writeFile(join(materialized.snapshotPath, 'chunks', chunk.file), '{"id":999,"name":"tampered"}\n', 'utf8');

    await assert.rejects(
      () => f.service.run(migration, { approval }),
      error => error?.code === 'SOURCE_SNAPSHOT_CORRUPT'
    );
    assert.deepEqual(await tableRows(targetTable), []);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
