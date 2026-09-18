import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { parsePostgresEndpoint } from '../../src/connectors/postgres/connection.js';
import { inspectPostgresTarget } from '../../src/connectors/postgres/preflight.js';
import {
  postgresContentRowHash,
  postgresContentKeyId
} from '../../src/connectors/postgres/row-codec.js';
import {
  PostgresTarget,
  acquirePostgresLease,
  postgresDeleteManifestEvidence,
  postgresMutationKeyId,
  postgresTruncateEvidence,
  requireUniqueMutationKeys
} from '../../src/connectors/postgres/target.js';
import { createBoundApproval } from '../../src/platform/approval.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;
const APPROVAL_KEY = 'mutations-conformance-test-key-32byte';
const TRUNCATE_EFFECT = 'postgres:target-truncate';

function batchIdentity(label) {
  return `sha256:${createHash('sha256').update(`spool-test-mutations:${label}`).digest('hex')}`;
}

function tableRef(table) {
  return {
    connector: 'postgres', connectionId: 'pg-mutations', resource: `public.${table}`,
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

async function resetTable(table, ddl) {
  const setup = await adminClient();
  try {
    await setup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await setup.query(ddl);
    await setup.query('DELETE FROM spool_internal.batch_ledger WHERE target_table = $1', [table]);
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

function targetSchema() {
  return [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false }
  ];
}

function rowHash(row) {
  return postgresContentRowHash({ primaryKey: ['id'], columns: ['id', 'name'], key: { id: row.id }, row });
}

function truncateApproval({ table, migrationId, liveContractId }) {
  return createBoundApproval({
    migrationId,
    planId: `sha256:${'1'.repeat(64)}`,
    planRevision: 1,
    sourceSnapshotId: SNAPSHOT_ID,
    targetIdentity: { connector: 'postgres', connectionId: 'pg-mutations', resource: `public.${table}` },
    targetContractId: liveContractId,
    effects: ['postgres:target-write', TRUNCATE_EFFECT],
    writeStrategy: {},
    principal: 'operator:mutations-test',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    nonce: `truncate-${migrationId}`
  }, { signingKey: APPROVAL_KEY });
}

test('upsert inserts new rows and updates existing rows with exact counts', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mut_upsert';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(id, name) VALUES (1, 'one'), (2, 'two')`);
    } finally { await seed.end(); }

    const target = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker });
    const rows = [{ id: 2, name: 'two-renamed' }, { id: 3, name: 'three' }];
    const batchIdentity = 'sha256:ee1080ac11195df7eb95230ec3b58a552e01ea80762be7ee44a34faad60c66c9';
    const input = {
      batchIdentity, migrationId: 'mut_upsert_001', planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID, mappingRevision: 1, primaryKey: ['id'], rows
    };
    const committed = await target.commitUpsertBatch(input);
    assert.equal(committed.status, 'COMMITTED_EXACT');
    assert.equal(committed.alreadyCommitted, false);
    assert.equal(committed.inserted, 1);
    assert.equal(committed.updated, 1);
    assert.equal(committed.rowCount, 2);

    const check = await adminClient();
    try {
      const result = await check.query(`SELECT id, name FROM public."${table}" ORDER BY id`);
      assert.deepEqual(result.rows, [{ id: 1, name: 'one' }, { id: 2, name: 'two-renamed' }, { id: 3, name: 'three' }]);
    } finally { await check.end(); }

    const replay = await target.commitUpsertBatch(input);
    assert.equal(replay.status, 'COMMITTED_EXACT');
    assert.equal(replay.alreadyCommitted, true);
    assert.equal(replay.batchIdentity, committed.batchIdentity);

    await assert.rejects(
      target.commitUpsertBatch({ ...input, rows: [{ id: 2, name: 'conflict' }, { id: 4, name: 'four' }] }),
      /BATCH_IDENTITY_CONFLICT/
    );
  } finally { await dropTable(table); }
});

test('upsert rejects duplicate keys without writing anything', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mut_upsert_dup';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
  try {
    const target = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker });
    await assert.rejects(
      target.commitUpsertBatch({
        batchIdentity: 'sha256:d059e27ca126f3d995dcd6243f6fdf74aac6496e74578bfaa9e43d0891759ce6', migrationId: 'mut_upsert_002', planId: PLAN_ID,
        sourceSnapshotId: SNAPSHOT_ID, mappingRevision: 1, primaryKey: ['id'],
        rows: [{ id: 1, name: 'a' }, { id: 1, name: 'b' }]
      }),
      /DUPLICATE_BATCH_KEY/
    );
    const check = await adminClient();
    try {
      const count = await check.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, 0);
      const ledger = await check.query('SELECT count(*)::int AS n FROM spool_internal.batch_ledger WHERE target_table = $1', [table]);
      assert.equal(ledger.rows[0].n, 0);
    } finally { await check.end(); }
  } finally { await dropTable(table); }
});

