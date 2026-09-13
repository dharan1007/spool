import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { createPostgresSourceRuntime } from '../../src/connectors/postgres/source.js';
import {
  discoverPostgresCatalog,
  withExportedPostgresSnapshot
} from '../../src/connectors/postgres/database-source.js';
import { createPostgresDatabaseSourceState, assertSourceStateBinding } from '../../src/protocol/state-descriptors.js';

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

function tableRef(table) {
  return {
    connector: 'postgres', connectionId: 'pg-db-source', resource: `public.${table}`,
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
    await client.query('DROP VIEW IF EXISTS public.dbcat_recent_orders');
    await client.query('DROP TABLE IF EXISTS public.dbcat_orders CASCADE');
    await client.query('DROP TABLE IF EXISTS public.dbcat_customers CASCADE');
    await client.query('DROP TABLE IF EXISTS public.dbcat_events CASCADE');
    await client.query(`CREATE TABLE public.dbcat_orders (id integer PRIMARY KEY, name text NOT NULL, amount numeric NOT NULL)`);
    await client.query(`CREATE TABLE public.dbcat_customers (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public.dbcat_events (id integer NOT NULL, name text NOT NULL)`);
    await client.query(`CREATE VIEW public.dbcat_recent_orders AS SELECT id, name FROM public.dbcat_orders`);
    await client.query('CREATE SCHEMA spool_internal');
    await client.query('CREATE TABLE spool_internal.junk (id integer PRIMARY KEY)');
    for (let id = 1; id <= 5; id += 1) {
      await client.query(`INSERT INTO public.dbcat_orders(id,name,amount) VALUES ($1,$2,$3)`, [id, `order-${id}`, id * 10]);
      await client.query(`INSERT INTO public.dbcat_customers(id,name) VALUES ($1,$2)`, [id, `customer-${id}`]);
      await client.query(`INSERT INTO public.dbcat_events(id,name) VALUES ($1,$2)`, [id, `event-${id}`]);
    }
  } finally { await client.end(); }
}

async function streamAll(runtime, table, snapshotToken) {
  return runtime.withSnapshot(tableRef(table), async snapshot => {
    const rows = [];
    for await (const batch of snapshot.batches()) rows.push(...batch.rows);
    return { state: snapshot.sourceState, rows };
  }, { snapshotToken });
}

test('catalog discovery enumerates migratable tables deterministically and excludes views and SPOOL metadata', { skip: !enabled }, async () => {
  await reset();
  const first = await discoverPostgresCatalog({ ref: dbRef(), credentialBroker: broker });
  const second = await discoverPostgresCatalog({ ref: dbRef(), credentialBroker: broker });
  assert.equal(first.catalogId, second.catalogId);
  assert.match(first.catalogId, /^sha256:[a-f0-9]{64}$/);

  const names = first.tables.map(table => `${table.schema}.${table.table}`);
  assert.ok(names.includes('public.dbcat_orders'));
  assert.ok(names.includes('public.dbcat_customers'));
  assert.ok(names.includes('public.dbcat_events'));
  assert.ok(!names.includes('public.dbcat_recent_orders'), 'views are not migratable sources');
  assert.ok(!names.some(name => name.startsWith('spool_internal.')), 'SPOOL metadata is not user catalog');
  assert.ok(!names.some(name => name.startsWith('pg_catalog.') || name.startsWith('information_schema.')));

  const orders = first.tables.find(table => table.table === 'dbcat_orders');
  assert.deepEqual(orders.primaryKey, ['id']);
  assert.equal(orders.streamable, true);
  assert.deepEqual(orders.columns.map(column => [column.name, column.type]), [['id', 'integer'], ['name', 'text'], ['amount', 'numeric']]);
  const events = first.tables.find(table => table.table === 'dbcat_events');
  assert.deepEqual(events.primaryKey, []);
  assert.equal(events.streamable, false);

  const scoped = await discoverPostgresCatalog({ ref: dbRef(), credentialBroker: broker, schemas: ['public'] });
  assert.equal(scoped.catalogId, first.catalogId);
});

