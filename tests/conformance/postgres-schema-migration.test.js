import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { parsePostgresEndpoint } from '../../src/connectors/postgres/connection.js';
import { inspectPostgresTarget } from '../../src/connectors/postgres/preflight.js';
import { createBoundApproval } from '../../src/platform/approval.js';
import { connectorIdentity } from '../../src/platform/contracts.js';
import {
  applySchemaMigration,
  captureSchemaContract,
  createSchemaMigrationPlan,
  describeSchemaDrift,
  diffPostgresSchema
} from '../../src/connectors/postgres/schema-migration.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;
const APPROVAL_KEY = 'schema-migration-conformance-test-key-32b';
const DESTRUCTIVE_EFFECT = 'postgres:schema-migrate-destructive';

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

function tableRef(table) {
  return {
    connector: 'postgres', connectionId: 'pg-schema-mig', resource: `public.${table}`,
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
  return `postgres:${parsePostgresEndpoint(endpoint).endpoint}:${database}:public.${table}:schema-migration`;
}

async function resetTable(table, ddl) {
  const setup = await adminClient();
  try {
    await setup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await setup.query(ddl);
    for (const cleanup of [
      ['DELETE FROM spool_internal.schema_migrations WHERE target_table = $1', [table]],
      ['DELETE FROM spool_internal.execution_leases WHERE resource = $1', [leaseResource(table)]]
    ]) {
      try {
        await setup.query(cleanup[0], cleanup[1]);
      } catch (error) {
        if (error?.code !== '42P01') throw error;
      }
    }
  } finally { await setup.end(); }
}

async function dropTable(table) {
  const cleanup = await adminClient();
  try { await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } finally { await cleanup.end(); }
}

async function liveColumns(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`
      SELECT a.attname AS name, t.typname AS pgtype, a.attnotnull AS notnull
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `, [table]);
    return result.rows;
  } finally { await client.end(); }
}

async function livePk(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`
      SELECT a.attname AS name
      FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinal)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND i.indisprimary
      ORDER BY key.ordinal
    `, [table]);
    return result.rows.map(row => row.name);
  } finally { await client.end(); }
}

function destructiveApproval({ table, migrationId, planId, fromContractId }) {
  return createBoundApproval({
    migrationId,
    planId,
    planRevision: 1,
    sourceSnapshotId: SNAPSHOT_ID,
    targetIdentity: { connector: 'postgres', connectionId: 'pg-schema-mig', resource: `public.${table}` },
    targetContractId: fromContractId,
    effects: ['postgres:schema-migrate', DESTRUCTIVE_EFFECT],
    writeStrategy: {},
    principal: 'operator:schema-migration-test',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    nonce: `schema-mig-${migrationId}`
  }, { signingKey: APPROVAL_KEY });
}

test('add-column migration applies online, preserves rows and replays idempotently', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mig_add';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
  try {
    const seed = await adminClient();
    try {
      const values = [];
      const placeholders = [];
      for (let id = 1; id <= 20; id += 1) {
        values.push(id, `name-${id}`);
        placeholders.push(`($${values.length - 1}, $${values.length})`);
      }
      await seed.query(`INSERT INTO public."${table}"(id, name) VALUES ${placeholders.join(', ')}`, values);
    } finally { await seed.end(); }

    const preflight = await inspectPostgresTarget({
      targetRef: tableRef(table),
      targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }],
      credentialBroker: broker
    });
    const captured = await captureSchemaContract({ targetRef: tableRef(table), credentialBroker: broker });
    assert.equal(captured.contractId, preflight.targetContractId);

    const desired = [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false },
      { name: 'nick', type: 'string', nullable: true }
    ];
    const diff = diffPostgresSchema({ desiredSchema: desired, primaryKey: ['id'], liveRecord: captured.record });
    assert.deepEqual(diff.map(entry => [entry.kind, entry.safety]), [['ADD_COLUMN', 'ONLINE']]);
    const plan = createSchemaMigrationPlan({
      migrationId: 'mig_add_001',
      targetIdentity: connectorIdentity(tableRef(table)),
      fromContractId: preflight.targetContractId,
      desiredSchema: desired,
      primaryKey: ['id'],
      diff
    });
    assert.equal(plan.requiresDestructiveApproval, false);

    const applied = await applySchemaMigration({ targetRef: tableRef(table), credentialBroker: broker, plan });
    assert.equal(applied.status, 'APPLIED');
    assert.equal(applied.stepsApplied, 1);
    assert.equal(applied.destructive, false);
    assert.notEqual(applied.toContractId, applied.fromContractId);

    const columns = await liveColumns(table);
    assert.deepEqual(columns.map(column => column.name), ['id', 'name', 'nick']);
    const check = await adminClient();
    try {
      const count = await check.query(`SELECT count(*)::int AS n FROM public."${table}" WHERE nick IS NULL`);
      assert.equal(count.rows[0].n, 20);
      const ledger = await check.query('SELECT plan_id, destructive, approval_id FROM spool_internal.schema_migrations WHERE plan_id = $1', [plan.planId]);
      assert.equal(ledger.rows.length, 1);
      assert.equal(ledger.rows[0].destructive, false);
      assert.equal(ledger.rows[0].approval_id, null);
    } finally { await check.end(); }

    const replay = await applySchemaMigration({ targetRef: tableRef(table), credentialBroker: broker, plan });
    assert.equal(replay.status, 'ALREADY_APPLIED');
    assert.equal(replay.toContractId, applied.toContractId);
  } finally { await dropTable(table); }
});

