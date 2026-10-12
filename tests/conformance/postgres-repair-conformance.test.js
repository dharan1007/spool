import { markDisposableQualification } from '../../src/platform/disposable-qualification.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { SpoolCommandService } from '../../src/daemon/command-service.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
// A wide replay window (60 batches with the tampered rows in the last one)
// keeps the concurrent-tamper fault deterministic: verification cannot reach
// the tampered last batch before the tamper lands.
const ROWS = 120;
const BATCH = 2;

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

async function reset(sourceTable, targetTable, rows = ROWS) {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${sourceTable}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${targetTable}" CASCADE`);
    await client.query(`CREATE TABLE public."${sourceTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${targetTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= rows; id += 1) {
      await client.query(`INSERT INTO public."${sourceTable}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
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

function migrationRequest(sourceTable, targetTable, migrationId) {
  return {
    migrationId,
    principal: 'operator:postgres-repair',
    planInput: {
      planRevision: 1,
      sourceRef: pgRef(sourceTable, 'pg-repair-source'),
      targetRef: pgRef(targetTable, 'pg-repair-target'),
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false }
      ],
      mapping: [
        { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
        { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
      ],
      mappingRevision: 1,
      writeStrategy: { mode: 'insert', batchSize: BATCH },
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
  const dir = await mkdtemp(join(tmpdir(), 'spool-pg-repair-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const options = {
    qualification: await markDisposableQualification(dir),
    sourceRoot, targetRoot, snapshotDir: join(dir, 'snapshots'),
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-repair-test', commitSha: '2123456789abcdef0123456789abcdef01234567' }
  };
  return { dir, options, service: await SpoolCommandService.create(options) };
}

async function waitForTargetCount(table, count, timeoutMs = 60000) {
  const client = await adminClient();
  try {
    const started = Date.now();
    for (;;) {
      const result = await client.query(`SELECT COUNT(*)::int AS n FROM public."${table}"`);
      if (Number(result.rows[0].n) === count) return;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${count} target rows`);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  } finally { await client.end(); }
}

async function leaseResourceFor(table) {
  const client = await adminClient();
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await client.query(
        `SELECT resource FROM spool_internal.execution_leases WHERE resource LIKE $1 ORDER BY resource LIMIT 1`,
        [`%public.${table}`]
      );
      if (result.rows[0]?.resource) return result.rows[0].resource;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('timed out waiting for the repair test lease');
  } finally { await client.end(); }
}

async function driveToVerificationFailed(service, request, sourceTable, targetTable) {
  const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: `repair-${request.migrationId}` });
  const runPromise = service.run(request, { approval });
  await waitForTargetCount(targetTable, ROWS);
  const tamper = await adminClient();
  try {
    await tamper.query(`UPDATE public."${targetTable}" SET name='tampered' WHERE id=${ROWS - 1}`);
    await tamper.query(`DELETE FROM public."${targetTable}" WHERE id=${ROWS}`);
  } finally { await tamper.end(); }
  const locker = await adminClient();
  try {
    const resource = await leaseResourceFor(targetTable);
    await locker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [resource]);
    await locker.query('SELECT pg_advisory_unlock_all()');
  } finally { await locker.end(); }
  const error = await runPromise.then(() => null, failure => failure);
  assert.equal(error?.code, 'VERIFICATION_FAILED');
  assert.deepEqual(error?.details?.diffCounts, { missing: 1, mismatch: 1, unexpected: 0, total: 2 });
  const run = service.status(request.migrationId);
  assert.equal(run.status, 'VERIFICATION_FAILED');
  assert.equal(run.receipt, null);
  return approval;
}

function expectedRows() {
  return Array.from({ length: ROWS }, (_, index) => ({ id: index + 1, name: `source-${index + 1}` }));
}

test('verified repair converges a tampered target to the approved snapshot and mints a repair receipt', { skip: !enabled, timeout: 300_000 }, async t => {
  const sourceTable = 'spool_pg_repair_source';
  const targetTable = 'spool_pg_repair_target';
  await reset(sourceTable, targetTable);
  let { dir, options, service } = await fixture();
  t.after(async () => { try { service.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  try {
    const migrationId = 'pg_repair_loop_001';
    const request = migrationRequest(sourceTable, targetTable, migrationId);
    const migrationApproval = await driveToVerificationFailed(service, request, sourceTable, targetTable);

    const evidence = service.repairEvidence(migrationId);
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0].repair.operations.map(operation => operation.effect), ['UPDATE', 'INSERT']);
    const repairPlanIds = evidence.map(item => item.repair.repairPlanId);

    await assert.rejects(
      () => service.runRepair(request, { repairApproval: migrationApproval }),
      error => error?.code === 'INVALID_REPAIR_APPROVAL'
    );

    const repairApproval = await service.approveRepair(request, {
      repairPlanIds,
      expiresAt: '2099-01-01T00:00:00.000Z',
      nonce: 'repair-loop-001'
    });
    assert.ok(repairApproval.record.effects.includes('postgres:apply_repair'));
    assert.ok(repairApproval.record.effects.includes('postgres:read_after_write_verify'));

    const result = await service.runRepair(request, { repairApproval });
    assert.equal(result.status, 'REPAIR_COMPLETE');
    assert.equal(result.replay, false);
    assert.deepEqual(result.repair.opCounts, { insert: 1, update: 1, delete: 0, alreadyApplied: 0 });
    assert.ok(result.repair.operations.every(item => item.applied === true && item.resumed !== true));
    assert.equal(result.repair.verification.status, 'VERIFIED');
    assert.equal(result.repair.verification.rowCount, ROWS);
    assert.equal(result.receipt.record.repairApprovalId, repairApproval.approvalId);
    assert.deepEqual(result.receipt.record.repairPlanIds, repairPlanIds);
    assert.deepEqual(await tableRows(targetTable), expectedRows());

    const run = service.status(migrationId);
    assert.equal(run.status, 'REPAIR_COMPLETE');
    assert.equal(run.receipt, null);
    assert.equal(service.repairReceipt(migrationId).receiptId, result.receipt.receiptId);
    assert.throws(() => service.receipt(migrationId), error => error?.code === 'RECEIPT_NOT_AVAILABLE');

    const replayed = await service.runRepair(request, { repairApproval });
    assert.equal(replayed.replay, true);
    assert.equal(replayed.receipt.receiptId, result.receipt.receiptId);

    service.close();
    service = await SpoolCommandService.create(options);
    assert.equal(service.status(migrationId).status, 'REPAIR_COMPLETE');
    assert.equal(service.repairReceipt(migrationId).receiptId, result.receipt.receiptId);
    assert.deepEqual(await tableRows(targetTable), expectedRows());
  } finally {
    service.close();
  }
});

test('repair refuses unknown plans and requires a failed run', { skip: !enabled, timeout: 300_000 }, async t => {
  const sourceTable = 'spool_pg_repair_refusal_source';
  const targetTable = 'spool_pg_repair_refusal_target';
  await reset(sourceTable, targetTable);
  const { dir, service } = await fixture();
  t.after(async () => { try { service.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  try {
    const migrationId = 'pg_repair_refusal_001';
    const request = migrationRequest(sourceTable, targetTable, migrationId);
    await driveToVerificationFailed(service, request, sourceTable, targetTable);

    await assert.rejects(
      () => service.approveRepair(request, {
        repairPlanIds: ['sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        nonce: 'repair-unknown-plan'
      }),
      error => error?.code === 'REPAIR_PLAN_UNKNOWN'
    );
    assert.equal(service.status(migrationId).status, 'VERIFICATION_FAILED');
  } finally {
    service.close();
  }
});
