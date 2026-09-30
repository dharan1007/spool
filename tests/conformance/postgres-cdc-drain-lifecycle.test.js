import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
import { SpoolCommandService } from '../../src/daemon/command-service.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();
broker.withSecret = async (ref, fn) => fn(password);

const PROBE_TABLE = 'spool_cdc_drain_probe_src';
const PROBE_SLOT = 'spool_cdc_drain_probe_slot';
const PROBE_PUBLICATION = 'spool_cdc_drain_probe_pub';
const SVC_SOURCE_TABLE = 'spool_cdc_drain_svc_src';
const SVC_TARGET_TABLE = 'spool_cdc_drain_svc_dst';
const SVC_SLOT = 'spool_cdc_drain_svc_slot';
const SVC_PUBLICATION = 'spool_cdc_drain_svc_pub';
const PLAN_ID = `sha256:${'c'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'d'.repeat(64)}`;
// Unreachable waterline: valid LSN syntax beyond any real WAL position, so a
// healthy quiesced stream can never satisfy it. With heartbeats deliberately
// not counting as progress, the only terminations are DRAIN_BLOCKED (bounded)
// or nothing (unbounded) — the exact section-13 hang class, deterministic.
const UNREACHABLE_WATERLINE = 'FFFFFE00/FFFFFE00';

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

function probeRef() {
  return {
    connector: 'postgres', connectionId: 'pg-cdc-drain', resource: `public.${PROBE_TABLE}`,
    endpoint, database, schema: 'public', table: PROBE_TABLE, identity: { user }, secretRef
  };
}

function pgRef(table, connectionId) {
  return {
    connector: 'postgres', connectionId, resource: `public.${table}`, endpoint, database,
    schema: 'public', table, identity: { user }, secretRef
  };
}

async function adminClient() {
  const parsed = parsePostgresEndpoint(endpoint);
  const client = new Client({ host: parsed.host, port: parsed.port, database, user, password, ssl: false });
  await client.connect();
  return client;
}

async function resetProbe() {
  const client = await adminClient();
  try {
    await client.query(`DROP TABLE IF EXISTS public."${PROBE_TABLE}" CASCADE`);
    await client.query(`DROP PUBLICATION IF EXISTS ${PROBE_PUBLICATION}`);
    await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: PROBE_SLOT }).catch(() => {});
    await client.query(`CREATE TABLE public."${PROBE_TABLE}" (id integer PRIMARY KEY, payload text NOT NULL)`);
    await client.query(`ALTER TABLE public."${PROBE_TABLE}" REPLICA IDENTITY FULL`);
    await ensurePostgresPublication({ ref: dbRef(), credentialBroker: broker, publicationName: PROBE_PUBLICATION, tables: [{ schema: 'public', table: PROBE_TABLE }] });
    const slot = await createPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: PROBE_SLOT });
    assert.equal(slot.existed, false);
    for (let id = 1; id <= 2; id += 1) {
      await client.query(`INSERT INTO public."${PROBE_TABLE}"(id,payload) VALUES ($1,$2)`, [id, `probe-${id}`]);
    }
  } finally { await client.end(); }
}

async function cleanupProbe() {
  const client = await adminClient();
  try {
    await client.query(`DROP PUBLICATION IF EXISTS ${PROBE_PUBLICATION}`);
    await client.query(`DROP TABLE IF EXISTS public."${PROBE_TABLE}" CASCADE`);
    await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: PROBE_SLOT }).catch(() => {});
  } finally { await client.end(); }
}

async function resetService() {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${SVC_SOURCE_TABLE}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${SVC_TARGET_TABLE}" CASCADE`);
    await client.query(`DROP PUBLICATION IF EXISTS ${SVC_PUBLICATION}`);
    await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: SVC_SLOT }).catch(() => {});
    await client.query(`CREATE TABLE public."${SVC_SOURCE_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${SVC_TARGET_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= 5; id += 1) {
      await client.query(`INSERT INTO public."${SVC_SOURCE_TABLE}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
    }
  } finally { await client.end(); }
}

async function cleanupService() {
  const client = await adminClient();
  try {
    await client.query(`DROP PUBLICATION IF EXISTS ${SVC_PUBLICATION}`);
    await client.query(`DROP TABLE IF EXISTS public."${SVC_SOURCE_TABLE}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${SVC_TARGET_TABLE}" CASCADE`);
    await dropPostgresReplicationSlot({ ref: dbRef(), credentialBroker: broker, slotName: SVC_SLOT }).catch(() => {});
  } finally { await client.end(); }
}

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