test('out-of-band drift fails the apply closed with a structured report', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mig_drift';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
  try {
    const preflight = await inspectPostgresTarget({
      targetRef: tableRef(table),
      targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }],
      credentialBroker: broker
    });
    const captured = await captureSchemaContract({ targetRef: tableRef(table), credentialBroker: broker });
    const desired = [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false },
      { name: 'nick', type: 'string', nullable: true }
    ];
    const plan = createSchemaMigrationPlan({
      migrationId: 'mig_drift_001',
      targetIdentity: connectorIdentity(tableRef(table)),
      fromContractId: preflight.targetContractId,
      desiredSchema: desired,
      primaryKey: ['id'],
      diff: diffPostgresSchema({ desiredSchema: desired, primaryKey: ['id'], liveRecord: captured.record })
    });

    const intruder = await adminClient();
    try {
      await intruder.query(`ALTER TABLE public."${table}" ADD COLUMN intruder text`);
    } finally { await intruder.end(); }

    const drift = await describeSchemaDrift({
      targetRef: tableRef(table), credentialBroker: broker,
      expectedContractId: preflight.targetContractId, desiredSchema: desired, primaryKey: ['id']
    });
    assert.equal(drift.status, 'DRIFTED');
    assert.equal(drift.contractChanged, true);
    assert.ok(drift.diff.some(entry => entry.kind === 'DROP_COLUMN' && entry.column === 'intruder'));

    await assert.rejects(
      applySchemaMigration({ targetRef: tableRef(table), credentialBroker: broker, plan }),
      /SCHEMA_DRIFT/
    );
    const columns = await liveColumns(table);
    assert.deepEqual(columns.map(column => column.name), ['id', 'name', 'intruder']);
  } finally { await dropTable(table); }
});

