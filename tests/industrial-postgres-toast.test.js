import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { CredentialBroker } from '../src/daemon/credential-broker.js';
import {
  createPostgresReplicationSlot,
  dropPostgresReplicationSlot,
  ensurePostgresPublication,
  streamPostgresChanges
} from '../src/connectors/postgres/cdc.js';

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

async function flushLsn(client) {
  const result = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
  return result.rows[0].lsn;
}

test('UPDATE preserves unchanged toasted columns in the normalized CDC new-row image', { skip: !enabled, timeout: 120_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toLowerCase();
  const table = `rt_toast_${suffix}`;
  const publication = `rt_pub_${suffix}`;
  const slot = `rt_slot_${suffix}`;
  // Deliberately incompressible and large enough to force out-of-line TOAST storage.
  const payload = randomBytes(192 * 1024).toString('hex');

  const client = await admin();
  t.after(async () => {
    try { await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: slot }); } catch {}
    try { await client.query(`DROP PUBLICATION IF EXISTS "${publication}"`); } catch {}
    try { await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } catch {}
    await client.end();
  });

  await client.query(`
    CREATE TABLE public."${table}" (
      id integer PRIMARY KEY,
      name text NOT NULL,
      payload text NOT NULL
    )
  `);
  await client.query(`ALTER TABLE public."${table}" REPLICA IDENTITY FULL`);
  await client.query(
    `INSERT INTO public."${table}" (id, name, payload) VALUES (1, 'before', $1)`,
    [payload]
  );

  await ensurePostgresPublication({
    ref: dbRef(),
    credentialBroker: broker,
    publicationName: publication,
    tables: [{ schema: 'public', table }]
  });
  const created = await createPostgresReplicationSlot({
    ref: dbRef(),
    credentialBroker: broker,
    slotName: slot
  });
  const startLsn = created.lsn ?? await flushLsn(client);

  // Only change a tiny non-TOAST column. PostgreSQL logical replication may
  // encode the large unchanged field with the protocol's "unchanged TOAST"
  // marker rather than re-sending its bytes.
  await client.query(`UPDATE public."${table}" SET name = 'after' WHERE id = 1`);
  const untilLsn = await flushLsn(client);

  const captured = await streamPostgresChanges({
    ref: dbRef(),
    credentialBroker: broker,
    slotName: slot,
    publicationNames: [publication],
    startLsn,
    untilLsn,
    maxMessages: 100
  });

  const update = captured.changes.find(change => change.tag === 'update' && change.table === table);
  assert.ok(update, 'expected UPDATE event was not captured');
  assert.equal(update.row?.id, 1);
  assert.equal(update.row?.name, 'after');

  assert.equal(
    update.row?.payload,
    payload,
    'normalized UPDATE row lost or exposed PostgreSQL unchanged-TOAST semantics; applying this row as a full upsert can corrupt a large unchanged column'
  );
});