function probeApplier({ checkpoint, untilLsn, maxTransactions = null, drainStallTimeoutMs, maxReconnects = 5 }) {
  let applied = 0;
  const target = {
    async commitCdcTransaction({ mutations }) {
      let rows = 0;
      for await (const mutation of mutations) {
        if (mutation.op === 'upsert') rows += 1;
      }
      applied += 1;
      return { inserted: rows, updated: 0, deleted: 0, skippedMissingCount: 0, alreadyCommitted: false };
    }
  };
  const applier = createCdcApplier({
    ref: dbRef(),
    credentialBroker: broker,
    slotName: PROBE_SLOT,
    publicationNames: [PROBE_PUBLICATION],
    migration: { migrationId: 'spool_cdc_drain_probe_001', sourceSnapshotId: SNAPSHOT_ID },
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
      targetRef: probeRef()
    },
    targetContractId: 'test-contract-drain-lifecycle',
    primaryKey: ['id'],
    sourceTable: { schema: 'public', table: PROBE_TABLE },
    target,
    checkpoint,
    renewFence: async () => 7,
    ownerEpoch: 'test-epoch-drain',
    startLsn: null,
    untilLsn,
    maxTransactions,
    drainStallTimeoutMs,
    maxReconnects,
    stagingDir: null
  });
  return { applier, applied: () => applied };
}

const LSN_PATTERN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;

test('bounded drain with an unreachable waterline fails DRAIN_BLOCKED with the full capture set, never success', { skip: !enabled, timeout: 300_000 }, async () => {
  await resetProbe();
  try {
    const checkpoint = memoryCheckpoint();
    const { applier } = probeApplier({ checkpoint, untilLsn: UNREACHABLE_WATERLINE, drainStallTimeoutMs: 500 });
    const startedAt = Date.now();
    await assert.rejects(
      () => applier.run(),
      error => {
        assert.equal(error.code, 'DRAIN_BLOCKED');
        const details = error.details;
        // Section 13 capture set: why progress stopped, durably observable.
        assert.equal(details.waterline, UNREACHABLE_WATERLINE);
        assert.equal(details.slotName, PROBE_SLOT);
        assert.equal(details.drainStallTimeoutMs, 500);
        assert.ok(details.stalledMs >= 500, `stalledMs ${details.stalledMs} must cover the stall window`);
        assert.equal(details.queueDepth, 0);
        assert.equal(details.openTransaction, false);
        assert.equal(details.reconnects, 0);
        assert.equal(details.streamState, 'streaming');
        assert.equal(details.appliedTransactions, 2);
        assert.ok(details.lastAppliedPosition !== null && LSN_PATTERN.test(details.lastAppliedPosition));
        assert.ok(details.lastQueuedTransaction !== null);
        assert.ok(LSN_PATTERN.test(details.lastQueuedTransaction.lsn));
        assert.ok(details.lastCapturedPosition === null || LSN_PATTERN.test(details.lastCapturedPosition));
        assert.ok(details.durableCheckpoint !== null);
        assert.ok(LSN_PATTERN.test(details.durableCheckpoint.appliedLsn));
        assert.equal(details.durableCheckpoint.appliedLsn, details.lastAppliedPosition);
        assert.ok(Object.hasOwn(details, 'lastAcknowledgedPosition'));
        assert.ok(LSN_PATTERN.test(details.resumeLsn ?? '') || details.resumeLsn === null);
        return true;
      }
    );
    // A timeout must never convert an unresolved drain into success: the run
    // rejected, and it did so inside a bounded multiple of the stall window.
    assert.ok(Date.now() - startedAt < 60_000, 'DRAIN_BLOCKED must fire promptly after the stall window');
    // The backlog itself was applied before the stall: progress resets the
    // watchdog, silence ends it.
    assert.equal(applier.metrics().appliedTransactions, 2);
  } finally {
    await cleanupProbe();
  }
});

test('continuous capture (unbounded run) is excluded from the stall watchdog and still ends only on stream failure', { skip: !enabled, timeout: 300_000 }, async () => {
  await resetProbe();
  try {
    const checkpoint = memoryCheckpoint();
    // maxReconnects: 0 — transport failures are terminal here so the test can
    // observe "ends only on stream failure" instead of watching a healthy
    // reconnect loop keep the capture alive forever.
    const { applier } = probeApplier({ checkpoint, untilLsn: null, maxTransactions: null, drainStallTimeoutMs: 300, maxReconnects: 0 });
    const runPromise = applier.run();
    let settled = false;
    runPromise.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(settled, false, 'unbounded capture must not be failed by the bounded-drain watchdog');
    }
    // End the stream the only legitimate way for an unbounded run: kill this
    // test's replication backend (matched by slot name so parallel tests are
    // untouched). The resulting transport failure — never DRAIN_BLOCKED —
    // must surface.
    const client = await adminClient();
    let killed = false;
    try {
      const result = await client.query('SELECT active_pid FROM pg_catalog.pg_replication_slots WHERE slot_name = $1 AND active_pid IS NOT NULL', [PROBE_SLOT]);
      if (result.rows.length > 0) {
        await client.query('SELECT pg_catalog.pg_terminate_backend($1)', [String(result.rows[0].active_pid)]);
        killed = true;
      }
    } finally { await client.end(); }
    assert.equal(killed, true, 'the test slot must own a replication backend to terminate');
    // Bounded wait: a stream failure must surface promptly — if the run is
    // still silent 30s after the kill, it hung and the test fails loudly
    // instead of hanging the suite.
    const outcome = await Promise.race([
      runPromise.then(() => ({ settled: 'resolved' }), error => ({ settled: 'rejected', error })),
      new Promise(resolve => {
        const timer = setTimeout(() => resolve({ settled: 'timeout' }), 30_000);
        timer.unref?.();
      })
    ]);
    assert.notEqual(outcome.settled, 'timeout', 'the run must end after a stream failure, never hang silently');
    assert.equal(outcome.settled, 'rejected', 'a stream failure must reject, not resolve');
    assert.notEqual(outcome.error.code, 'DRAIN_BLOCKED', 'an unbounded run must never report DRAIN_BLOCKED');
  } finally {
    await cleanupProbe();
  }
});

