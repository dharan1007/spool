import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { ensurePostgresMetadata } from '../../src/connectors/postgres/target.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

function targetRef() {
  return {
    connector: 'postgres',
    connectionId: 'pg-metadata-race',
    resource: 'public.metadata_probe',
    endpoint,
    database,
    schema: 'public',
    table: 'metadata_probe',
    identity: { user },
    secretRef
  };
}

async function adminClient() {
  const url = new URL(endpoint);
  const client = new Client({ host: url.hostname, port: Number(url.port || 5432), database, user, password, ssl: false });
  await client.connect();
  return client;
}

test('concurrent SPOOL processes serialize PostgreSQL metadata bootstrap', { skip: !enabled }, async () => {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query('DROP TABLE IF EXISTS public.metadata_probe CASCADE');
    await client.query('CREATE TABLE public.metadata_probe (id integer PRIMARY KEY)');
  } finally {
    await client.end();
  }

  const attempts = 16;
  const results = await Promise.allSettled(
    Array.from({ length: attempts }, () => ensurePostgresMetadata({ targetRef: targetRef(), credentialBroker: broker }))
  );
  const failures = results.filter(result => result.status === 'rejected');
  assert.deepEqual(failures, [], `all ${attempts} concurrent metadata bootstraps must succeed`);

  const verify = await adminClient();
  try {
    const result = await verify.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'spool_internal'
        AND table_name IN ('batch_ledger','execution_leases')
      ORDER BY table_name
    `);
    assert.deepEqual(result.rows.map(row => row.table_name), ['batch_ledger', 'execution_leases']);
  } finally {
    await verify.end();
  }
});
