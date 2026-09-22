import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { SpoolCommandService } from '../../src/daemon/command-service.js';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';

// Cutover crash matrix: kill (service close = process-equivalent death; no
// in-memory state survives) at every recovery window, resume with a FRESH
// service instance on the same durable statePath, and prove deterministic
// reconstruction: same attempt identity, no duplicate cutover decision, no
// missing verification, exact final state.
//
// Windows covered:
//   1. after arm, before commit (CUTOVER_ARMED)
//   2. commit retry after a faulted first attempt (aborted attempt -> rearm)
//   3. after commit, before completion read (COMMITTED idempotent replay)
// Real SIGKILL fidelity (in-flight transaction abort) is additionally owned
// by PostgreSQL atomicity; these tests prove SPOOL-side resume determinism.

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

const SOURCE_TABLE = 'spool_cutover_crash_src';
const TARGET_TABLE = 'spool_cutover_crash_dst';

async function adminClient() {
  const url = new URL(endpoint);
  const client = new Client({ host: url.hostname, port: Number(url.port || 5432), database, user, password, ssl: false });
  await client.connect();
  return client;
}

function pgRef(table, connectionId) {
  return {
    connector: 'postgres', connectionId, resource: `public.${table}`, endpoint, database,
    schema: 'public', table, identity: { user }, secretRef
  };
}

