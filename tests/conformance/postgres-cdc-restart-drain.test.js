import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { parsePostgresEndpoint } from '../../src/connectors/postgres/connection.js';
import { dropPostgresReplicationSlot } from '../../src/connectors/postgres/cdc.js';
import { SpoolCommandService } from '../../src/daemon/command-service.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
broker.withSecret = async (ref, fn) => fn(password);

const SOURCE_TABLE = 'spool_cdc_restart_src';
const TARGET_TABLE = 'spool_cdc_restart_dst';
const SLOT = 'spool_cdc_restart_slot';
const PUBLICATION = 'spool_cdc_restart_pub';
const MIGRATION_ID = 'spool_cdc_restart_001';

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

function pgRef(table, connectionId) {
  return {
    connector: 'postgres', connectionId, resource: `public.${table}`, endpoint, database,
    schema: 'public', table, identity: { user }, secretRef
  };
}

async function adminClient() {
  const parsed = parsePostgresEndpoint(endpoint);
  const client = new Client({ host: parsed.host, port: parsed.port, database, user, password, ssl: false });
  await client.connect();
  return client;
}

async function reset() {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${SOURCE_TABLE}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${TARGET_TABLE}" CASCADE`);
    await client.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: SLOT }).catch(() => {});
    await client.query(`CREATE TABLE public."${SOURCE_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${TARGET_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= 5; id += 1) {
      await client.query(`INSERT INTO public."${SOURCE_TABLE}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
    }
  } finally { await client.end(); }
}

async function cleanup() {
  const client = await adminClient();
  try {
    await client.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await client.query(`DROP TABLE IF EXISTS public."${SOURCE_TABLE}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${TARGET_TABLE}" CASCADE`);
    await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: SLOT }).catch(() => {});
  } finally { await client.end(); }
}

async function tableRows(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`SELECT id FROM public."${table}" ORDER BY id`);
    return result.rows.map(row => Number(row.id));
  } finally { await client.end(); }
}

async function flushLsn() {
  const client = await adminClient();
  try {
    const result = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    return String(result.rows[0].lsn).toUpperCase();
  } finally { await client.end(); }
}

async function writeRows(ids) {
  const client = await adminClient();
  try {
    for (const id of ids) {
      await client.query(`INSERT INTO public."${SOURCE_TABLE}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
    }
  } finally { await client.end(); }
}

function migrationRequest() {
  return {
    migrationId: MIGRATION_ID,
    principal: 'operator:postgres-cdc-restart',
    planInput: {
      planRevision: 1,
      sourceRef: pgRef(SOURCE_TABLE, 'pg-cdc-restart-source'),
      targetRef: pgRef(TARGET_TABLE, 'pg-cdc-restart-target'),
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

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-restart-'));
  await mkdir(join(dir, 'source-root'));
  await mkdir(join(dir, 'target-root'));
  const service = await SpoolCommandService.create({
    sourceRoot: join(dir, 'source-root'),
    targetRoot: join(dir, 'target-root'),
    snapshotDir: join(dir, 'snapshots'),
    statePath: join(dir, 'target-root', 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-test', commitSha: '2123456789abcdef0123456789abcdef01234567' }
  });
  return { dir, service };
}

test('drain restart: a retry at or behind the durable watermark returns immediately without re-applying or hanging', { skip: !enabled, timeout: 300_000 }, async () => {
  await reset();
  const f = await fixture();
  const service = f.service;
  try {
    const request = migrationRequest();
    await service.inspect(request);
    const record = await service.establishCdcBoundary(request, { slotName: SLOT, publicationName: PUBLICATION });
    assert.ok(record.consistentPoint);
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-cdc-restart' });
    await writeRows([6, 7, 8]);
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');

    const waterline = await flushLsn();
    const drained = await service.catchUpCdc(request, { untilLsn: waterline });
    assert.ok(drained.appliedTransactions >= 3);
    assert.deepEqual(await tableRows(TARGET_TABLE), await tableRows(SOURCE_TABLE));

    const binding = service.snapshotCdcBinding(request.migrationId);
    assert.ok(binding.appliedLsn, 'the drain must record a durable applied watermark');
    assert.notEqual(binding.appliedLsn, record.consistentPoint);

    // Restart at the watermark: the durable resume position already reaches
    // the requested waterline, so the drain must return immediately from the
    // checkpoint — no subscribe wait, no re-apply, and above all no hang
    // waiting for a transaction that can never arrive.
    const startedAt = Date.now();
    const retried = await service.catchUpCdc(request, { untilLsn: binding.appliedLsn });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(retried.appliedTransactions, 0, 'a watermark restart must never re-apply');
    assert.ok(elapsedMs < 10_000, `watermark restart must return promptly, took ${elapsedMs}ms`);
    const unchanged = service.snapshotCdcBinding(request.migrationId);
    assert.equal(unchanged.appliedLsn, binding.appliedLsn, 'a no-op restart must not move the watermark');
    assert.deepEqual(await tableRows(TARGET_TABLE), await tableRows(SOURCE_TABLE));
  } finally {
    service.close();
    await cleanup();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('drain restart: a partially-applied bounded drain resumes from the durable checkpoint and applies exactly the remainder', { skip: !enabled, timeout: 300_000 }, async () => {
  await reset();
  const f = await fixture();
  const service = f.service;
  try {
    const request = migrationRequest();
    await service.inspect(request);
    await service.establishCdcBoundary(request, { slotName: SLOT, publicationName: PUBLICATION });
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-cdc-restart-2' });
    await writeRows([6, 7, 8]);
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');

    // First drain applies the whole backlog to the waterline.
    const waterline1 = await flushLsn();
    const first = await service.catchUpCdc(request, { untilLsn: waterline1 });
    assert.ok(first.appliedTransactions >= 3);
    const afterFirst = service.snapshotCdcBinding(request.migrationId);
    assert.ok(afterFirst.appliedLsn);

    // New source work arrives, then a bounded drain stops after exactly one
    // transaction: partial progress, durable checkpoint, clean return.
    await writeRows([9, 10, 11]);
    const partial = await service.catchUpCdc(request, { maxTransactions: 1, drainStallTimeoutMs: 60_000 });
    assert.equal(partial.appliedTransactions, 1, 'the bounded drain must stop after exactly one transaction');
    const afterPartial = service.snapshotCdcBinding(request.migrationId);
    assert.notEqual(afterPartial.appliedLsn, afterFirst.appliedLsn, 'partial progress must persist the watermark');

    // Restart: resume from the durable checkpoint and finish the remainder
    // exactly once — target converges, no duplicates, no lost rows.
    const waterline2 = await flushLsn();
    const resumed = await service.catchUpCdc(request, { untilLsn: waterline2, drainStallTimeoutMs: 60_000 });
    assert.equal(resumed.appliedTransactions, 2, 'the resumed drain must apply exactly the remainder');
    assert.deepEqual(await tableRows(TARGET_TABLE), await tableRows(SOURCE_TABLE));
    assert.deepEqual(await tableRows(TARGET_TABLE), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const afterResume = service.snapshotCdcBinding(request.migrationId);
    assert.notEqual(afterResume.appliedLsn, afterPartial.appliedLsn);
  } finally {
    service.close();
    await cleanup();
    await rm(f.dir, { recursive: true, force: true });
  }
});