test('DRAIN_BLOCKED durably transitions the migration to FAILED_RECOVERABLE with reason and capture evidence', { skip: !enabled, timeout: 300_000 }, async () => {
  await resetService();
  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-drain-svc-'));
  await mkdir(join(dir, 'source-root'));
  await mkdir(join(dir, 'target-root'));
  let service = null;
  try {
    service = await SpoolCommandService.create({
      sourceRoot: join(dir, 'source-root'),
      targetRoot: join(dir, 'target-root'),
      snapshotDir: join(dir, 'snapshots'),
      statePath: join(dir, 'target-root', 'spool-state.db'),
      approvalSigningKey: '0123456789abcdef0123456789abcdef',
      release: { version: '1.2.0-test', commitSha: '2123456789abcdef0123456789abcdef01234567' }
    });

    const request = {
      migrationId: 'spool_cdc_drain_svc_001',
      principal: 'operator:postgres-cdc-drain',
      planInput: {
        planRevision: 1,
        sourceRef: pgRef(SVC_SOURCE_TABLE, 'pg-cdc-drain-source'),
        targetRef: pgRef(SVC_TARGET_TABLE, 'pg-cdc-drain-target'),
        targetSchema: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'name', type: 'string', nullable: false }
        ],
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
          { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
        ],
        mappingRevision: 1,
        writeStrategy: { mode: 'insert', batchSize: 2 },
        verification: { checks: ['row_accounting', 'ledger_complete', 'content_exact'] },
        risk: { level: 'medium', approvals: ['target_write'] },
        capabilityAssumptions: {
          source: { snapshotBinding: true, durableMaterialization: true },
          target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true, readAfterWriteVerification: true }
        }
      }
    };

    await service.inspect(request);
    const record = await service.establishCdcBoundary(request, { slotName: SVC_SLOT, publicationName: SVC_PUBLICATION });
    assert.equal(record.slotName, SVC_SLOT);
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'pg-cdc-drain' });
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    const readyState = service.runs.getMigrationState(request.migrationId);
    assert.equal(readyState.currentState, 'READY_FOR_CUTOVER');

    // A bounded drain against an unreachable waterline can no longer make
    // progress: it must fail DRAIN_BLOCKED (never hang, never succeed) and
    // durably explain why.
    await assert.rejects(
      () => service.catchUpCdc(request, { untilLsn: UNREACHABLE_WATERLINE, drainStallTimeoutMs: 1000 }),
      error => {
        assert.equal(error.code, 'DRAIN_BLOCKED', `unexpected rejection: ${error.message}`);
        assert.equal(error.details.waterline, UNREACHABLE_WATERLINE);
        assert.equal(error.details.slotName, SVC_SLOT);
        assert.ok(error.details.stalledMs >= 1000);
        return true;
      }
    );

    const durable = service.runs.getMigrationState(request.migrationId);
    assert.equal(durable.currentState, 'FAILED_RECOVERABLE');
    const transitions = service.runs.listTransitions(request.migrationId);
    const blocked = [...transitions].reverse().find(t => t.nextState === 'FAILED_RECOVERABLE');
    assert.ok(blocked, 'a durable transition must record the blocked drain');
    assert.equal(blocked.reason, 'DRAIN_BLOCKED');
    const evidence = blocked.evidence?.drainBlocked ?? {};
    assert.equal(evidence.waterline, UNREACHABLE_WATERLINE);
    assert.equal(evidence.durableStateBefore, 'READY_FOR_CUTOVER');
    assert.equal(evidence.phase, 'catch-up');
    assert.equal(evidence.cutoverStatus, null);
    assert.ok(evidence.lastAppliedPosition === null || LSN_PATTERN.test(evidence.lastAppliedPosition));
    assert.equal(evidence.slotName, SVC_SLOT);
    assert.ok(evidence.stalledMs >= 1000);
    assert.ok(Object.hasOwn(evidence, 'durableCheckpoint'));
    assert.equal(typeof evidence.queueDepth, 'number');
    assert.equal(typeof evidence.openTransaction, 'boolean');
    assert.equal(evidence.drainStallTimeoutMs, 1000);

    // Canonical model: the state is recoverable, not terminal, and the
    // failure reason is part of the durable record.
    assert.equal(durable.currentState, 'FAILED_RECOVERABLE');
  } finally {
    if (service) service.close();
    await cleanupService();
    await rm(dir, { recursive: true, force: true });
  }
});
