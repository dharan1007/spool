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

async function reset(sourceTable, targetTable) {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${sourceTable}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${targetTable}" CASCADE`);
    await client.query(`CREATE TABLE public."${sourceTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${targetTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= 5; id += 1) await client.query(`INSERT INTO public."${sourceTable}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
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
    principal: 'operator:postgres-source-ci',
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
  const dir = await mkdtemp(join(tmpdir(), 'spool-pg-to-pg-'));
  const sourceRoot = join(dir, 'source-root');
  const targetRoot = join(dir, 'target-root');
  const snapshotDir = join(dir, 'snapshots');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const options = {
    qualification: await markDisposableQualification(dir),
    sourceRoot, targetRoot, snapshotDir, statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-test', commitSha: '1123456789abcdef0123456789abcdef01234567' }
  };
  return { dir, options, service: await SpoolCommandService.create(options) };
}

test('PostgreSQL-to-PostgreSQL receipt requires exact target-content proof from the approved durable source', { skip: !enabled }, async () => {
  const sourceTable = 'spool_pg_source_e2e';
  const targetTable = 'spool_pg_target_e2e';
  await reset(sourceTable, targetTable);
  const f = await fixture();
  let service = f.service;
  try {
    const request = migrationRequest(sourceTable, targetTable, 'pg_to_pg_e2e_001');
    const inspected = await service.inspect(request);
    assert.equal(inspected.sourceRows, 5);
    assert.match(inspected.sourceSnapshotId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(inspected.targetPreflight.status, 'READY');

    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-to-pg-e2e' });
    assert.ok(approval.record.effects.includes('postgres:read_after_write_verify'));
    const approvedSnapshotId = approval.record.sourceSnapshotId;

    const client = await adminClient();
    try {
      await client.query(`UPDATE public."${sourceTable}" SET name='changed-after-approval' WHERE id=1`);
      await client.query(`INSERT INTO public."${sourceTable}"(id,name) VALUES (999,'late-row')`);
    } finally { await client.end(); }

    service.close();
    service = await SpoolCommandService.create(f.options);
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.verification.status, 'VERIFIED');
    assert.equal(result.verification.content.status, 'VERIFIED');
    assert.equal(result.verification.content.level, 'CONTENT_EXACT');
    assert.equal(result.verification.content.rowCount, 5);
    assert.equal(result.verification.content.sourceRowsCovered, 5);
    assert.equal(result.verification.content.batchCount, 3);
    assert.deepEqual(result.verification.content.primaryKey, ['id']);
    assert.match(result.verification.content.rootHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(result.verification.content.targetReadState.mvccSnapshot, /.+/);
    assert.match(result.verification.content.targetReadState.walLsn, /.+/);
    assert.equal(result.receipt.record.verification.content.rootHash, result.verification.content.rootHash);
    assert.equal(result.receipt.record.sourceSnapshotId, approvedSnapshotId);
    assert.deepEqual(result.receipt.record.counts, { sourceRows: 5, writtenRows: 5, rejectedRows: 0, filteredRows: 0 });
    assert.equal(service.status(request.migrationId).status, 'COMPLETE');
    assert.equal(service.repairEvidence(request.migrationId).length, 0);
    assert.deepEqual(await tableRows(targetTable), [
      { id: 1, name: 'source-1' }, { id: 2, name: 'source-2' }, { id: 3, name: 'source-3' },
      { id: 4, name: 'source-4' }, { id: 5, name: 'source-5' }
    ]);
  } finally {
    service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