test('destructive drop requires a bound approval and records it in the ledger', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mig_drop';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL, secret text NULL)`);
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(id, name, secret) VALUES (1, 'one', 's1'), (2, 'two', 's2')`);
    } finally { await seed.end(); }

    const preflight = await inspectPostgresTarget({
      targetRef: tableRef(table),
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false },
        { name: 'secret', type: 'string', nullable: true }
      ],
      credentialBroker: broker
    });
    const captured = await captureSchemaContract({ targetRef: tableRef(table), credentialBroker: broker });
    const desired = [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ];
    const plan = createSchemaMigrationPlan({
      migrationId: 'mig_drop_001',
      targetIdentity: connectorIdentity(tableRef(table)),
      fromContractId: preflight.targetContractId,
      desiredSchema: desired,
      primaryKey: ['id'],
      diff: diffPostgresSchema({ desiredSchema: desired, primaryKey: ['id'], liveRecord: captured.record })
    });
    assert.equal(plan.requiresDestructiveApproval, true);

    await assert.rejects(
      applySchemaMigration({ targetRef: tableRef(table), credentialBroker: broker, plan }),
      /APPROVAL_REQUIRED/
    );
    await assert.rejects(
      applySchemaMigration({
        targetRef: tableRef(table), credentialBroker: broker, plan,
        destructiveApproval: { approvalId: 'hmac-sha256:00', record: {} }
      }),
      /APPROVAL_BINDING_MISMATCH/
    );

    const approval = destructiveApproval({ table: 'mig_drop', migrationId: 'mig_drop_001', planId: plan.planId, fromContractId: preflight.targetContractId });
    const applied = await applySchemaMigration({ targetRef: tableRef(table), credentialBroker: broker, plan, destructiveApproval: approval });
    assert.equal(applied.status, 'APPLIED');
    assert.equal(applied.destructive, true);
    assert.equal(applied.approvalId, approval.approvalId);

    const columns = await liveColumns(table);
    assert.deepEqual(columns.map(column => column.name), ['id', 'name']);
    const check = await adminClient();
    try {
      const count = await check.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, 2);
      const ledger = await check.query('SELECT destructive, approval_id FROM spool_internal.schema_migrations WHERE plan_id = $1', [plan.planId]);
      assert.equal(ledger.rows[0].destructive, true);
      assert.equal(ledger.rows[0].approval_id, approval.approvalId);
    } finally { await check.end(); }
  } finally { await dropTable(table); }
});

test('total casts preserve values while uncastable narrowing fails closed atomically', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mig_types';
  await resetTable(table, `CREATE TABLE public."${table}" (id integer PRIMARY KEY, code integer NOT NULL, tag text NOT NULL)`);
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(id, code, tag) VALUES (1, 7, '1.5'), (2, 42, '2.5')`);
    } finally { await seed.end(); }

    const preflight = await inspectPostgresTarget({
      targetRef: tableRef(table),
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'code', type: 'integer', nullable: false },
        { name: 'tag', type: 'string', nullable: false }
      ],
      credentialBroker: broker
    });
    const captured = await captureSchemaContract({ targetRef: tableRef(table), credentialBroker: broker });
    const desired = [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'code', type: 'string', nullable: false },
      { name: 'tag', type: 'number', nullable: false }
    ];
    const diff = diffPostgresSchema({ desiredSchema: desired, primaryKey: ['id'], liveRecord: captured.record });
    assert.deepEqual(diff.map(entry => [entry.kind, entry.column, entry.safety]), [
      ['ALTER_COLUMN_TYPE', 'code', 'BLOCKING'],
      ['ALTER_COLUMN_TYPE', 'tag', 'DESTRUCTIVE']
    ]);
    const plan = createSchemaMigrationPlan({
      migrationId: 'mig_types_001',
      targetIdentity: connectorIdentity(tableRef(table)),
      fromContractId: preflight.targetContractId,
      desiredSchema: desired,
      primaryKey: ['id'],
      diff
    });
    const approval = destructiveApproval({ table: 'mig_types', migrationId: 'mig_types_001', planId: plan.planId, fromContractId: preflight.targetContractId });
    const applied = await applySchemaMigration({ targetRef: tableRef(table), credentialBroker: broker, plan, destructiveApproval: approval });
    assert.equal(applied.status, 'APPLIED');
    assert.equal(applied.stepsApplied, 2);

    const check = await adminClient();
    try {
      const rows = await check.query(`SELECT id, code, tag FROM public."${table}" ORDER BY id`);
      assert.deepEqual(rows.rows.map(row => [Number(row.id), row.code, Number(row.tag)]), [[1, '7', 1.5], [2, '42', 2.5]]);
      const types = await check.query(`
        SELECT a.attname AS name, t.typname AS pgtype FROM pg_attribute a
        JOIN pg_type t ON t.oid = a.atttypid
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
      `, [table]);
      assert.deepEqual(new Map(types.rows.map(row => [row.name, row.pgtype])).get('code'), 'text');
      assert.deepEqual(new Map(types.rows.map(row => [row.name, row.pgtype])).get('tag'), 'float8');
    } finally { await check.end(); }
  } finally { await dropTable(table); }

  const poisoned = 'mig_types_bad';
  await resetTable(poisoned, `CREATE TABLE public."${poisoned}" (id integer PRIMARY KEY, tag text NOT NULL)`);
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${poisoned}"(id, tag) VALUES (1, '1.5'), (2, 'not-a-number')`);
    } finally { await seed.end(); }
    const preflight = await inspectPostgresTarget({
      targetRef: tableRef(poisoned),
      targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'tag', type: 'string', nullable: false }],
      credentialBroker: broker
    });
    const captured = await captureSchemaContract({ targetRef: tableRef(poisoned), credentialBroker: broker });
    const desired = [{ name: 'id', type: 'integer', nullable: false }, { name: 'tag', type: 'number', nullable: false }];
    const plan = createSchemaMigrationPlan({
      migrationId: 'mig_types_002',
      targetIdentity: connectorIdentity(tableRef(poisoned)),
      fromContractId: preflight.targetContractId,
      desiredSchema: desired,
      primaryKey: ['id'],
      diff: diffPostgresSchema({ desiredSchema: desired, primaryKey: ['id'], liveRecord: captured.record })
    });
    const approval = destructiveApproval({ table: 'mig_types_bad', migrationId: 'mig_types_002', planId: plan.planId, fromContractId: preflight.targetContractId });
    await assert.rejects(
      applySchemaMigration({ targetRef: tableRef(poisoned), credentialBroker: broker, plan, destructiveApproval: approval }),
      /invalid input syntax/
    );
    const columns = await liveColumns(poisoned);
    assert.deepEqual(columns.map(column => [column.name, column.pgtype]), [['id', 'int4'], ['tag', 'text']]);
    const check = await adminClient();
    try {
      const count = await check.query(`SELECT count(*)::int AS n FROM public."${poisoned}"`);
      assert.equal(count.rows[0].n, 2);
      const ledger = await check.query('SELECT count(*)::int AS n FROM spool_internal.schema_migrations WHERE plan_id = $1', [plan.planId]);
      assert.equal(ledger.rows[0].n, 0);
    } finally { await check.end(); }
  } finally { await dropTable(poisoned); }
});