test('one exported database snapshot pins the same consistent view across tables and sessions', { skip: !enabled }, async () => {
  await reset();
  const runtime = createPostgresSourceRuntime({ credentialBroker: broker });
  await withExportedPostgresSnapshot({ ref: dbRef(), credentialBroker: broker }, async exported => {
    assert.match(exported.exportedSnapshotId, /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-\d+$/);
    assert.match(exported.walLsn, /^[0-9A-F]+\/[0-9A-F]+$/);
    const token = exported.exportedSnapshotId;

    const baselineOrders = await streamAll(runtime, 'dbcat_orders', token);
    const baselineCustomers = await streamAll(runtime, 'dbcat_customers', token);
    assert.equal(baselineOrders.rows.length, 5);
    assert.equal(baselineCustomers.rows.length, 5);
    for (const observed of [baselineOrders, baselineCustomers]) {
      assert.equal(observed.state.state.snapshot.exportedSnapshotId, token);
      assert.equal(observed.state.state.snapshot.xmin, exported.xmin);
      assert.equal(observed.state.state.snapshot.xmax, exported.xmax);
    }

    const writer = await adminClient();
    try {
      await writer.query(`UPDATE public.dbcat_orders SET name='changed-after-export' WHERE id=1`);
      await writer.query(`INSERT INTO public.dbcat_orders(id,name,amount) VALUES (999,'late-order',1)`);
      await writer.query(`INSERT INTO public.dbcat_customers(id,name) VALUES (999,'late-customer')`);
    } finally { await writer.end(); }

    const pinnedOrders = await streamAll(runtime, 'dbcat_orders', token);
    const pinnedCustomers = await streamAll(runtime, 'dbcat_customers', token);
    assert.deepEqual(pinnedOrders.rows, baselineOrders.rows);
    assert.deepEqual(pinnedCustomers.rows, baselineCustomers.rows);
    assert.equal(pinnedOrders.state.state.snapshot.exportedSnapshotId, token);

    const fresh = await adminClient();
    try {
      const orders = await fresh.query('SELECT COUNT(*)::int AS n FROM public.dbcat_orders');
      const customers = await fresh.query('SELECT COUNT(*)::int AS n FROM public.dbcat_customers');
      assert.equal(Number(orders.rows[0].n), 6);
      assert.equal(Number(customers.rows[0].n), 6);
    } finally { await fresh.end(); }
  });
});

test('catalog drift changes the database source identity', { skip: !enabled }, async () => {
  await reset();
  const before = await discoverPostgresCatalog({ ref: dbRef(), credentialBroker: broker });
  const client = await adminClient();
  try {
    await client.query('CREATE TABLE public.dbcat_drift_probe (id integer PRIMARY KEY, name text NOT NULL)');
    const after = await discoverPostgresCatalog({ ref: dbRef(), credentialBroker: broker });
    assert.notEqual(before.catalogId, after.catalogId);
    assert.equal(after.tableCount, before.tableCount + 1);

    const stateFor = catalog => createPostgresDatabaseSourceState({
      systemIdentifier: '7429931746381247331',
      databaseOid: 16384,
      databaseName: database,
      serverVersionNum: 170004,
      catalogId: catalog.catalogId,
      tableCount: catalog.tableCount,
      snapshot: { exportedSnapshotId: '00000003-0000001A-1', xmin: '912', xmax: '940', xip: [] },
      walLsn: '0/16B6C50'
    });
    assert.throws(() => assertSourceStateBinding(stateFor(before), stateFor(after)), error => error?.code === 'SOURCE_DRIFT');
  } finally {
    try { await client.query('DROP TABLE public.dbcat_drift_probe'); } catch {}
    await client.end();
  }
});