test('delete removes exactly the proven rows and replays from the ledger', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mut_delete';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
  try {
    const rows = [{ id: 1, name: 'one' }, { id: 2, name: 'two' }, { id: 3, name: 'three' }];
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')`);
    } finally { await seed.end(); }

    const target = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker });
    const batchIdentity = 'sha256:722f482e4c609cacea32232c58133ddf7c451226d745f3920b1cc3a1b5195351';
    const input = {
      batchIdentity, migrationId: 'mut_delete_001', planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID, mappingRevision: 1, primaryKey: ['id'],
      deletions: [
        { key: { id: 1 }, expectedRowHash: rowHash(rows[0]) },
        { key: { id: 3 }, expectedRowHash: rowHash(rows[2]) }
      ]
    };
    const committed = await target.commitDeleteBatch(input);
    assert.equal(committed.status, 'COMMITTED_EXACT');
    assert.equal(committed.deleted, 2);

    const check = await adminClient();
    try {
      const result = await check.query(`SELECT id, name FROM public."${table}" ORDER BY id`);
      assert.deepEqual(result.rows, [{ id: 2, name: 'two' }]);
    } finally { await check.end(); }

    const replay = await target.commitDeleteBatch(input);
    assert.equal(replay.alreadyCommitted, true);
  } finally { await dropTable(table); }
});

test('delete fails closed on wrong preconditions and missing keys', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mut_delete_bad';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(id, name) VALUES (1, 'one'), (2, 'two')`);
    } finally { await seed.end(); }

    const target = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker });
    const base = {
      migrationId: 'mut_delete_002', planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID, mappingRevision: 1, primaryKey: ['id']
    };
    const wrongHash = rowHash({ id: 1, name: 'tampered' });
    await assert.rejects(
      target.commitDeleteBatch({
        ...base, batchIdentity: 'sha256:268ec4c134ebbe215b63002cbaa481f20e9e0e9b9618456a13157f5a2f8d197a',
        deletions: [{ key: { id: 1 }, expectedRowHash: wrongHash }]
      }),
      /DELETE_PRECONDITION_FAILED/
    );
    await assert.rejects(
      target.commitDeleteBatch({
        ...base, batchIdentity: 'sha256:a4a4277a8cb7a07108435451d52e82b9bdc83c3162b7eed8e3c7d86f7398d3a1',
        deletions: [{ key: { id: 99 }, expectedRowHash: rowHash({ id: 99, name: 'ghost' }) }]
      }),
      /DELETE_PRECONDITION_FAILED/
    );

    const check = await adminClient();
    try {
      const count = await check.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, 2);
      const ledger = await check.query('SELECT count(*)::int AS n FROM spool_internal.batch_ledger WHERE target_table = $1', [table]);
      assert.equal(ledger.rows[0].n, 0);
    } finally { await check.end(); }
  } finally { await dropTable(table); }
});

test('truncate requires a bound approval and leaves exact ledger evidence', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mut_truncate';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(id, name) VALUES (1, 'one'), (2, 'two')`);
    } finally { await seed.end(); }

    const preflight = await inspectPostgresTarget({ targetRef: tableRef(table), targetSchema: targetSchema(), credentialBroker: broker });
    const target = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker });
    const base = {
      migrationId: 'mut_truncate_001', planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID, mappingRevision: 1,
      batchIdentity: 'sha256:aa53f8b345c85d7b29e17642b93bd2cf2e7a884e53bdb8a29ed12fff7ef4eb14',
      targetContractId: preflight.targetContractId
    };
    await assert.rejects(target.truncateTarget(base), /APPROVAL_REQUIRED/);
    await assert.rejects(
      target.truncateTarget({ ...base, approval: { approvalId: 'x', record: {} } }),
      /APPROVAL_BINDING_MISMATCH/
    );

    const approval = truncateApproval({ table: 'mut_truncate', migrationId: 'mut_truncate_001', liveContractId: preflight.targetContractId });
    const truncated = await target.truncateTarget({ ...base, approval });
    assert.equal(truncated.status, 'TRUNCATED_EXACT');
    assert.equal(truncated.alreadyCommitted, false);
    assert.equal(truncated.approvalId, approval.approvalId);

    const check = await adminClient();
    try {
      const count = await check.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, 0);
      const ledger = await check.query('SELECT row_count, payload_hash FROM spool_internal.batch_ledger WHERE batch_identity = $1', [base.batchIdentity]);
      assert.equal(ledger.rows.length, 1);
      assert.equal(ledger.rows[0].row_count, 0);
    } finally { await check.end(); }

    const replay = await target.truncateTarget({ ...base, approval });
    assert.equal(replay.status, 'TRUNCATED_EXACT');
    assert.equal(replay.alreadyCommitted, true);

    const writer = await adminClient();
    try {
      await writer.query(`INSERT INTO public."${table}"(id, name) VALUES (10, 'ten')`);
      const count = await writer.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, 1);
    } finally { await writer.end(); }
  } finally { await dropTable(table); }
});

