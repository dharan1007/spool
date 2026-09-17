import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { parsePostgresEndpoint } from '../../src/connectors/postgres/connection.js';
import {
  comparePostgresLsn,
  createPostgresReplicationSlot,
  dropPostgresReplicationSlot,
  ensurePostgresPublication,
  streamPostgresChanges
} from '../../src/connectors/postgres/cdc.js';
import { createPostgresTargetRuntime } from '../../src/connectors/postgres/runtime.js';
import { inspectPostgresTarget } from '../../src/connectors/postgres/preflight.js';
import { PostgresTarget } from '../../src/connectors/postgres/target.js';
import { claimWorkerLease, describeWorkerLease } from '../../src/connectors/postgres/workers.js';
import { verifyPostgresContent } from '../../src/connectors/postgres/content-verification.js';
import { createRepairPlan } from '../../src/execution/repair-plan.js';
import { connectorIdentity } from '../../src/platform/contracts.js';
import {
  createCdcSoakMeter,
  createSoakPlan,
  describeSlotLsn,
  recoverDroppedSlot,
  recordRpoRto,
  runSoakRound,
  terminateBackendByPid,
  waitForLsnToPass
} from '../../src/connectors/postgres/reference.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'b'.repeat(64)}`;

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

function tableRef(table) {
  return {
    connector: 'postgres', connectionId: 'pg-ref-recovery', resource: `public.${table}`,
    endpoint, database, schema: 'public', table, identity: { user }, secretRef
  };
}

async function adminClient() {
  const parsed = parsePostgresEndpoint(endpoint);
  const client = new Client({ host: parsed.host, port: parsed.port, database, user, password, ssl: false });
  await client.connect();
  return client;
}

function targetSchema() {
  return [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'string', nullable: false }
  ];
}

function batchInput(rows, batchIdentity) {
  return {
    batchIdentity,
    migrationId: 'pg_ref_recovery_001',
    planId: PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    mappingRevision: 1,
    rows
  };
}

function executionLeaseResource(table) {
  return `postgres:${endpoint}:${database}:public.${table}`;
}

async function resetRecoveryTable(table, batchIdentities = []) {
  const setup = await adminClient();
  try {
    await setup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await setup.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await setup.query('DELETE FROM spool_internal.execution_leases WHERE resource = $1', [executionLeaseResource(table)]);
    if (batchIdentities.length > 0) {
      await setup.query('DELETE FROM spool_internal.batch_ledger WHERE batch_identity = ANY($1)', [batchIdentities]);
    }
  } finally { await setup.end(); }
}

function makeRows(from, count) {
  const rows = [];
  for (let id = from; id < from + count; id += 1) rows.push({ id, name: `recovery-${id}` });
  return rows;
}

