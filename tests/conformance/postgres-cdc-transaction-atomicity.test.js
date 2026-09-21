import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { parsePostgresEndpoint } from '../../src/connectors/postgres/connection.js';
import {
  PostgresTarget,
  acquirePostgresLease
} from '../../src/connectors/postgres/target.js';
import { postgresContentRowHash } from '../../src/connectors/postgres/row-codec.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;

function txIdentity(label) {
  return `sha256:${createHash('sha256').update(`spool-test-cdc-tx:${label}`).digest('hex')}`;
}

function payloadHash(label) {
  return `sha256:${createHash('sha256').update(`spool-test-cdc-payload:${label}`).digest('hex')}`;
}

function tableRef(table) {
  return {
    connector: 'postgres', connectionId: 'pg-cdc-tx', resource: `public.${table}`,
    endpoint, database, schema: 'public', table, identity: { user }, secretRef
  };
}

async function adminClient() {
  const parsed = parsePostgresEndpoint(endpoint);
  const client = new Client({ host: parsed.host, port: parsed.port, database, user, password, ssl: false });
  await client.connect();
  return client;
}

function leaseResource(table) {
  return `postgres:${parsePostgresEndpoint(endpoint).endpoint}:${database}:public.${table}`;
}

async function resetTable(table) {
  const setup = await adminClient();
  try {
    await setup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await setup.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
    // Fresh clusters have no SPOOL metadata yet (acquirePostgresLease
    // bootstraps it): absent-table cleanup is a no-op, never a failure.
    try {
      await setup.query('DELETE FROM spool_internal.batch_ledger WHERE target_table = $1', [table]);
    } catch (error) {
      if (error?.code !== '42P01') throw error;
    }
    try {
      await setup.query('DELETE FROM spool_internal.execution_leases WHERE resource = $1', [leaseResource(table)]);
    } catch (error) {
      if (error?.code !== '42P01') throw error;
    }
  } finally { await setup.end(); }
}

async function dropTable(table) {
  const cleanup = await adminClient();
  try { await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } finally { await cleanup.end(); }
}

async function tableRows(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`SELECT id, name FROM public."${table}" ORDER BY id`);
    return result.rows.map(row => ({ id: Number(row.id), name: row.name }));
  } finally { await client.end(); }
}

async function ledgerRow(table, identity) {
  const client = await adminClient();
  try {
    const result = await client.query(
      'SELECT batch_identity, inserted, updated, deleted, skipped_missing, batch_kind, source_xid, source_commit_lsn FROM spool_internal.batch_ledger WHERE target_table = $1 AND batch_identity = $2',
      [table, identity]
    );
    return result.rows[0] ?? null;
  } finally { await client.end(); }
}

function rowHash(row) {
  return postgresContentRowHash({ primaryKey: ['id'], columns: ['id', 'name'], key: { id: row.id }, row });
}

// One source transaction mixing every op class: update seeded rows, delete a
// seeded row, insert new rows. The target must expose exactly one commit.
function mixedMutations() {
  return [
    { op: 'upsert', row: { id: 1, name: 'one-renamed' } },
    { op: 'upsert', row: { id: 2, name: 'two-renamed' } },
    { op: 'delete', key: { id: 3 }, expectedRowHash: rowHash({ id: 3, name: 'three' }), precondition: 'full-row' },
    { op: 'upsert', row: { id: 4, name: 'four' } },
    { op: 'upsert', row: { id: 5, name: 'five' } }
  ];
}

function txInput({ table, label, mutations, lease, mutationCount = null, extra = {} }) {
  return {
    migrationId: `cdc_tx_${label}`, planId: PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID, mappingRevision: 1,
    fencingToken: lease.fencingToken,
    transactionIdentity: txIdentity(label),
    xid: 9000 + label.length, beginLsn: '0/3000000', commitLsn: '0/3000100',
    mutationCount: mutationCount ?? mutations.length, payloadHash: payloadHash(label),
    primaryKey: ['id'], mutations, ...extra
  };
}

