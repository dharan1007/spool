import { markDisposableQualification } from '../../src/platform/disposable-qualification.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { performance } from 'node:perf_hooks';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { createPostgresTargetRuntime } from '../../src/connectors/postgres/runtime.js';
import { inspectPostgresTarget } from '../../src/connectors/postgres/preflight.js';
import { postgresPayloadEvidence, acquirePostgresLease, releasePostgresLease, PostgresTarget } from '../../src/connectors/postgres/target.js';
import { SpoolCommandService } from '../../src/daemon/command-service.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;
const ROWS = 5000;

function ref(table) {
  return {
    connector: 'postgres', connectionId: 'pg-bulk', resource: `public.${table}`,
    endpoint, database, schema: 'public', table, identity: { user }, secretRef
  };
}

function schema() {
  return [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false },
    { name: 'note', type: 'string', nullable: true }
  ];
}

async function adminClient() {
  const url = new URL(endpoint);
  const client = new Client({ host: url.hostname, port: Number(url.port || 5432), database, user, password, ssl: false });
  await client.connect();
  return client;
}

async function reset(table) {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL, note text NULL, payload text NULL)`);
  } finally { await client.end(); }
}

function bulkRows(count) {
  const tricky = ['plain', 'with,comma', 'with"quote', 'with\nnewline', 'back\\slash', 'ünïcodé✓', '', '   padded   '];
  const rows = [];
  for (let id = 1; id <= count; id += 1) {
    rows.push({
      id,
      name: `${tricky[id % tricky.length]}-${id}`,
      note: id % 7 === 0 ? null : `note-${id}`,
      payload: id % 11 === 0 ? null : `\\x${id.toString(16).padStart(4, '0')}beef`
    });
  }
  return rows;
}

function batchInput(table, rows, fencingToken, targetContractId) {
  return {
    batchIdentity: `sha256:${'c'.repeat(64)}`,
    migrationId: 'pg_bulk_001',
    planId: PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    mappingRevision: 1,
    rows,
    fencingToken,
    targetContractId
  };
}

test('PostgreSQL bulk COPY commits exact evidence with identical identity to the row path', { skip: !enabled, timeout: 300_000 }, async () => {
  const table = 'spool_pg_bulk_exact';
  await reset(table);
  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectPostgresTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'pg_bulk_001', targetRef: ref(table) });
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    const rows = bulkRows(ROWS);
    const started = performance.now();
    const committed = await target.commitBulkBatch(batchInput(table, rows, lease.fencingToken, preflight.targetContractId));
    const elapsedMs = performance.now() - started;
    assert.equal(committed.status, 'COMMITTED_EXACT');
    assert.equal(committed.alreadyCommitted, false);
    assert.equal(committed.rowCount, ROWS);
    console.log(`bulk COPY: ${ROWS} rows in ${elapsedMs.toFixed(0)} ms (${Math.round(ROWS / (elapsedMs / 1000))} rows/s)`);

    const again = await target.commitBulkBatch(batchInput(table, rows, lease.fencingToken, preflight.targetContractId));
    assert.equal(again.alreadyCommitted, true);
    assert.equal(again.batchIdentity, committed.batchIdentity);

    const described = postgresPayloadEvidence(rows);
    assert.equal(described.payloadHash, committed.payloadHash);
    const reconciled = await target.reconcileTargetCommit({
      batchIdentity: committed.batchIdentity,
      migrationId: 'pg_bulk_001',
      planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      mappingRevision: 1,
      payloadHash: described.payloadHash,
      rowCount: ROWS
    });
    assert.equal(reconciled.status, 'COMMITTED_EXACT');

    const client = await adminClient();
    try {
      const result = await client.query(`SELECT id, name, note, payload FROM public."${table}" ORDER BY id`);
      assert.equal(result.rows.length, ROWS);
      for (let index = 0; index < ROWS; index += 1) {
        const expected = rows[index];
        const actual = result.rows[index];
        assert.equal(Number(actual.id), expected.id);
        assert.equal(actual.name, expected.name);
        assert.equal(actual.note, expected.note);
        assert.equal(actual.payload ?? null, expected.payload ?? null);
      }
    } finally { await client.end(); }

    const probeResource = 'pg-bulk-fault-probe';
    const probeLease = await acquirePostgresLease({ targetRef: ref(table), credentialBroker: broker, resource: probeResource, owner: 'bulk-fault-a', ttlMs: 60_000 });
    const probeTarget = new PostgresTarget({ targetRef: ref(table), credentialBroker: broker, requireFencing: true, fenceResource: probeResource, fenceOwner: 'bulk-fault-a' });
    try {
      await releasePostgresLease({ targetRef: ref(table), credentialBroker: broker, resource: probeResource, owner: 'bulk-fault-a', fencingToken: probeLease.fencingToken });
      const takenOver = await acquirePostgresLease({ targetRef: ref(table), credentialBroker: broker, resource: probeResource, owner: 'bulk-fault-b', ttlMs: 60_000 });
      assert.ok(takenOver.fencingToken !== probeLease.fencingToken);
      await assert.rejects(
        () => probeTarget.commitBulkBatch(batchInput(table, rows.slice(0, 1), probeLease.fencingToken, preflight.targetContractId)),
        error => error?.code === 'STALE_FENCE'
      );
      const probeTargetB = new PostgresTarget({ targetRef: ref(table), credentialBroker: broker, requireFencing: true, fenceResource: probeResource, fenceOwner: 'bulk-fault-b' });
      try {
        await assert.rejects(
          () => probeTargetB.commitBulkBatch({
            ...batchInput(table, rows.slice(0, 1), takenOver.fencingToken, preflight.targetContractId),
            batchIdentity: `sha256:${'d'.repeat(64)}`,
            targetContractId: `sha256:${'e'.repeat(64)}`
          }),
          error => error?.code === 'TARGET_CONTRACT_CHANGED'
        );
      } finally {
        probeTargetB.close();
      }
    } finally {
      probeTarget.close();
    }
  } finally {
    await execution.close();
  }
});

function migrationRequest(sourceTable, targetTable, migrationId) {
  return {
    migrationId,
    principal: 'operator:postgres-bulk',
    planInput: {
      planRevision: 1,
      sourceRef: {
        connector: 'postgres', connectionId: 'pg-bulk-source', resource: `public.${sourceTable}`,
        endpoint, database, schema: 'public', table: sourceTable, identity: { user }, secretRef
      },
      targetRef: {
        connector: 'postgres', connectionId: 'pg-bulk-target', resource: `public.${targetTable}`,
        endpoint, database, schema: 'public', table: targetTable, identity: { user }, secretRef
      },
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false }
      ],
      mapping: [
        { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
        { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
      ],
      mappingRevision: 1,
      writeStrategy: { mode: 'insert', batchSize: 4, bulk: true },
      verification: { checks: ['row_accounting', 'ledger_complete', 'content_exact'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true, durableMaterialization: true },
        target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true, readAfterWriteVerification: true }
      }
    }
  };
}

test('bulk service migration completes with exact content proof and bulk approval effects', { skip: !enabled, timeout: 300_000 }, async t => {
  const sourceTable = 'spool_pg_bulk_source';
  const targetTable = 'spool_pg_bulk_target';
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${sourceTable}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${targetTable}" CASCADE`);
    await client.query(`CREATE TABLE public."${sourceTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${targetTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= 10; id += 1) await client.query(`INSERT INTO public."${sourceTable}"(id,name) VALUES ($1,$2)`, [id, `bulk-${id}`]);
  } finally { await client.end(); }

  const dir = await mkdtemp(join(tmpdir(), 'spool-pg-bulk-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const service = await SpoolCommandService.create({
    qualification: await markDisposableQualification(dir),
    sourceRoot, targetRoot, snapshotDir: join(dir, 'snapshots'),
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-bulk-test', commitSha: '3123456789abcdef0123456789abcdef01234567' }
  });
  t.after(async () => { try { service.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  try {
    const request = migrationRequest(sourceTable, targetTable, 'pg_bulk_service_001');
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-bulk-service' });
    assert.ok(approval.record.effects.includes('postgres:bulk_copy_write'));
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.verification.content.status, 'VERIFIED');
    assert.equal(result.verification.content.rowCount, 10);
    assert.equal(result.receipt.record.counts.writtenRows, 10);
  } finally {
    service.close();
  }
});
