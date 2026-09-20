import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { SpoolCommandService } from '../../src/daemon/command-service.js';
import { describePostgresSlot } from '../../src/connectors/postgres/cdc.js';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

const SOURCE_TABLE = 'spool_cdc_lifecycle_src';
const TARGET_TABLE = 'spool_cdc_lifecycle_dst';
const SLOT = 'spool_cdc_lifecycle_slot';
const PUBLICATION = 'spool_cdc_lifecycle_pub';

async function adminClient() {
  const url = new URL(endpoint);
  const client = new Client({ host: url.hostname, port: Number(url.port || 5432), database, user, password, ssl: false });
  await client.connect();
  return client;
}

function pgRef(table, connectionId) {
  return {
    connector: 'postgres', connectionId, resource: `public.${table}`, endpoint, database,
    schema: 'public', table, identity: { user }, secretRef
  };
}

function migrationRequest(migrationId) {
  return {
    migrationId,
    principal: 'operator:postgres-cdc-lifecycle',
    planInput: {
      planRevision: 1,
      sourceRef: pgRef(SOURCE_TABLE, 'pg-cdc-source'),
      targetRef: pgRef(TARGET_TABLE, 'pg-cdc-target'),
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
      verification: { checks: ['row_accounting', 'ledger_complete', 'content_exact'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true, durableMaterialization: true },
        target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true, readAfterWriteVerification: true }
      }
    }
  };
}

async function reset() {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${SOURCE_TABLE}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${TARGET_TABLE}" CASCADE`);
    await client.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await client.query(`SELECT pg_catalog.pg_drop_replication_slot('${SLOT}')`).catch(error => {
      if (error?.code !== '42704') throw error;
    });
    await client.query(`CREATE TABLE public."${SOURCE_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${TARGET_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= 5; id += 1) {
      await client.query(`INSERT INTO public."${SOURCE_TABLE}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
    }
  } finally { await client.end(); }
}

async function tableRows(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`SELECT id,name FROM public."${table}" ORDER BY id`);
    return result.rows.map(row => ({ id: Number(row.id), name: row.name }));
  } finally { await client.end(); }
}

async function flushLsn() {
  const client = await adminClient();
  try {
    const result = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    return String(result.rows[0].lsn).toUpperCase();
  } finally { await client.end(); }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-pg-cdc-lifecycle-'));
  const sourceRoot = join(dir, 'source-root');
  const targetRoot = join(dir, 'target-root');
  const snapshotDir = join(dir, 'snapshots');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const options = {
    sourceRoot, targetRoot, snapshotDir, statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-test', commitSha: '2123456789abcdef0123456789abcdef01234567' }
  };
  return { dir, options, service: await SpoolCommandService.create(options) };
}