async function fencedTarget(table, owner, faultInjector = null) {
  const resource = leaseResource(table);
  const lease = await acquirePostgresLease({ targetRef: tableRef(table), credentialBroker: broker, resource, owner, ttlMs: 120_000 });
  return {
    lease,
    target: new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: resource, fenceOwner: owner, faultInjector })
  };
}

test('one mixed source transaction commits atomically with one ledger record', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'cdc_tx_atomic';
  await resetTable(table);
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(id, name) VALUES (1,'one'),(2,'two'),(3,'three')`);
    } finally { await seed.end(); }
    const { lease, target } = await fencedTarget(table, 'owner-atomic');
    const mutations = mixedMutations();
    const committed = await target.commitCdcTransaction(txInput({ table, label: 'atomic', mutations, lease }));
    assert.equal(committed.status, 'COMMITTED_EXACT');
    assert.equal(committed.alreadyCommitted, false);
    assert.equal(committed.inserted, 2);
    assert.equal(committed.updated, 2);
    assert.equal(committed.deleted, 1);
    assert.deepEqual(await tableRows(table), [
      { id: 1, name: 'one-renamed' },
      { id: 2, name: 'two-renamed' },
      { id: 4, name: 'four' },
      { id: 5, name: 'five' }
    ]);
    // Exactly one ledger record binds the whole transaction.
    const row = await ledgerRow(table, txIdentity('atomic'));
    assert.ok(row);
    assert.equal(row.batch_kind, 'cdc');
    assert.equal(Number(row.inserted), 2);
    assert.equal(Number(row.updated), 2);
    assert.equal(Number(row.deleted), 1);
    // Replay is idempotent with the original exact counts.
    const replay = await target.commitCdcTransaction(txInput({ table, label: 'atomic', mutations, lease }));
    assert.equal(replay.alreadyCommitted, true);
    assert.equal(replay.inserted, 2);
    assert.equal(replay.updated, 2);
    assert.equal(replay.deleted, 1);
    assert.deepEqual(await tableRows(table), [
      { id: 1, name: 'one-renamed' },
      { id: 2, name: 'two-renamed' },
      { id: 4, name: 'four' },
      { id: 5, name: 'five' }
    ]);
  } finally { await dropTable(table); }
});

test('streaming mutation iterable commits without a materialized array', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'cdc_tx_stream';
  await resetTable(table);
  try {
    const { lease, target } = await fencedTarget(table, 'owner-stream');
    async function *gen() {
      for (let id = 1; id <= 2500; id += 1) yield { op: 'upsert', row: { id, name: `row-${id}` } };
      yield { op: 'delete', key: { id: 7 }, expectedRowHash: null, precondition: 'key-only' };
    }
    const committed = await target.commitCdcTransaction(txInput({ table, label: 'stream', mutations: gen(), lease, mutationCount: 2501 }));
    // mutationCount must equal the streamed length (2501: 2500 upserts + 1 delete of an inserted row).
    assert.equal(committed.rowCount, 2501);
    assert.equal(committed.inserted, 2500);
    assert.equal(committed.deleted, 1);
    const rows = await tableRows(table);
    assert.equal(rows.length, 2499);
    assert.equal(rows[0].name, 'row-1');
    assert.ok(!rows.some(row => row.id === 7));
  } finally { await dropTable(table); }
});

// Fault matrix: every pre-commit fault leaves zero visible effects; the
// post-commit fault returns without a result but the retry reconciles exact.
const PRE_COMMIT_POINTS = [
  'CDC_TX_AFTER_FENCE_CHECK',
  'CDC_TX_AFTER_FIRST_MUTATION',
  'CDC_TX_AFTER_MIDDLE_MUTATION',
  'CDC_TX_BEFORE_LEDGER',
  'CDC_TX_AFTER_LEDGER',
  'CDC_TX_BEFORE_COMMIT'
];

for (const point of PRE_COMMIT_POINTS) {
  test(`pre-commit fault at ${point} leaves zero visible effects`, { skip: !enabled, timeout: 120_000 }, async () => {
    const table = 'cdc_tx_fault';
    await resetTable(table);
    const label = `fault-${point}`;
    try {
      const seed = await adminClient();
      try {
        await seed.query(`INSERT INTO public."${table}"(id, name) VALUES (1,'one'),(2,'two'),(3,'three')`);
      } finally { await seed.end(); }
      const injector = { hit: async p => p === point };
      const { lease, target } = await fencedTarget(table, `owner-${point}`, injector);
      const mutations = mixedMutations();
      await assert.rejects(
        target.commitCdcTransaction(txInput({ table, label, mutations, lease })),
        new RegExp(point === 'CDC_TX_AFTER_FENCE_CHECK' ? 'FAULT_CDC_TX_AFTER_FENCE_CHECK' : `FAULT_${point}`)
      );
      // Zero visible effects: original rows untouched, no ledger record.
      assert.deepEqual(await tableRows(table), [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
        { id: 3, name: 'three' }
      ]);
      assert.equal(await ledgerRow(table, txIdentity(label)), null);
      // Retry without the fault commits exactly once.
      const clean = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: leaseResource(table), fenceOwner: `owner-${point}` });
      const committed = await clean.commitCdcTransaction(txInput({ table, label, mutations, lease }));
      assert.equal(committed.alreadyCommitted, false);
      assert.equal(committed.deleted, 1);
      assert.deepEqual(await tableRows(table), [
        { id: 1, name: 'one-renamed' },
        { id: 2, name: 'two-renamed' },
        { id: 4, name: 'four' },
        { id: 5, name: 'five' }
      ]);
    } finally { await dropTable(table); }
  });
}

test('post-commit fault reconciles to the exact previous result on retry', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'cdc_tx_postcommit';
  await resetTable(table);
  const label = 'postcommit';
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(id, name) VALUES (1,'one'),(2,'two'),(3,'three')`);
    } finally { await seed.end(); }
    const injector = { hit: async p => p === 'CDC_TX_AFTER_COMMIT_BEFORE_RETURN' };
    const { lease, target } = await fencedTarget(table, 'owner-postcommit', injector);
    const mutations = mixedMutations();
    await assert.rejects(
      target.commitCdcTransaction(txInput({ table, label, mutations, lease })),
      /FAULT_CDC_TX_AFTER_COMMIT_BEFORE_RETURN/
    );
    // The commit happened: rows applied, ledger present.
    assert.deepEqual(await tableRows(table), [
      { id: 1, name: 'one-renamed' },
      { id: 2, name: 'two-renamed' },
      { id: 4, name: 'four' },
      { id: 5, name: 'five' }
    ]);
    assert.ok(await ledgerRow(table, txIdentity(label)));
    // Retry returns the exact previous result — no duplicate commit.
    const clean = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: leaseResource(table), fenceOwner: 'owner-postcommit' });
    const replay = await clean.commitCdcTransaction(txInput({ table, label, mutations, lease }));
    assert.equal(replay.alreadyCommitted, true);
    assert.equal(replay.inserted, 2);
    assert.equal(replay.updated, 2);
    assert.equal(replay.deleted, 1);
  } finally { await dropTable(table); }
});

test('effect budget and stale fence fail closed before any mutation', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'cdc_tx_budget';
  await resetTable(table);
  try {
    const { lease, target } = await fencedTarget(table, 'owner-budget');
    const mutations = mixedMutations();
    await assert.rejects(
      target.commitCdcTransaction(txInput({ table, label: 'budget', mutations, lease, extra: { maxMutations: 2 } })),
      /CDC_TRANSACTION_BUDGET_EXCEEDED/
    );
    assert.deepEqual(await tableRows(table), []);
    const stale = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: leaseResource(table), fenceOwner: 'intruder' });
    await assert.rejects(
      stale.commitCdcTransaction(txInput({ table, label: 'budget', mutations, lease: { fencingToken: 1 } })),
      /STALE_FENCE/
    );
    assert.deepEqual(await tableRows(table), []);
  } finally { await dropTable(table); }
});
