import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import {
  comparePostgresLsn,
  createCdcCheckpointStore,
  createPostgresReplicationSlot,
  dropPostgresReplicationSlot,
  ensurePostgresPublication,
  streamPostgresChanges
} from '../../src/connectors/postgres/cdc.js';

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

async function flushLsn() {
  const client = await adminClient();
  try {
    const result = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    return result.rows[0].lsn;
  } finally { await client.end(); }
}

test('replication slot lifecycle is idempotent and safe to clean up', { skip: !enabled }, async () => {
  const slotName = 'cdc_slot_lifecycle';
  await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  const created = await createPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(created.slotName, slotName);
  assert.equal(created.existed, false);
  const again = await createPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(again.existed, true);
  const dropped = await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(dropped.dropped, true);
  const missing = await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(missing.dropped, false);
});

test('logical capture streams ordered row changes with LSNs and resumes from checkpoints', { skip: !enabled, timeout: 300_000 }, async t => {
  const table = 'cdc_items';
  const fullTable = 'cdc_full_items';
  const publicationName = 'cdc_pub_items';
  const slotName = 'cdc_slot_items';
  const client = await adminClient();
  try {
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${fullTable}" CASCADE`);
    await client.query(`DROP PUBLICATION IF EXISTS ${publicationName}`);
    await client.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${fullTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`ALTER TABLE public."${fullTable}" REPLICA IDENTITY FULL`);
    await client.query(`INSERT INTO public."${table}"(id,name) VALUES (1,'seed-before-slot')`);
    await client.query(`INSERT INTO public."${fullTable}"(id,name) VALUES (1,'full-seed')`);
  } finally { await client.end(); }
  const publication = await ensurePostgresPublication({
    ref: dbRef(), credentialBroker: broker, publicationName, tables: [{ schema: 'public', table }, { schema: 'public', table: fullTable }]
  });
  assert.equal(publication.created, true);
  const same = await ensurePostgresPublication({
    ref: dbRef(), credentialBroker: broker, publicationName, tables: [{ schema: 'public', table }]
  });
  assert.equal(same.created, false);
  await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  const slot = await createPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(slot.existed, false);
  const startLsn = slot.lsn ?? await flushLsn();

  const writer = await adminClient();
  try {
    await writer.query(`INSERT INTO public."${table}"(id,name) VALUES (2,'second'), (3,'third')`);
    await writer.query(`UPDATE public."${table}" SET name='second-renamed' WHERE id=2`);
    await writer.query(`DELETE FROM public."${table}" WHERE id=3`);
    await writer.query(`UPDATE public."${fullTable}" SET name='full-renamed' WHERE id=1`);
  } finally { await writer.end(); }
  const untilLsn = await flushLsn();

  const first = await streamPostgresChanges({
    ref: dbRef(), credentialBroker: broker, slotName, publicationNames: [publicationName],
    startLsn, untilLsn, maxMessages: 500
  });
  const data = first.changes.filter(change => ['insert', 'update', 'delete'].includes(change.tag) && change.table === table);
  assert.deepEqual(data.map(change => change.tag), ['insert', 'insert', 'update', 'delete']);
  assert.deepEqual(data[0].row, { id: 2, name: 'second' });
  assert.deepEqual(data[1].row, { id: 3, name: 'third' });
  assert.equal(data[2].key, null);
  assert.equal(data[2].old, null);
  assert.deepEqual(data[2].row, { id: 2, name: 'second-renamed' });
  assert.deepEqual(data[3].key, { id: 3 });
  assert.equal(data[3].old, null);
  const fullData = first.changes.filter(change => ['insert', 'update', 'delete'].includes(change.tag) && change.table === fullTable);
  assert.deepEqual(fullData.map(change => change.tag), ['update']);
  assert.deepEqual(fullData[0].old, { id: 1, name: 'full-seed' });
  assert.deepEqual(fullData[0].row, { id: 1, name: 'full-renamed' });
  for (const change of data) {
    assert.equal(change.schema, 'public');
    assert.equal(change.table, table);
    assert.match(change.lsn, /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/);
  }
  const lsns = first.changes.map(change => change.lsn);
  for (let index = 1; index < lsns.length; index += 1) {
    assert.ok(comparePostgresLsn(lsns[index - 1], lsns[index]) <= 0, 'change stream LSNs advance monotonically');
  }

  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-resume-'));
  const store = createCdcCheckpointStore({ path: join(dir, 'cdc.db') });
  t.after(() => { try { store.close(); } catch {} });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  store.saveCheckpoint(slotName, first.lastLsn);
  assert.equal(store.loadCheckpoint(slotName), first.lastLsn);

  const writer2 = await adminClient();
  try {
    await writer2.query(`INSERT INTO public."${table}"(id,name) VALUES (4,'fourth')`);
  } finally { await writer2.end(); }
  const resumeUntil = await flushLsn();
  const second = await streamPostgresChanges({
    ref: dbRef(), credentialBroker: broker, slotName, publicationNames: [publicationName],
    startLsn: store.loadCheckpoint(slotName), untilLsn: resumeUntil, maxMessages: 500
  });
  const resumed = second.changes.filter(change => ['insert', 'update', 'delete'].includes(change.tag));
  assert.deepEqual(resumed.map(change => change.tag), ['insert']);
  assert.deepEqual(resumed[0].row, { id: 4, name: 'fourth' });

  await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  const cleanup = await adminClient();
  try {
    await cleanup.query(`DROP PUBLICATION IF EXISTS ${publicationName}`);
    await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await cleanup.query(`DROP TABLE IF EXISTS public."${fullTable}" CASCADE`);
  } finally { await cleanup.end(); }
});
