import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { CredentialBroker } from '../src/daemon/credential-broker.js';
import {
  PostgresTarget,
  acquirePostgresLease,
  releasePostgresLease,
  invalidatePostgresMetadataCache
} from '../src/connectors/postgres/target.js';
import { inspectPostgresTarget } from '../src/connectors/postgres/preflight.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

function ref(table) {
  return {
    connector: 'postgres',
    connectionId: 'industrial-lease-redteam',
    endpoint,
    database,
    schema: 'public',
    table,
    identity: { user },
    secretRef
  };
}

async function admin() {
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

const H = c => 'sha256:' + c.repeat(64);

test('expired dead-owner lease is taken over naturally and stale owner is fenced without admin DELETE', { skip: !enabled, timeout: 120_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const table = `rt_lease_${suffix}`;
  const targetRef = ref(table);
  const resource = `postgres:${endpoint}:${database}:public.${table}:redteam`;
  const ownerA = `redteam-owner-a-${suffix}`;
  const ownerB = `redteam-owner-b-${suffix}`;

  const setup = await admin();
  t.after(async () => {
    try { await setup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } catch {}
    try {
      await setup.query(
        'DELETE FROM spool_internal.execution_leases WHERE resource = $1',
        [resource]
      );
    } catch {}
    await setup.end();
    invalidatePostgresMetadataCache(targetRef);
  });

  await setup.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`);
  const preflight = await inspectPostgresTarget({
    targetRef,
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'payload', type: 'string', nullable: false }
    ],
    credentialBroker: broker
  });

  const first = await acquirePostgresLease({
    targetRef,
    credentialBroker: broker,
    resource,
    owner: ownerA,
    ttlMs: 250
  });
  assert.equal(first.fencingToken, 1);

  // Simulate a dead process: intentionally DO NOT call releasePostgresLease.
  await new Promise(resolve => setTimeout(resolve, 650));

  const second = await acquirePostgresLease({
    targetRef,
    credentialBroker: broker,
    resource,
    owner: ownerB,
    ttlMs: 30_000
  });
  assert.ok(second.fencingToken > first.fencingToken, 'takeover must advance the fencing token');

  const staleTarget = new PostgresTarget({
    targetRef,
    credentialBroker: broker,
    requireFencing: true,
    fenceResource: resource,
    fenceOwner: ownerA
  });

  await assert.rejects(
    staleTarget.commitBatch({
      migrationId: 'industrial-lease-redteam',
      planId: H('1'),
      sourceSnapshotId: H('2'),
      mappingRevision: 1,
      targetContractId: preflight.targetContractId,
      batchIdentity: H('3'),
      fencingToken: first.fencingToken,
      rows: [{ id: 1, payload: 'stale-owner-must-never-write' }]
    }),
    error => error?.code === 'STALE_FENCE' || error?.code === 'LEASE_EXPIRED'
  );

  const count = await setup.query(`SELECT count(*)::int AS n FROM public."${table}"`);
  assert.equal(count.rows[0].n, 0, 'stale owner wrote data after lease takeover');

  await releasePostgresLease({
    targetRef,
    credentialBroker: broker,
    resource,
    owner: ownerB,
    fencingToken: second.fencingToken
  });
});
