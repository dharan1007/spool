import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { describePostgresReplicaIdentity } from '../../src/connectors/postgres/cdc.js';

// Live regression for the replica-identity parsing defect: the previous
// implementation selected key columns with array_agg() in SQL, which
// PostgreSQL returns as the `_name` array type. node-postgres leaves that type
// unparsed, so the value arrived as a literal string ("{id}") and every
// REPLICA IDENTITY DEFAULT/INDEX table was refused with
// CDC_REPLICA_IDENTITY_UNUSABLE. These tests exercise the real catalog query
// against a real PostgreSQL server; they are skipped (NOT_EXECUTED, never
// PASS) when the live qualification environment is not configured.

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

async function adminClient() {
  const url = new URL(endpoint);
  const client = new Client({ host: url.hostname, port: Number(url.port || 5432), database, user, password, ssl: false });
  await client.connect();
  return client;
}

test('live PostgreSQL proves the raw array_agg representation that broke the old parser', { skip: !enabled }, async () => {
  const client = await adminClient();
  const table = 'ri_wire_repr_src';
  try {
    await client.query(`DROP TABLE IF EXISTS public."${table}"`);
    await client.query(`CREATE TABLE public."${table}" (id bigint PRIMARY KEY, payload text)`);

    // The exact pre-fix query shape, kept as the failing fixture.
    const result = await client.query(
      `SELECT array_agg(a.attname ORDER BY ord.ordinality) AS "columns"
         FROM pg_catalog.pg_index i
         JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS ord(attnum, ordinality) ON TRUE
         JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ord.attnum
        WHERE i.indrelid = '"${table}"'::regclass AND i.indisprimary`,
      []
    );
    const value = result.rows[0].columns;
    assert.equal(typeof value, 'string', 'live PostgreSQL must deliver the aggregated name[] as a string');
    assert.equal(value, '{id}', 'the actual failing representation is the literal "{id}"');
    assert.equal(Array.isArray(value), false, 'this is exactly why the old Array.isArray() guard saw zero key columns');
  } finally {
    await client.query(`DROP TABLE IF EXISTS public."${table}"`).catch(() => {});
    await client.end();
  }
});

test('describePostgresReplicaIdentity returns exact key columns for DEFAULT-identity tables', { skip: !enabled }, async () => {
  const client = await adminClient();
  const single = 'ri_default_single';
  const composite = 'ri_default_composite';
  try {
    await client.query(`DROP TABLE IF EXISTS public."${single}"`);
    await client.query(`DROP TABLE IF EXISTS public."${composite}"`);
    await client.query(`CREATE TABLE public."${single}" (id bigint PRIMARY KEY, payload text)`);
    await client.query(`CREATE TABLE public."${composite}" (a int NOT NULL, b int NOT NULL, payload text, PRIMARY KEY (b, a))`);

    const singleIdentity = await describePostgresReplicaIdentity({
      ref: dbRef(), credentialBroker: broker, schema: 'public', table: single
    });
    assert.equal(singleIdentity.mode, 'DEFAULT');
    assert.deepEqual([...singleIdentity.columns], ['id'], 'a plain primary key must not be reported as unusable');

    const compositeIdentity = await describePostgresReplicaIdentity({
      ref: dbRef(), credentialBroker: broker, schema: 'public', table: composite
    });
    assert.equal(compositeIdentity.mode, 'DEFAULT');
    assert.deepEqual([...compositeIdentity.columns], ['b', 'a'], 'composite key order must follow the index ordinality');
  } finally {
    await client.query(`DROP TABLE IF EXISTS public."${single}"`).catch(() => {});
    await client.query(`DROP TABLE IF EXISTS public."${composite}"`).catch(() => {});
    await client.end();
  }
});

test('describePostgresReplicaIdentity reports explicit replica-identity index columns under INDEX mode', { skip: !enabled }, async () => {
  const client = await adminClient();
  const table = 'ri_index_mode_src';
  try {
    await client.query(`DROP TABLE IF EXISTS public."${table}"`);
    await client.query(`CREATE TABLE public."${table}" (id bigint PRIMARY KEY, tenant_id bigint NOT NULL, source_id bigint NOT NULL, payload text)`);
    await client.query(`CREATE UNIQUE INDEX "${table}_ri_idx" ON public."${table}" (tenant_id, source_id)`);
    await client.query(`ALTER TABLE public."${table}" REPLICA IDENTITY USING INDEX "${table}_ri_idx"`);

    const identity = await describePostgresReplicaIdentity({
      ref: dbRef(), credentialBroker: broker, schema: 'public', table: table
    });
    assert.equal(identity.mode, 'INDEX');
    assert.deepEqual([...identity.columns], ['tenant_id', 'source_id'], 'INDEX mode must report the selected replica-identity index keys');
  } finally {
    await client.query(`DROP TABLE IF EXISTS public."${table}"`).catch(() => {});
    await client.end();
  }
});

test('describePostgresReplicaIdentity reports FULL and NOTHING modes without key columns', { skip: !enabled }, async () => {
  const client = await adminClient();
  const full = 'ri_full_mode_src';
  const nothing = 'ri_nothing_mode_src';
  try {
    await client.query(`DROP TABLE IF EXISTS public."${full}"`);
    await client.query(`DROP TABLE IF EXISTS public."${nothing}"`);
    await client.query(`CREATE TABLE public."${full}" (id bigint PRIMARY KEY, payload text)`);
    await client.query(`ALTER TABLE public."${full}" REPLICA IDENTITY FULL`);
    await client.query(`CREATE TABLE public."${nothing}" (id bigint PRIMARY KEY, payload text)`);
    await client.query(`ALTER TABLE public."${nothing}" REPLICA IDENTITY NOTHING`);

    const fullIdentity = await describePostgresReplicaIdentity({
      ref: dbRef(), credentialBroker: broker, schema: 'public', table: full
    });
    assert.equal(fullIdentity.mode, 'FULL');
    assert.deepEqual([...fullIdentity.columns], []);

    const nothingIdentity = await describePostgresReplicaIdentity({
      ref: dbRef(), credentialBroker: broker, schema: 'public', table: nothing
    });
    assert.equal(nothingIdentity.mode, 'NOTHING');
    assert.deepEqual([...nothingIdentity.columns], []);
  } finally {
    await client.query(`DROP TABLE IF EXISTS public."${full}"`).catch(() => {});
    await client.query(`DROP TABLE IF EXISTS public."${nothing}"`).catch(() => {});
    await client.end();
  }
});