function migrationRequest(migrationId) {
  return {
    migrationId,
    principal: 'operator:cutover-crash-matrix',
    planInput: {
      planRevision: 1,
      sourceRef: pgRef(SOURCE_TABLE, 'pg-crash-source'),
      targetRef: pgRef(TARGET_TABLE, 'pg-crash-target'),
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
}

async function reset() {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP TABLE IF EXISTS public."${SOURCE_TABLE}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${TARGET_TABLE}" CASCADE`);
    await client.query(`CREATE TABLE public."${SOURCE_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${TARGET_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= 5; id += 1) {
      await client.query(`INSERT INTO public."${SOURCE_TABLE}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
    }
  } finally { await client.end(); }
}

async function operatorBarrier(service, request) {
  return service.attestCutoverBarrier(request, {
    statement: 'Crash-matrix fixture has no active source writers during the cutover attempt.',
    routingDecision: 'fixture keeps source writes disabled through cutover completion'
  });
}

async function tableRows(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`SELECT id,name FROM public."${table}" ORDER BY id`);
    return result.rows.map(row => ({ id: Number(row.id), name: row.name }));
  } finally { await client.end(); }
}

async function fixtureDir() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-pg-cutover-crash-'));
  const sourceRoot = join(dir, 'source-root');
  const targetRoot = join(dir, 'target-root');
  const snapshotDir = join(dir, 'snapshots');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  return { dir, sourceRoot, targetRoot, snapshotDir, statePath: join(targetRoot, 'spool-state.db') };
}

// Windows releases file locks asynchronously (and AV scanners wedge
// just-closed SQLite files for many seconds): retry, then give up without
// failing the test — a leftover temp dir is litter, not a correctness
// failure. Cleanup must never convert a passing test into a failure.
async function removeDirTree(dir) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

function serviceOptions(f, faultInjector = null) {
  return {
    sourceRoot: f.sourceRoot, targetRoot: f.targetRoot, snapshotDir: f.snapshotDir, statePath: f.statePath,
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.2.0-test', commitSha: '2123456789abcdef0123456789abcdef01234567' },
    faultInjector
  };
}

function oneShotFault(point) {
  let fired = false;
  return {
    hit: async current => {
      if (!fired && current === point) {
        fired = true;
        return true;
      }
      return false;
    }
  };
}

async function loadAndArm(service, migrationId) {
  const request = migrationRequest(migrationId);
  const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: `crash-${migrationId}` });
  const result = await service.run(request, { approval });
  assert.equal(result.status, 'COMPLETE');
  const armed = await service.beginCutover(request, { receipt: result.receipt });
  assert.equal(armed.status, 'ARMED');
  return { request, receipt: result.receipt, attemptId: armed.cutoverAttemptId };
}

test('crash after arm resumes with the same attempt identity and commits once', { skip: !enabled, timeout: 300_000 }, async () => {
  await reset();
  const f = await fixtureDir();
  try {
    const migrationId = 'pg_cutover_crash_armed';
    const first = await SpoolCommandService.create(serviceOptions(f));
    const { request, attemptId } = await loadAndArm(first, migrationId);
    // Crash: close without committing. Nothing in memory survives.
    first.close();

    const second = await SpoolCommandService.create(serviceOptions(f));
    try {
      const resumed = second.cutover(migrationId);
      assert.equal(resumed.cutoverAttemptId, attemptId);
      assert.equal(resumed.status, 'ARMED');
      const committed = await second.commitCutover(request, { sourceBarrier: await operatorBarrier(second, request) });
      assert.equal(committed.status, 'COMMITTED');
      assert.equal(committed.cutoverAttemptId, attemptId);
      // Idempotent replay: committing again returns the same decision.
      const replay = await second.commitCutover(request);
      assert.equal(replay.status, 'COMMITTED');
      assert.equal(replay.cutoverAttemptId, attemptId);
      assert.deepEqual(await tableRows(TARGET_TABLE), await tableRows(SOURCE_TABLE));
    } finally { second.close(); }
  } finally { await removeDirTree(f.dir); }
});

test('aborted attempt requires rearm with a fresh attempt identity', { skip: !enabled, timeout: 300_000 }, async () => {
  await reset();
  const f = await fixtureDir();
  try {
    const migrationId = 'pg_cutover_crash_rearm';
    const first = await SpoolCommandService.create(serviceOptions(f));
    const { request, attemptId } = await loadAndArm(first, migrationId);
    const staleBarrier = await operatorBarrier(first, request);
    const aborted = await first.abortCutover(migrationId, { reason: 'simulated operator abort before commit' });
    assert.equal(aborted.status, 'ABORTED');
    first.close();

    const second = await SpoolCommandService.create(serviceOptions(f));
    try {
      // A commit on the aborted attempt is refused, never silently resumed.
      await assert.rejects(() => second.commitCutover(request), /CUTOVER_NOT_ARMED/);
      const receipt = second.receipt(migrationId);
      const rearmed = await second.rearmCutover(request, { receipt, reason: 'resume after abort' });
      assert.equal(rearmed.status, 'ARMED');
      assert.notEqual(rearmed.cutoverAttemptId, attemptId);
      await assert.rejects(
        () => second.commitCutover(request, { sourceBarrier: staleBarrier }),
        error => error?.code === 'CUTOVER_SOURCE_BARRIER_ATTEMPT_MISMATCH'
      );
      const committed = await second.commitCutover(request, { sourceBarrier: await operatorBarrier(second, request) });
      assert.equal(committed.status, 'COMMITTED');
      assert.equal(committed.cutoverAttemptId, rearmed.cutoverAttemptId);
      assert.deepEqual(await tableRows(TARGET_TABLE), await tableRows(SOURCE_TABLE));
    } finally { second.close(); }
  } finally { await removeDirTree(f.dir); }
});


test('crash matrix resumes deterministically from every durable cutover boundary', { skip: !enabled, timeout: 900_000 }, async () => {
  const cases = [
    {
      point: 'CUTOVER_AFTER_FINAL_VERIFY_BEFORE_COMMIT',
      code: 'FAULT_CUTOVER_AFTER_FINAL_VERIFY_BEFORE_COMMIT',
      expectedState: 'FINAL_VERIFY',
      expectedCutoverStatus: 'ARMED'
    },
    {
      point: 'CUTOVER_AFTER_COMMIT_BEFORE_POST_VERIFY',
      code: 'FAULT_CUTOVER_AFTER_COMMIT_BEFORE_POST_VERIFY',
      expectedState: 'CUTOVER_COMMITTED',
      expectedCutoverStatus: 'COMMITTED'
    },
    {
      point: 'CUTOVER_AFTER_POST_VERIFY_BEFORE_COMPLETE',
      code: 'FAULT_CUTOVER_AFTER_POST_VERIFY_BEFORE_COMPLETE',
      expectedState: 'POST_CUTOVER_VERIFY',
      expectedCutoverStatus: 'COMMITTED'
    }
  ];

  for (const entry of cases) {
    await reset();
    const f = await fixtureDir();
    const migrationId = `pg_cutover_boundary_${entry.point.toLowerCase()}`;
    let first = null;
    let second = null;
    try {
      first = await SpoolCommandService.create(serviceOptions(f, oneShotFault(entry.point)));
      const { request, attemptId } = await loadAndArm(first, migrationId);
      const sourceBarrier = await operatorBarrier(first, request);

      await assert.rejects(
        () => first.commitCutover(request, { sourceBarrier }),
        error => error?.code === entry.code
      );

      const durable = first.runs.getMigrationState(migrationId);
      assert.equal(durable.currentState, entry.expectedState, entry.point);
      const interrupted = first.cutover(migrationId);
      assert.equal(interrupted.status, entry.expectedCutoverStatus, entry.point);
      assert.equal(interrupted.cutoverAttemptId, attemptId, entry.point);

      // Process-equivalent restart: all in-memory locks, clients and service
      // objects are discarded. The same durable state file is reopened by a
      // clean service with no fault injector.
      first.close();
      first = null;

      second = await SpoolCommandService.create(serviceOptions(f));
      const resumedBefore = second.runs.getMigrationState(migrationId);
      assert.equal(resumedBefore.currentState, entry.expectedState, entry.point);

      // Recovery must mint fresh freeze evidence. This is especially
      // important after CUTOVER_COMMITTED: retaining a stale in-memory barrier
      // is not a recovery requirement.
      const recoveryBarrier = await operatorBarrier(second, request);
      const recovered = await second.commitCutover(request, { sourceBarrier: recoveryBarrier });
      assert.equal(recovered.status, 'COMMITTED', entry.point);
      assert.equal(recovered.cutoverAttemptId, attemptId, entry.point);
      assert.equal(second.runs.getMigrationState(migrationId).currentState, 'COMPLETED', entry.point);
      assert.deepEqual(await tableRows(TARGET_TABLE), await tableRows(SOURCE_TABLE), entry.point);
    } finally {
      try { first?.close(); } catch {}
      try { second?.close(); } catch {}
      await removeDirTree(f.dir);
    }
  }
});
