import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import {
  POSTGRES_SOURCE_DESCRIPTOR,
  createPostgresSourceRuntime,
  withPostgresSourceSnapshot
} from '../../src/connectors/postgres/source.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

function sourceRef(table) {
  return {
    connector: 'postgres',
    connectionId: 'pg-source-test',
    resource: `public.${table}`,
    endpoint,
    database,
    schema: 'public',
    table,
    identity: { user },
    secretRef
  };
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

async function reset(table, rows = 5) {
  const client = await adminClient();
  try {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    await client.query(`DROP TABLE IF EXISTS public.${quoted} CASCADE`);
    await client.query(`CREATE TABLE public.${quoted} (tenant_id integer NOT NULL, id integer NOT NULL, name text NOT NULL, PRIMARY KEY (tenant_id, id))`);
    for (let i = 1; i <= rows; i += 1) {
      await client.query(`INSERT INTO public.${quoted}(tenant_id,id,name) VALUES ($1,$2,$3)`, [i % 2, i, `row-${i}`]);
    }
  } finally {
    await client.end();
  }
}

test('PostgreSQL source connector truthfully advertises C1 snapshot semantics', () => {
  assert.equal(POSTGRES_SOURCE_DESCRIPTOR.role, 'source');
  assert.equal(POSTGRES_SOURCE_DESCRIPTOR.assurance.level, 'C1');
  assert.equal(POSTGRES_SOURCE_DESCRIPTOR.capabilities.snapshotBinding, true);
  assert.equal(POSTGRES_SOURCE_DESCRIPTOR.capabilities.readOnlySnapshot, true);
  assert.equal(POSTGRES_SOURCE_DESCRIPTOR.capabilities.streaming, true);
  assert.equal(POSTGRES_SOURCE_DESCRIPTOR.capabilities.continuousChangeCapture, false);
});

test('PostgreSQL source holds one MVCC snapshot while streaming deterministic keyset batches', { skip: !enabled }, async () => {
  const table = 'spool_pg_source_snapshot';
  await reset(table, 5);
  const runtime = createPostgresSourceRuntime({ credentialBroker: broker, batchSize: 2 });

  const result = await runtime.withSnapshot(sourceRef(table), async snapshot => {
    assert.match(snapshot.sourceState.sourceStateId, /^sha256:[a-f0-9]{64}$/);
    assert.match(snapshot.sourceState.state.contractId, /^sha256:[a-f0-9]{64}$/);
    assert.match(snapshot.sourceState.state.walLsn, /^[0-9A-F]+\/[0-9A-F]+$/);
    assert.deepEqual(snapshot.contract.primaryKey, ['tenant_id', 'id']);
    assert.equal(await snapshot.assertReadOnly(), true);
    assert.equal(Object.hasOwn(snapshot, 'client'), false, 'raw PostgreSQL client must not escape the source runtime');

    const iterator = snapshot.batches();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(first.value.rows.length, 2);
    assert.deepEqual(first.value.sourceRange, { start: 0, endExclusive: 2 });

    const concurrent = await adminClient();
    try {
      await concurrent.query(`INSERT INTO public."${table}"(tenant_id,id,name) VALUES (0,999,'late-row')`);
    } finally {
      await concurrent.end();
    }

    const batches = [first.value];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      batches.push(next.value);
    }
    return { state: snapshot.sourceState, batches };
  });

  const streamed = result.batches.flatMap(batch => batch.rows);
  assert.equal(streamed.length, 5, 'late concurrent row must not enter the held MVCC snapshot');
  assert.deepEqual(streamed.map(row => [row.tenant_id, row.id]), [[0,2],[0,4],[1,1],[1,3],[1,5]]);
  assert.ok(result.batches.every(batch => batch.sourceStateId === result.state.sourceStateId));
});

test('PostgreSQL source callback failure closes the held snapshot without changing source data', { skip: !enabled }, async () => {
  const table = 'spool_pg_source_failure';
  await reset(table, 1);
  let escapedSnapshot;
  await assert.rejects(
    () => withPostgresSourceSnapshot({ sourceRef: sourceRef(table), credentialBroker: broker, batchSize: 1 }, async snapshot => {
      escapedSnapshot = snapshot;
      assert.equal(await snapshot.assertReadOnly(), true);
      throw new Error('intentional-callback-failure');
    }),
    /intentional-callback-failure/
  );
  await assert.rejects(async () => {
    for await (const _batch of escapedSnapshot.batches()) break;
  }, error => error?.code === 'POSTGRES_SOURCE_SNAPSHOT_CLOSED');

  const client = await adminClient();
  try {
    const result = await client.query(`SELECT count(*)::int AS count FROM public."${table}"`);
    assert.equal(result.rows[0].count, 1);
  } finally {
    await client.end();
  }
});

test('PostgreSQL C1 source refuses relations without a primary key instead of inventing unstable ordering', { skip: !enabled }, async () => {
  const table = 'spool_pg_source_no_pk';
  const client = await adminClient();
  try {
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`CREATE TABLE public."${table}" (id integer, name text)`);
    await client.query(`INSERT INTO public."${table}" VALUES (1,'a'),(2,'b')`);
  } finally {
    await client.end();
  }

  await assert.rejects(
    () => withPostgresSourceSnapshot({ sourceRef: sourceRef(table), credentialBroker: broker }, async () => {}),
    error => error?.code === 'POSTGRES_SOURCE_ORDER_REQUIRED'
  );
});