test('CDC lifecycle: boundary before approval, catch-up converges, drain commits, release drops the slot', { skip: !enabled, timeout: 300_000 }, async () => {
  await reset();
  const f = await fixture();
  const service = f.service;
  try {
    const request = migrationRequest('pg_cdc_lifecycle_001');

    const inspected = await service.inspect(request);
    assert.equal(inspected.sourceRows, 5);

    // 1. Boundary BEFORE approval: slot reserves WAL, exported snapshot taken
    // after the reservation, full load re-materialized joining that snapshot.
    const record = await service.establishCdcBoundary(request, { slotName: SLOT, publicationName: PUBLICATION });
    assert.match(record.boundaryId, /^sha256:[a-f0-9]{64}$/);
    assert.match(record.snapshotId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(record.slotName, SLOT);
    assert.equal(record.publicationName, PUBLICATION);
    assert.match(record.consistentPoint, /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/);
    assert.ok(record.exportedSnapshotId);
    assert.equal(record.slotExisted, false);
    assert.equal(record.publicationCreated, true);
    assert.ok(record.sourceRef);
    const live = await describePostgresSlot({
      ref: { endpoint, database, identity: { user }, secretRef }, credentialBroker: broker, slotName: SLOT
    });
    assert.ok(live);
    assert.equal(live.slotName, SLOT);

    // 2. Approval consumes the boundary: the full-load snapshot is materialized
    // AFTER the slot reservation, and the binding carries the slot, the
    // publication, and the reservation point as the proven stream start.
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-cdc-lifecycle' });
    const binding = service.snapshotCdcBinding(request.migrationId);
    assert.equal(binding.cdcSlot, SLOT);
    assert.equal(binding.cdcPublication, PUBLICATION);
    assert.equal(binding.snapshotLsn, record.consistentPoint);
    assert.equal(binding.cdcStartLsn, record.consistentPoint);
    assert.equal(binding.sourceStateId, approval.record.sourceSnapshotId);

    // 3. Post-snapshot writes: covered by the stream, invisible to full load.
    const writer = await adminClient();
    try {
      await writer.query(`INSERT INTO public."${SOURCE_TABLE}"(id,name) VALUES (6,'source-6'),(7,'source-7')`);
      await writer.query(`UPDATE public."${SOURCE_TABLE}" SET name='source-1-renamed' WHERE id=1`);
      await writer.query(`DELETE FROM public."${SOURCE_TABLE}" WHERE id=2`);
    } finally { await writer.end(); }

    // 4. Full load reads exactly S (5 rows as-of the boundary snapshot).
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.verification.status, 'VERIFIED');
    assert.deepEqual(await tableRows(TARGET_TABLE), [
      { id: 1, name: 'source-1' },
      { id: 2, name: 'source-2' },
      { id: 3, name: 'source-3' },
      { id: 4, name: 'source-4' },
      { id: 5, name: 'source-5' }
    ]);

    // 5. Catch up through the waterline: target converges to live source.
    const waterline = await flushLsn();
    const summary = await service.catchUpCdc(request, { untilLsn: waterline });
    assert.ok(summary.appliedTransactions >= 3);
    assert.deepEqual(await tableRows(TARGET_TABLE), await tableRows(SOURCE_TABLE));
    const progressed = service.snapshotCdcBinding(request.migrationId);
    assert.ok(progressed.appliedLsn);
    assert.notEqual(progressed.appliedLsn, binding.cdcStartLsn);

    // 6. Snapshot repair after CDC advance is refused (no silent revert).
    await assert.rejects(
      () => service.approveRepair(request, { repairPlanIds: ['plan-1'], expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'cdc-repair-refused' }),
      error => error?.code === 'REPAIR_CDC_CONFLICT'
    );

    // 7. Cutover on the quiesced source: FINAL_DRAIN terminates on the idle
    // stream, fresh live-source proofs authorize commit and completion.
    const armed = await service.beginCutover(request, { receipt: result.receipt });
    assert.equal(armed.status, 'ARMED');
    const committed = await service.commitCutover(request);
    assert.equal(committed.status, 'COMMITTED');
    assert.equal(committed.commitEvidence.fenced, true);
    assert.deepEqual(await tableRows(TARGET_TABLE), await tableRows(SOURCE_TABLE));

    // 8. Release drops the migration-owned slot; the record is gone.
    const released = await service.releaseCdcBoundary(request);
    assert.equal(released.slotName, SLOT);
    assert.equal(released.dropped, true);
    assert.equal(service.runs.getCdcBoundary(request.migrationId), null);
    const gone = await describePostgresSlot({
      ref: { endpoint, database, identity: { user }, secretRef }, credentialBroker: broker, slotName: SLOT
    });
    assert.equal(gone, null);
  } finally {
    service.close();
    const client = await adminClient();
    try {
      await client.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
      await client.query(`DROP TABLE IF EXISTS public."${SOURCE_TABLE}" CASCADE`);
      await client.query(`DROP TABLE IF EXISTS public."${TARGET_TABLE}" CASCADE`);
    } finally { await client.end(); }
    await rm(f.dir, { recursive: true, force: true });
  }
});
