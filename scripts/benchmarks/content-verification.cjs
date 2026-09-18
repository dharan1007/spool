'use strict';
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ENDPOINT = process.env.SPOOL_TEST_POSTGRES_ENDPOINT || '';
const DATABASE = process.env.SPOOL_TEST_POSTGRES_DATABASE || 'spooltest';
const USER = process.env.SPOOL_TEST_POSTGRES_USER || 'spooltest';
const PASSWORD = process.env.SPOOL_TEST_PG_PASSWORD || '';
const ROWS = Number(process.env.SPOOL_CONTENT_VERIFY_ROWS || 1000000);
const BATCH = Number(process.env.SPOOL_CONTENT_VERIFY_BATCH || 25000);

function resolveCommit() {
  return process.env.SPOOL_COMMIT_SHA || '0000000000000000000000000000000000000000';
}

function ref(table) {
  return {
    connector: 'postgres', connectionId: 'pg-content-verify', resource: `public.${table}`,
    endpoint: ENDPOINT, database: DATABASE, schema: 'public', table, identity: { user: USER },
    secretRef: { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' }
  };
}

function schema() {
  return [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false },
    { name: 'amount', type: 'number', nullable: false },
    { name: 'active', type: 'boolean', nullable: false },
    { name: 'day', type: 'date', nullable: false },
    { name: 'local_at', type: 'local_datetime', nullable: false }
  ];
}

async function adminClient() {
  const url = new URL(ENDPOINT);
  const client = new Client({ host: url.hostname, port: Number(url.port || 5432), database: DATABASE, user: USER, password: PASSWORD, ssl: false });
  await client.connect();
  return client;
}

async function reset(table) {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`CREATE TABLE public."${table}" (
      id integer PRIMARY KEY,
      name text NOT NULL,
      amount numeric NOT NULL,
      active boolean NOT NULL,
      day date NOT NULL,
      local_at timestamp without time zone NOT NULL
    )`);
  } finally {
    await client.end();
  }
}

function buildRows(count) {
  const rows = new Array(count);
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    rows[i] = {
      id,
      name: `name-${id}`,
      amount: id,
      active: id % 2 === 0,
      day: '2026-01-01',
      local_at: '2026-01-01T00:00:00'
    };
  }
  return rows;
}