test('primary-key change rebuilds the key without losing rows', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'mig_pk';
  await resetTable(table, `CREATE TABLE public."${table}" (a integer NOT NULL, b integer NOT NULL)`);
  try {
    const seed = await adminClient();
    try {
      await seed.query(`INSERT INTO public."${table}"(a, b) VALUES (1, 10), (2, 20)`);
    } finally { await seed.end(); }

    const declared = [
      { name: 'a', type: 'integer', nullable: false },
      { name: 'b', type: 'integer', nullable: false }
    ];
    const preflight = await inspectPostgresTarget({ targetRef: tableRef(table), targetSchema: declared, credentialBroker: broker });
    const captured = await captureSchemaContract({ targetRef: tableRef(table), credentialBroker: broker });
    const plan = createSchemaMigrationPlan({
      migrationId: 'mig_pk_001',
      targetIdentity: connectorIdentity(tableRef(table)),
      fromContractId: preflight.targetContractId,
      desiredSchema: declared,
      primaryKey: ['a', 'b'],
      diff: diffPostgresSchema({ desiredSchema: declared, primaryKey: ['a', 'b'], liveRecord: captured.record })
    });
    assert.equal(plan.requiresDestructiveApproval, false);
    const applied = await applySchemaMigration({ targetRef: tableRef(table), credentialBroker: broker, plan });
    assert.equal(applied.status, 'APPLIED');
    assert.deepEqual(await livePk(table), ['a', 'b']);

    const release = await adminClient();
    try {
      await release.query('DELETE FROM spool_internal.execution_leases WHERE resource = $1', [leaseResource(table)]);
    } finally { await release.end(); }
    const narrowed = createSchemaMigrationPlan({
      migrationId: 'mig_pk_002',
      targetIdentity: connectorIdentity(tableRef(table)),
      fromContractId: applied.toContractId,
      desiredSchema: declared,
      primaryKey: ['a'],
      diff: diffPostgresSchema({ desiredSchema: declared, primaryKey: ['a'], liveRecord: (await captureSchemaContract({ targetRef: tableRef(table), credentialBroker: broker })).record })
    });
    assert.deepEqual(narrowed.steps.map(step => step.kind), ['PK_DROP', 'PK_ADD']);
    const second = await applySchemaMigration({ targetRef: tableRef(table), credentialBroker: broker, plan: narrowed });
    assert.equal(second.status, 'APPLIED');
    assert.deepEqual(await livePk(table), ['a']);
    const check = await adminClient();
    try {
      const count = await check.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, 2);
    } finally { await check.end(); }
  } finally { await dropTable(table); }
});
