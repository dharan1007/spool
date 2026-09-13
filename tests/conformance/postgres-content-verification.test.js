import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { createPostgresTargetRuntime, POSTGRES_TARGET_DESCRIPTOR } from '../../src/connectors/postgres/runtime.js';
import { inspectPostgresTarget } from '../../src/connectors/postgres/preflight.js';
import { createRepairPlan } from '../../src/execution/repair-plan.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;

function ref(table) {
  return {
    connector: 'postgres', connectionId: 'pg-content-verify', resource: `public.${table}`,
    endpoint, database, schema: 'public', table, identity: { user }, secretRef
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

const expectedRows = [
  { id: 1, name: 'Ada', amount: 12.5, active: true, day: '2026-09-13', local_at: '2026-09-13T10:20:30.1200' },
  { id: 2, name: 'Lin', amount: 20, active: false, day: '2026-09-14', local_at: '2026-09-14T11:00:00' }
];

test('PostgreSQL truthfully advertises read-after-write verification without overclaiming connector-level C5', { skip: !enabled }, async () => {
  const table = 'spool_pg_content_preflight';
  await reset(table);
  await inspectPostgresTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  assert.equal(POSTGRES_TARGET_DESCRIPTOR.assurance.level, 'C4');
  assert.equal(POSTGRES_TARGET_DESCRIPTOR.capabilities.readAfterWriteVerification, true);
});

test('PostgreSQL verifies exact committed values for only the expected migration keys and discovers the real PK', { skip: !enabled }, async () => {
  const table = 'spool_pg_content_exact';
  await reset(table);
  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectPostgresTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'pg_content_exact_001', targetRef: ref(table) });
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    await target.commitBatch({
      batchIdentity: `sha256:${'c'.repeat(64)}`,
      migrationId: 'pg_content_exact_001',
      planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      mappingRevision: 1,
      rows: expectedRows,
      fencingToken: lease.fencingToken,
      targetContractId: preflight.targetContractId
    });

    const client = await adminClient();
    try {
      await client.query(`INSERT INTO public."${table}"(id,name,amount,active,day,local_at) VALUES (999,'unrelated',1,true,'2026-01-01','2026-01-01 00:00:00')`);
    } finally { await client.end(); }

    const verified = await execution.verifyContent({
      expectedRows,
      targetSchema: schema(),
      targetContractId: preflight.targetContractId
    });
    assert.equal(verified.status, 'VERIFIED');
    assert.deepEqual(verified.primaryKey, ['id']);
    assert.equal(verified.expected.rowCount, 2);
    assert.equal(verified.actual.rowCount, 2);
    assert.equal(verified.diff.total, 0);
  } finally {
    await execution.close();
  }
});

test('PostgreSQL verification detects changed and missing committed rows and yields hash-bound repair operations', { skip: !enabled }, async () => {
  const table = 'spool_pg_content_diff';
  await reset(table);
  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectPostgresTarget({ targetRef: ref(table), targetSchema: schema(), credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'pg_content_diff_001', targetRef: ref(table) });
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    await target.commitBatch({
      batchIdentity: `sha256:${'d'.repeat(64)}`,
      migrationId: 'pg_content_diff_001', planId: PLAN_ID, sourceSnapshotId: SNAPSHOT_ID,
      mappingRevision: 1, rows: expectedRows, fencingToken: lease.fencingToken,
      targetContractId: preflight.targetContractId
    });

    const client = await adminClient();
    try {
      await client.query(`UPDATE public."${table}" SET name='tampered' WHERE id=1`);
      await client.query(`DELETE FROM public."${table}" WHERE id=2`);
    } finally { await client.end(); }

    const verification = await execution.verifyContent({
      expectedRows,
      targetSchema: schema(),
      targetContractId: preflight.targetContractId
    });
    assert.equal(verification.status, 'DIFF');
    assert.deepEqual(verification.primaryKey, ['id']);
    assert.deepEqual(verification.diff.counts, { missing: 1, mismatch: 1, unexpected: 0 });

    const repair = createRepairPlan({
      migrationId: 'pg_content_diff_001',
      planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      targetIdentity: ref(table),
      targetContractId: preflight.targetContractId,
      verification
    });
    assert.deepEqual(repair.operations.map(operation => operation.effect), ['UPDATE', 'INSERT']);
    assert.match(repair.operations[0].precondition.actualRowHash, /^sha256:/);
    assert.equal(repair.operations[1].precondition.absent, true);
  } finally {
    await execution.close();
  }
});
