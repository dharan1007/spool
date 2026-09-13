import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { inspectPostgresTarget } from '../../src/connectors/postgres/preflight.js';
import { PostgresTarget } from '../../src/connectors/postgres/target.js';
import {
  claimWorkerLease,
  describeWorkerLease,
  heartbeatWorkerLease,
  listWorkerLeases,
  releaseWorkerLease
} from '../../src/connectors/postgres/workers.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

function tableRef(table) {
  return {
    connector: 'postgres', connectionId: 'pg-workers', resource: `public.${table}`,
    endpoint, database, schema: 'public', table, identity: { user }, secretRef
  };
}

async function adminClient() {
  const url = new URL(endpoint);
  const client = new Client({ host: url.hostname, port: Number(url.port || 5432), database, user, password, ssl: false });
  await client.connect();
  return client;
}

async function reset() {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query('DROP TABLE IF EXISTS public.worker_table_a CASCADE');
    await client.query('DROP TABLE IF EXISTS public.worker_table_b CASCADE');
    await client.query('CREATE TABLE public.worker_table_a (id integer PRIMARY KEY, name text NOT NULL)');
    await client.query('CREATE TABLE public.worker_table_b (id integer PRIMARY KEY, name text NOT NULL)');
  } finally { await client.end(); }
}

function batchInput(table, rows, fencingToken, targetContractId, tag) {
  return {
    batchIdentity: `sha256:${tag.repeat(64)}`,
    migrationId: `pg_workers_${tag}`,
    planId: PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    mappingRevision: 1,
    rows,
    fencingToken,
    targetContractId
  };
}

test('worker claims, heartbeats, takeover and listing are fenced and visible', { skip: !enabled }, async () => {
  await reset();
  const base = { ref: dbRef(), credentialBroker: broker };
  assert.equal(await describeWorkerLease({ ...base, resource: 'spool-test:partition:alpha' }), null);

  const claimA = await claimWorkerLease({ ...base, resource: 'spool-test:partition:alpha', workerId: 'worker-a', ttlMs: 60_000 });
  assert.equal(claimA.status, 'ACQUIRED');
  assert.equal(claimA.fencingToken, 1);

  const held = await claimWorkerLease({ ...base, resource: 'spool-test:partition:alpha', workerId: 'worker-b', ttlMs: 60_000 });
  assert.equal(held.status, 'HELD');
  assert.equal(held.holder.owner, 'worker-a');
  assert.equal(held.holder.fencingToken, 1);

  const beat = await heartbeatWorkerLease({ ...base, resource: 'spool-test:partition:alpha', workerId: 'worker-a', ttlMs: 60_000 });
  assert.equal(beat.fencingToken, 1);

  await releaseWorkerLease({ ...base, resource: 'spool-test:partition:alpha', workerId: 'worker-a', fencingToken: 1 });
  const claimB = await claimWorkerLease({ ...base, resource: 'spool-test:partition:alpha', workerId: 'worker-b', ttlMs: 60_000 });
  assert.equal(claimB.status, 'ACQUIRED');
  assert.equal(claimB.fencingToken, 2);

  await assert.rejects(
    heartbeatWorkerLease({ ...base, resource: 'spool-test:partition:alpha', workerId: 'worker-a', ttlMs: 60_000 }),
    error => error?.code === 'WORKER_CLAIM_LOST'
  );

  const listed = await listWorkerLeases({ ...base, resourcePrefix: 'spool-test:partition:' });
  assert.deepEqual(listed.map(item => [item.resource, item.owner, item.fencingToken, item.active]), [
    ['spool-test:partition:alpha', 'worker-b', 2, true]
  ]);
});

test('disjoint workers write fenced batches without interference and stale workers are refused', { skip: !enabled }, async () => {
  await reset();
  const base = { ref: dbRef(), credentialBroker: broker };
  const preflightA = await inspectPostgresTarget({ targetRef: tableRef('worker_table_a'), targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }], credentialBroker: broker });
  const preflightB = await inspectPostgresTarget({ targetRef: tableRef('worker_table_b'), targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }], credentialBroker: broker });

  const claimA = await claimWorkerLease({ ...base, resource: 'spool-test:table:worker_table_a', workerId: 'worker-a', ttlMs: 60_000 });
  const claimB = await claimWorkerLease({ ...base, resource: 'spool-test:table:worker_table_b', workerId: 'worker-b', ttlMs: 60_000 });
  const targetA = new PostgresTarget({ targetRef: tableRef('worker_table_a'), credentialBroker: broker, requireFencing: true, fenceResource: 'spool-test:table:worker_table_a', fenceOwner: 'worker-a' });
  const targetB = new PostgresTarget({ targetRef: tableRef('worker_table_b'), credentialBroker: broker, requireFencing: true, fenceResource: 'spool-test:table:worker_table_b', fenceOwner: 'worker-b' });
  try {
    const writeA = await targetA.commitBatch(batchInput('worker_table_a', [{ id: 1, name: 'a1' }], claimA.fencingToken, preflightA.targetContractId, '1'));
    const writeB = await targetB.commitBatch(batchInput('worker_table_b', [{ id: 1, name: 'b1' }], claimB.fencingToken, preflightB.targetContractId, '2'));
    assert.equal(writeA.status, 'COMMITTED_EXACT');
    assert.equal(writeB.status, 'COMMITTED_EXACT');

    const evilTarget = new PostgresTarget({ targetRef: tableRef('worker_table_a'), credentialBroker: broker, requireFencing: true, fenceResource: 'spool-test:table:worker_table_a', fenceOwner: 'worker-evil' });
    try {
      await assert.rejects(
        () => evilTarget.commitBatch(batchInput('worker_table_a', [{ id: 2, name: 'intruder' }], claimA.fencingToken, preflightA.targetContractId, '3')),
        error => error?.code === 'STALE_FENCE'
      );
    } finally {
      evilTarget.close();
    }

    await releaseWorkerLease({ ...base, resource: 'spool-test:table:worker_table_a', workerId: 'worker-a', fencingToken: claimA.fencingToken });
    const takeover = await claimWorkerLease({ ...base, resource: 'spool-test:table:worker_table_a', workerId: 'worker-b', ttlMs: 60_000 });
    assert.equal(takeover.fencingToken, 2);
    await assert.rejects(
      () => targetA.commitBatch(batchInput('worker_table_a', [{ id: 3, name: 'stale' }], claimA.fencingToken, preflightA.targetContractId, '4')),
      error => error?.code === 'STALE_FENCE'
    );
    const targetA2 = new PostgresTarget({ targetRef: tableRef('worker_table_a'), credentialBroker: broker, requireFencing: true, fenceResource: 'spool-test:table:worker_table_a', fenceOwner: 'worker-b' });
    try {
      const resumed = await targetA2.commitBatch(batchInput('worker_table_a', [{ id: 3, name: 'resumed' }], takeover.fencingToken, preflightA.targetContractId, '5'));
      assert.equal(resumed.status, 'COMMITTED_EXACT');
    } finally {
      targetA2.close();
    }

    const client = await adminClient();
    try {
      const rowsA = await client.query('SELECT id FROM public.worker_table_a ORDER BY id');
      const rowsB = await client.query('SELECT id FROM public.worker_table_b ORDER BY id');
      assert.deepEqual(rowsA.rows.map(row => Number(row.id)), [1, 3]);
      assert.deepEqual(rowsB.rows.map(row => Number(row.id)), [1]);
    } finally { await client.end(); }
  } finally {
    targetA.close();
    targetB.close();
  }
});
