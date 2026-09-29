import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { parsePostgresEndpoint } from '../../src/connectors/postgres/connection.js';
import {
  ensurePostgresPublication,
  createPostgresReplicationSlot,
  dropPostgresReplicationSlot
} from '../../src/connectors/postgres/cdc.js';
import { createCdcApplier } from '../../src/connectors/postgres/cdc-apply.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
broker.withSecret = async (ref, fn) => fn(password);

const SOURCE_TABLE = 'spool_cdc_backpressure_src';
const SLOT = 'spool_cdc_backpressure_slot';
const PUBLICATION = 'spool_cdc_backpressure_pub';
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;

// Burst backlog: enough messages to exceed a small inbound queue cap many
// times over while the applier is still draining. Pre-fix the pump drops
// whatever arrives while the queue is full (including COMMITs), so the
// assembler sees a BEGIN for a transaction whose end was lost and fails
// with CDC_PROTOCOL_VIOLATION: Nested BEGIN. With backpressure the same
// burst must drain losslessly: every transaction applied exactly once.
const SINGLE_TXNS = 4000;
const BIG_TXN_ROWS = 500;

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

function tableRef() {
  return {
    connector: 'postgres', connectionId: 'pg-cdc-backpressure', resource: `public.${SOURCE_TABLE}`,
    endpoint, database, schema: 'public', table: SOURCE_TABLE, identity: { user }, secretRef
  };
}

async function adminClient() {
  const parsed = parsePostgresEndpoint(endpoint);
  const client = new Client({ host: parsed.host, port: parsed.port, database, user, password, ssl: false });
  await client.connect();
  return client;
}

async function reset() {
  const client = await adminClient();
  try {
    await client.query(`DROP TABLE IF EXISTS public."${SOURCE_TABLE}" CASCADE`);
    await client.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: SLOT }).catch(() => {});
    await client.query(`CREATE TABLE public."${SOURCE_TABLE}" (id integer PRIMARY KEY, payload text NOT NULL)`);
    await client.query(`ALTER TABLE public."${SOURCE_TABLE}" REPLICA IDENTITY FULL`);
    await ensurePostgresPublication({ ref: dbRef(), credentialBroker: broker, publicationName: PUBLICATION, tables: [{ schema: 'public', table: SOURCE_TABLE }] });
    const slot = await createPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: SLOT });
    assert.equal(slot.existed, false);
  } finally { await client.end(); }
}

async function cleanup() {
  const client = await adminClient();
  try {
    await client.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await client.query(`DROP TABLE IF EXISTS public."${SOURCE_TABLE}" CASCADE`);
    await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: SLOT }).catch(() => {});
  } finally { await client.end(); }
}

async function flushLsn() {
  const client = await adminClient();
  try {
    const result = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    return String(result.rows[0].lsn).toUpperCase();
  } finally { await client.end(); }
}

// In-memory checkpoint with CAS versions, mirroring the run-store contract:
// versions must advance, watermarks never move backwards.
function memoryCheckpoint() {
  let stored = null;
  return {
    load: async () => stored,
    save: async record => {
      if (stored != null && record.expectedVersion !== stored.version) {
        const error = new Error(`checkpoint version conflict: expected ${record.expectedVersion}, have ${stored.version}`);
        error.code = 'CHECKPOINT_VERSION_CONFLICT';
        throw error;
      }
      stored = { ...record, version: (stored?.version ?? 0) + 1 };
      return stored;
    }
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('burst backlog larger than the inbound queue drains losslessly (backpressure, no drops)', { skip: !enabled, timeout: 300_000 }, async t => {
  await reset();
  const stagingDir = await mkdtemp(join(tmpdir(), 'spool-cdc-backpressure-'));
  try {
    // Fire the whole burst, then subscribe: the server blasts the entire
    // backlog as fast as TCP allows while the applier drains at apply
    // speed. Queue cap is deliberately tiny so any drop-based pump fails.
    const writer = await adminClient();
    try {
      for (let id = 1; id <= SINGLE_TXNS; id += 1) {
        await writer.query(`INSERT INTO public."${SOURCE_TABLE}"(id, payload) VALUES ($1, $2)`, [id, `burst-${id}`]);
      }
      const values = [];
      for (let j = 0; j < BIG_TXN_ROWS; j += 1) values.push(`(${SINGLE_TXNS + 1 + j}, 'big-${j}')`);
      await writer.query(`INSERT INTO public."${SOURCE_TABLE}"(id, payload) VALUES ${values.join(',')}`);
    } finally { await writer.end(); }
    const waterline = await flushLsn();

    let committed = 0;
    let appliedRows = 0;
    const target = {
      async commitCdcTransaction({ mutations }) {
        // Slow apply: guarantees the producer outruns the consumer so a
        // drop-based pump overflows its queue mid-burst.
        await sleep(3);
        let rows = 0;
        for await (const mutation of mutations) {
          if (mutation.op === 'upsert') rows += 1;
        }
        committed += 1;
        appliedRows += rows;
        return { inserted: rows, updated: 0, deleted: 0, skippedMissingCount: 0, alreadyCommitted: false };
      }
    };

    const applier = createCdcApplier({
      ref: dbRef(),
      credentialBroker: broker,
      slotName: SLOT,
      publicationNames: [PUBLICATION],
      migration: { migrationId: 'cdc_backpressure_001', sourceSnapshotId: SNAPSHOT_ID },
      plan: {
        planId: PLAN_ID,
        mappingRevision: 1,
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
          { target: 'payload', expr: { op: 'field', name: 'payload' } }
        ],
        targetSchema: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'payload', type: 'string', nullable: false }
        ],
        targetRef: tableRef()
      },
      targetContractId: 'test-contract-backpressure',
      primaryKey: ['id'],
      sourceTable: { schema: 'public', table: SOURCE_TABLE },
      target,
      checkpoint: memoryCheckpoint(),
      renewFence: async () => 7,
      ownerEpoch: 'test-epoch-backpressure',
      startLsn: null,
      untilLsn: waterline,
      stagingDir,
      maxQueueMessages: 2000
    });

    const summary = await applier.run();
    assert.equal(summary.appliedTransactions, SINGLE_TXNS + 1);
    assert.equal(committed, SINGLE_TXNS + 1);
    assert.equal(appliedRows, SINGLE_TXNS + BIG_TXN_ROWS);
    assert.equal(applier.metrics().reconnects, 0);
    t.diagnostic(`drained ${summary.appliedTransactions} txns / ${appliedRows} rows with queue cap 2000, reconnects=0`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await cleanup();
  }
});