async function main() {
  if (!ENDPOINT || !PASSWORD) {
    console.error('Fatal benchmark error: SPOOL_TEST_POSTGRES_ENDPOINT and SPOOL_TEST_PG_PASSWORD are required');
    process.exit(1);
  }
  const commit = resolveCommit();
  console.log(`release-benchmark: SHA=${commit} rows=${ROWS}`);

  const { CredentialBroker } = await import('../../src/daemon/credential-broker.js');
  const { createPostgresTargetRuntime, POSTGRES_TARGET_DESCRIPTOR } = await import('../../src/connectors/postgres/runtime.js');
  const { inspectPostgresTarget } = await import('../../src/connectors/postgres/preflight.js');
  const { createRepairPlan } = await import('../../src/execution/repair-plan.js');

  const broker = new CredentialBroker();
  const table = 'spool_pg_content_load';
  const planId = `sha256:${'a'.repeat(64)}`;
  const snapshotId = `sha256:${'b'.repeat(64)}`;
  const startedAt = new Date().toISOString();

  await reset(table);
  const expectedRows = buildRows(ROWS);
  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: 120000 });
  const preflight = await inspectPostgresTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'pg_content_load_001', targetRef: ref(table) });

  try {
    assert.equal(POSTGRES_TARGET_DESCRIPTOR.assurance.level, 'C4');
    assert.equal(POSTGRES_TARGET_DESCRIPTOR.capabilities.readAfterWriteVerification, true);

    const lease = await execution.renewLease();
    const target = execution.openTarget();

    const commitStart = Date.now();
    for (let offset = 0; offset < ROWS; offset += BATCH) {
      const rows = expectedRows.slice(offset, offset + BATCH);
      const identity = createHash('sha256').update(`load-batch-${offset}`).digest('hex');
      const result = await target.commitBatch({
        batchIdentity: `sha256:${identity}`,
        migrationId: 'pg_content_load_001',
        planId,
        sourceSnapshotId: snapshotId,
        mappingRevision: 1,
        rows,
        fencingToken: lease.fencingToken,
        targetContractId: preflight.targetContractId
      });
      assert.equal(result.status, 'COMMITTED_EXACT');
    }
    const commitMs = Date.now() - commitStart;

    console.log('Verifying exact content...');
    const verifyStart = Date.now();
    const verified = await execution.verifyContent({ expectedRows, targetSchema: schema(), targetContractId: preflight.targetContractId });
    const verifyMs = Date.now() - verifyStart;
    assert.equal(verified.status, 'VERIFIED');
    assert.equal(verified.diff.total, 0);
    assert.equal(verified.expected.rowCount, ROWS);
    assert.equal(verified.actual.rowCount, ROWS);
    console.log(`VERIFIED: expected=${verified.expected.rowCount} actual=${verified.actual.rowCount} diff=${verified.diff.total}`);

    const admin = await adminClient();
    let tamper;
    let missing;
    let repair;
    try {
      await admin.query(`UPDATE public."${table}" SET name='tampered' WHERE id=1`);
      tamper = await execution.verifyContent({ expectedRows: expectedRows.slice(0, 2), targetSchema: schema(), targetContractId: preflight.targetContractId });
      assert.equal(tamper.status, 'DIFF');
      assert.equal(tamper.diff.counts.mismatch, 1);
      console.log(`TAMPER DETECTED: mismatch=${tamper.diff.counts.mismatch}`);

      await admin.query(`DELETE FROM public."${table}" WHERE id=2`);
      missing = await execution.verifyContent({ expectedRows: expectedRows.slice(0, 2), targetSchema: schema(), targetContractId: preflight.targetContractId });
      assert.equal(missing.status, 'DIFF');
      assert.equal(missing.diff.counts.missing, 1);
      assert.equal(missing.diff.counts.mismatch, 1);
      console.log(`MISSING DETECTED: missing=${missing.diff.counts.missing} mismatch=${missing.diff.counts.mismatch}`);

      repair = createRepairPlan({
        migrationId: 'pg_content_load_001',
        planId,
        sourceSnapshotId: snapshotId,
        targetIdentity: ref(table),
        targetContractId: preflight.targetContractId,
        verification: missing
      });
      assert.deepEqual(repair.operations.map(operation => operation.effect).sort(), ['INSERT', 'UPDATE']);
      assert.equal(repair.operations.every(operation => /^sha256:/.test(operation.precondition.actualRowHash) || operation.precondition.absent === true), true);
      console.log(`REPAIR PLAN: effects=${repair.operations.map(operation => operation.effect).join(',')}`);
    } finally {
      await admin.end();
    }

    const summary = {
      commit,
      rows: ROWS,
      batchSize: BATCH,
      startedAt,
      finishedAt: new Date().toISOString(),
      commitMs,
      commitRowsPerSec: Math.round(ROWS / (commitMs / 1000)),
      verifyMs,
      verifyRowsPerSec: Math.round(ROWS / (verifyMs / 1000)),
      verified: { status: verified.status, expectedRowCount: verified.expected.rowCount, actualRowCount: verified.actual.rowCount, diffTotal: verified.diff.total },
      tamper: { status: tamper.status, counts: tamper.diff.counts },
      missing: { status: missing.status, counts: missing.diff.counts },
      repair: { effects: repair.operations.map(operation => operation.effect).sort() },
      assertions: { verifiedExact: true, tamperDetected: true, missingDetected: true, repairPlanHashBound: true }
    };

    const dir = path.join('qualification', 'postgres-content-verification');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(summary, null, 2));
    console.log('\nBenchmark results written to qualification/postgres-content-verification/results.json');
    console.log('\n=== CONTENT VERIFICATION COMPLETE ===');
  } catch (error) {
    console.error('Fatal benchmark error:', error);
    process.exit(1);
  } finally {
    try { await execution.close(); } catch {}
  }
}

main().catch(err => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});