test('stale fencing tokens are rejected on upsert, delete and truncate', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mut_fence';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
  try {
    const resource = leaseResource(table);
    const probe = await adminClient();
    try {
      await probe.query(`INSERT INTO public."${table}"(id, name) VALUES (1, 'one')`);
    } finally { await probe.end(); }

    const first = await acquirePostgresLease({ targetRef: tableRef(table), credentialBroker: broker, resource, owner: 'fence-a', ttlMs: 1200 });
    await new Promise(resolve => setTimeout(resolve, 1800));
    const second = await acquirePostgresLease({ targetRef: tableRef(table), credentialBroker: broker, resource, owner: 'fence-b', ttlMs: 60_000 });
    assert.ok(second.fencingToken > first.fencingToken);

    const stale = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: resource, fenceOwner: 'fence-a' });
    const base = {
      migrationId: 'mut_fence_001', planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID, mappingRevision: 1, fencingToken: first.fencingToken
    };
    await assert.rejects(
      stale.commitUpsertBatch({ ...base, batchIdentity: 'sha256:85b199d54d2e8e93b9ea29ada302fa998c4fcd4dfebf142ea4e1cfdfdc971e2b', primaryKey: ['id'], rows: [{ id: 2, name: 'two' }] }),
      /(STALE_FENCE|LEASE_HELD)/
    );
    await assert.rejects(
      stale.commitDeleteBatch({
        ...base, batchIdentity: 'sha256:946819ceff8cb7a8169112baf75968c24847e35849375cde9f9b5476d3ef935b', primaryKey: ['id'],
        deletions: [{ key: { id: 1 }, expectedRowHash: rowHash({ id: 1, name: 'one' }) }]
      }),
      /(STALE_FENCE|LEASE_HELD)/
    );
    const preflight = await inspectPostgresTarget({ targetRef: tableRef(table), targetSchema: targetSchema(), credentialBroker: broker });
    await assert.rejects(
      stale.truncateTarget({
        ...base, batchIdentity: 'sha256:105fc45e4bdce504f46ffe0ad176536f57b26b3d04b3eb099f4b3dc49ad31b46', targetContractId: preflight.targetContractId,
        approval: truncateApproval({ table: 'mut_fence', migrationId: 'mut_fence_001', liveContractId: preflight.targetContractId })
      }),
      /(STALE_FENCE|LEASE_HELD)/
    );

    const live = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: resource, fenceOwner: 'fence-b' });
    const upserted = await live.commitUpsertBatch({
      ...base, fencingToken: second.fencingToken,
      batchIdentity: 'sha256:85b199d54d2e8e93b9ea29ada302fa998c4fcd4dfebf142ea4e1cfdfdc971e2b', primaryKey: ['id'], rows: [{ id: 2, name: 'two' }]
    });
    assert.equal(upserted.status, 'COMMITTED_EXACT');
  } finally { await dropTable(table); }
});

test('mutation key helpers validate shape and uniqueness without a database', () => {
  const identified = postgresMutationKeyId({ primaryKey: ['id'], row: { id: 7, name: 'seven' } });
  assert.deepEqual(identified.key, { id: 7 });
  assert.equal(identified.keyId, postgresContentKeyId({ primaryKey: ['id'], key: { id: 7 } }));
  assert.throws(() => postgresMutationKeyId({ primaryKey: [], row: { id: 1 } }), /INVALID_MUTATION_KEY/);
  assert.throws(() => postgresMutationKeyId({ primaryKey: ['id'], row: { name: 'no-id' } }), /INVALID_MUTATION_KEY/);
  assert.throws(() => requireUniqueMutationKeys(['id'], [{ id: 1 }, { id: 1 }]), /DUPLICATE_BATCH_KEY/);
  const manifest = postgresDeleteManifestEvidence([
    { keyId: `sha256:${'b'.repeat(64)}`, expectedRowHash: `sha256:${'c'.repeat(64)}` },
    { keyId: `sha256:${'a'.repeat(64)}`, expectedRowHash: `sha256:${'d'.repeat(64)}` }
  ]);
  assert.equal(manifest.rowCount, 2);
  assert.throws(() => postgresDeleteManifestEvidence([{ keyId: 'nope', expectedRowHash: `sha256:${'c'.repeat(64)}` }]), /INVALID_DELETE_MANIFEST/);
  assert.throws(() => postgresTruncateEvidence({ database: 'd', schema: 's', table: 't', targetContractId: 'nope', approvalId: 'a' }), /INVALID_BATCH_EVIDENCE/);
});