test('dropped replication slot is detected and recovered by recreating it', { skip: !enabled, timeout: 120_000 }, async () => {
  const slotName = 'ref_slot_loss';
  await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  const created = await createPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(created.existed, false);

  const live = await describeSlotLsn({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(live.present, true);

  const dropped = await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(dropped.dropped, true);
  const gone = await describeSlotLsn({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(gone.present, false);
  assert.throws(() => recoverDroppedSlot(gone), /REPLICATION_SLOT_LOST/);

  const recreated = await createPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(recreated.existed, false);
  const back = await describeSlotLsn({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(back.present, true);

  const probe = await adminClient();
  let currentLsn;
  try {
    const result = await probe.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    currentLsn = result.rows[0].lsn;
  } finally { await probe.end(); }
  const reached = await waitForLsnToPass({ ref: dbRef(), credentialBroker: broker, thresholdLsn: currentLsn, timeoutMs: 10_000 });
  assert.equal(reached.reached, true);
  const missed = await waitForLsnToPass({ ref: dbRef(), credentialBroker: broker, thresholdLsn: '99/FFFFFF', timeoutMs: 1500 });
  assert.equal(missed.reached, false);

  await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
});

test('cancelled COPY fails closed with no partial rows and the retry commits exact evidence', { skip: !enabled, timeout: 180_000 }, async () => {
  const table = 'ref_recovery_copy';
  const batchIdentity = `sha256:${'d'.repeat(64)}`;
  await resetRecoveryTable(table, [batchIdentity]);
  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectPostgresTarget({ targetRef: tableRef(table), targetSchema: targetSchema(), credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'pg_ref_recovery_001', targetRef: tableRef(table) });
  const rows = makeRows(1, 500);
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    const input = { ...batchInput(rows, batchIdentity), fencingToken: lease.fencingToken, targetContractId: preflight.targetContractId };

    const blocker = await adminClient();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE public."${table}" IN ACCESS EXCLUSIVE MODE`);
      const commitAttempt = target.commitBulkBatch(input).then(
        () => null,
        error => error
      );
      let victimPid = null;
      const deadline = Date.now() + 10_000;
      while (victimPid == null && Date.now() < deadline) {
        const probe = await adminClient();
        try {
          const found = await probe.query(`
            SELECT pid FROM pg_stat_activity
            WHERE datname = $1 AND application_name = 'spool-local-runner' AND wait_event_type = 'Lock'
            ORDER BY backend_start DESC LIMIT 1
          `, [database]);
          victimPid = found.rows[0]?.pid ?? null;
        } finally { await probe.end(); }
        if (victimPid == null) await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(victimPid, 'blocked COPY backend must appear in pg_stat_activity');
      const cancelled = await terminateBackendByPid({ ref: dbRef(), credentialBroker: broker, pid: victimPid, cancel: true });
      assert.equal(cancelled.cancelled, true);
      const commitError = await commitAttempt;
      assert.ok(commitError, 'cancelled COPY must reject the commit');
      assert.equal(commitError.code, 'CREDENTIAL_CALLBACK_FAILED');
      assert.match(commitError.message, /canceling statement due to user request/);
      await blocker.query('ROLLBACK');
    } finally { await blocker.end(); }

    const afterCancel = await adminClient();
    try {
      const count = await afterCancel.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, 0);
    } finally { await afterCancel.end(); }
    const reconciled = await target.reconcileTargetCommit({
      batchIdentity, migrationId: 'pg_ref_recovery_001', planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID, mappingRevision: 1,
      payloadHash: target.describeBatch({ rows }).payloadHash, rowCount: rows.length
    });
    assert.equal(reconciled.status, 'NOT_COMMITTED');

    const retried = await target.commitBulkBatch(input);
    assert.equal(retried.status, 'COMMITTED_EXACT');
    assert.equal(retried.alreadyCommitted, false);
    assert.equal(retried.rowCount, rows.length);
    const verify = await adminClient();
    try {
      const count = await verify.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, rows.length);
    } finally { await verify.end(); }
  } finally {
    const cleanup = await adminClient();
    try { await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } finally { await cleanup.end(); }
  }
});

test('batch replay after interruption is idempotent and conflicting identity reuse is rejected', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'ref_recovery_replay';
  const batchIdentity = `sha256:${'e'.repeat(64)}`;
  await resetRecoveryTable(table, [batchIdentity]);

  const target = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker });
  const rows = makeRows(1, 50);
  try {
    const first = await target.commitBulkBatch(batchInput(rows, batchIdentity));
    assert.equal(first.status, 'COMMITTED_EXACT');
    assert.equal(first.alreadyCommitted, false);
    const replay = await target.commitBulkBatch(batchInput(rows, batchIdentity));
    assert.equal(replay.status, 'COMMITTED_EXACT');
    assert.equal(replay.alreadyCommitted, true);
    assert.equal(replay.batchIdentity, first.batchIdentity);
    assert.equal(replay.payloadHash, first.payloadHash);
    const conflicting = makeRows(1_000, 50);
    await assert.rejects(target.commitBulkBatch(batchInput(conflicting, batchIdentity)), /BATCH_IDENTITY_CONFLICT/);
    const check = await adminClient();
    try {
      const count = await check.query(`SELECT count(*)::int AS n FROM public."${table}"`);
      assert.equal(count.rows[0].n, rows.length);
    } finally { await check.end(); }
  } finally {
    const cleanup = await adminClient();
    try { await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } finally { await cleanup.end(); }
  }
});

test('dead worker lease is stolen after expiry and the stale fence is rejected at the commit boundary', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'ref_recovery_fence';
  const resource = 'ref-recovery-fence-lease';
  const fenceIdentity = `sha256:${'f'.repeat(64)}`;
  await resetRecoveryTable(table, [fenceIdentity]);
  const setup = await adminClient();
  try {
    await setup.query('DELETE FROM spool_internal.execution_leases WHERE resource = $1', [resource]);
  } finally { await setup.end(); }

  try {
    const dead = await claimWorkerLease({ ref: dbRef(), credentialBroker: broker, resource, workerId: 'worker-dead', ttlMs: 1200 });
    assert.equal(dead.status, 'ACQUIRED');
    await new Promise(resolve => setTimeout(resolve, 1800));
    const live = await claimWorkerLease({ ref: dbRef(), credentialBroker: broker, resource, workerId: 'worker-live', ttlMs: 60_000 });
    assert.equal(live.status, 'ACQUIRED');
    assert.equal(live.owner, 'worker-live');
    assert.ok(live.fencingToken > dead.fencingToken, 'steal must advance the fencing token');
    const described = await describeWorkerLease({ ref: dbRef(), credentialBroker: broker, resource });
    assert.equal(described.owner, 'worker-live');

    const staleTarget = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: resource, fenceOwner: 'worker-dead' });
    const rows = makeRows(1, 10);
    await assert.rejects(
      staleTarget.commitBulkBatch({ ...batchInput(rows, fenceIdentity), fencingToken: dead.fencingToken }),
      /STALE_FENCE/
    );
    const liveTarget = new PostgresTarget({ targetRef: tableRef(table), credentialBroker: broker, requireFencing: true, fenceResource: resource, fenceOwner: 'worker-live' });
    const committed = await liveTarget.commitBulkBatch({ ...batchInput(rows, fenceIdentity), fencingToken: live.fencingToken });
    assert.equal(committed.status, 'COMMITTED_EXACT');
  } finally {
    const cleanup = await adminClient();
    try { await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } finally { await cleanup.end(); }
  }
});

test('destination reconnect after backend loss reports a real RTO and resumes writes', { skip: !enabled, timeout: 120_000 }, async () => {
  const resumeTable = 'ref_soak_resume';
  const setup = await adminClient();
  try {
    await setup.query(`DROP TABLE IF EXISTS public."${resumeTable}" CASCADE`);
    await setup.query(`CREATE TABLE public."${resumeTable}" (a integer PRIMARY KEY, b text NOT NULL)`);
  } finally { await setup.end(); }

  const started = performance.now();
  await broker.withSecret(secretRef, async secret => {
    const parsed = parsePostgresEndpoint(endpoint);
    const victim = new Client({ host: parsed.host, port: parsed.port, database, user, password: secret, ssl: false });
    victim.on('error', () => {});
    await victim.connect();
    const pidRow = await victim.query('SELECT pg_backend_pid() AS pid');
    const terminated = await terminateBackendByPid({ ref: dbRef(), credentialBroker: broker, pid: pidRow.rows[0].pid });
    assert.equal(terminated.terminated, true);
    try { await victim.end(); } catch { /* closed by terminate */ }
  });
  const reconnected = await adminClient();
  try {
    const probe = await reconnected.query('SELECT 1 AS ok');
    assert.equal(probe.rows[0].ok, 1);
  } finally { await reconnected.end(); }
  const rtoMs = Math.round(performance.now() - started);
  const record = recordRpoRto({ name: 'destination-reconnect', rpoMs: 0, rtoMs });
  assert.ok(record.rtoMs >= 0);

  const plan = createSoakPlan({ rounds: 1, batchSize: 20, uniqueStart: 0, uniqueEnd: 100, writers: 1 });
  const round = await runSoakRound({ ref: dbRef(), credentialBroker: broker, plan, round: 1, writerIndex: 0, table: resumeTable });
  assert.equal(round.rows, plan.batchSize);
  const check = await adminClient();
  try {
    const count = await check.query(`SELECT count(*)::int AS n FROM public."${resumeTable}"`);
    assert.equal(count.rows[0].n, plan.batchSize);
    await check.query(`DROP TABLE public."${resumeTable}" CASCADE`);
  } finally { await check.end(); }
});

test('scale verify detects tamper and loss, repair restores exact content', { skip: !enabled, timeout: 180_000 }, async () => {
  const table = 'ref_recovery_verify';
  const batchIdentity = `sha256:${'9'.repeat(64)}`;
  await resetRecoveryTable(table, [batchIdentity]);

  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: 60_000 });
  const preflight = await inspectPostgresTarget({ targetRef: tableRef(table), targetSchema: targetSchema(), credentialBroker: broker });
  const execution = runtime.createExecution({ migrationId: 'pg_ref_recovery_002', targetRef: tableRef(table) });
  const rows = makeRows(1, 500);
  try {
    const lease = await execution.renewLease();
    const target = execution.openTarget();
    const committed = await target.commitBulkBatch({
      ...batchInput(rows, batchIdentity), fencingToken: lease.fencingToken, targetContractId: preflight.targetContractId
    });
    assert.equal(committed.status, 'COMMITTED_EXACT');

    const clean = await verifyPostgresContent({
      targetRef: tableRef(table), credentialBroker: broker, expectedRows: rows,
      targetSchema: targetSchema(), targetContractId: preflight.targetContractId
    });
    assert.equal(clean.status, 'VERIFIED');

    const tamper = await adminClient();
    try {
      await tamper.query(`UPDATE public."${table}" SET name = 'tampered' WHERE id = 7`);
      await tamper.query(`DELETE FROM public."${table}" WHERE id = 13`);
    } finally { await tamper.end(); }

    const diffed = await verifyPostgresContent({
      targetRef: tableRef(table), credentialBroker: broker, expectedRows: rows,
      targetSchema: targetSchema(), targetContractId: preflight.targetContractId
    });
    assert.equal(diffed.status, 'DIFF');
    assert.deepEqual(diffed.diff.counts, { missing: 1, mismatch: 1, unexpected: 0 });
    assert.equal(diffed.diff.total, 2);

    const plan = createRepairPlan({
      verification: diffed,
      migrationId: 'pg_ref_recovery_002',
      planId: PLAN_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      targetIdentity: connectorIdentity(tableRef(table)),
      targetContractId: preflight.targetContractId
    });
    assert.equal(plan.operations.length, 2);
    for (const operation of plan.operations) {
      const applied = await target.applyRepairOperation({
        primaryKey: ['id'],
        targetSchema: targetSchema(),
        operation,
        fencingToken: lease.fencingToken,
        targetContractId: preflight.targetContractId
      });
      assert.equal(applied.applied, true);
    }

    const repaired = await verifyPostgresContent({
      targetRef: tableRef(table), credentialBroker: broker, expectedRows: rows,
      targetSchema: targetSchema(), targetContractId: preflight.targetContractId
    });
    assert.equal(repaired.status, 'VERIFIED');
    assert.equal(repaired.diff.total, 0);
  } finally {
    const cleanup = await adminClient();
    try { await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } finally { await cleanup.end(); }
  }
});

test('CDC soak keeps LSN order under concurrent writers and the meter counts every insert', { skip: !enabled, timeout: 300_000 }, async () => {
  const table = 'ref_cdc_soak';
  const publicationName = 'ref_pub_cdc_soak';
  const slotName = 'ref_cdc_soak';
  const setup = await adminClient();
  try {
    await setup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await setup.query(`DROP PUBLICATION IF EXISTS ${publicationName}`);
    await setup.query(`CREATE TABLE public."${table}" (a integer PRIMARY KEY, b text NOT NULL)`);
  } finally { await setup.end(); }
  await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  await ensurePostgresPublication({ ref: dbRef(), credentialBroker: broker, publicationName, tables: [{ schema: 'public', table }] });
  const slot = await createPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  assert.equal(slot.existed, false);

  const writers = 2;
  const rounds = 2;
  const batchSize = 25;
  const totalRows = writers * rounds * batchSize;
  const writer = await adminClient();
  try {
    let key = 0;
    for (let round = 0; round < rounds; round += 1) {
      for (let w = 0; w < writers; w += 1) {
        const values = [];
        const placeholders = [];
        for (let i = 0; i < batchSize; i += 1) {
          values.push(key, `cdc-soak-${key}`);
          placeholders.push(`($${values.length - 1}, $${values.length})`);
          key += 1;
        }
        await writer.query(`INSERT INTO public."${table}"(a,b) VALUES ${placeholders.join(', ')}`, values);
      }
    }
  } finally { await writer.end(); }

  const flush = await adminClient();
  let untilLsn;
  try {
    const result = await flush.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    untilLsn = result.rows[0].lsn;
  } finally { await flush.end(); }

  const meter = createCdcSoakMeter({ windowMs: 60_000, rowsPerTick: totalRows });
  const streamed = await streamPostgresChanges({
    ref: dbRef(), credentialBroker: broker, slotName, publicationNames: [publicationName],
    startLsn: slot.lsn, untilLsn, maxMessages: totalRows + 10,
    onChange: change => { meter.note(change); }
  });
  const inserts = streamed.changes.filter(change => change.tag === 'insert' && change.table === table);
  assert.equal(inserts.length, totalRows);
  assert.equal(meter.snapshot().rows, totalRows);
  const seen = new Set(inserts.map(change => change.row.a));
  assert.equal(seen.size, totalRows);
  const lsns = inserts.map(change => change.lsn);
  for (let index = 1; index < lsns.length; index += 1) {
    assert.ok(comparePostgresLsn(lsns[index - 1], lsns[index]) <= 0, 'soak change stream LSNs advance monotonically');
  }

  await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName });
  const cleanup = await adminClient();
  try {
    await cleanup.query(`DROP PUBLICATION IF EXISTS ${publicationName}`);
    await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
  } finally { await cleanup.end(); }
});
