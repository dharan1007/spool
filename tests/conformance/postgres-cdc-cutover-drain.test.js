import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { parsePostgresEndpoint } from '../../src/connectors/postgres/connection.js';
import { dropPostgresReplicationSlot } from '../../src/connectors/postgres/cdc.js';
import { SpoolCommandService } from '../../src/daemon/command-service.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);

const SOURCE_TABLE = 'spool_cutover_drain_src';
const TARGET_TABLE = 'spool_cutover_drain_dst';
const SLOT = 'spool_cutover_drain_slot';
const PUBLICATION = 'spool_cutover_drain_pub';
const MIGRATION_ID = 'spool_cutover_drain_001';

async function adminClient() {
  const parsed = parsePostgresEndpoint(endpoint);
  const client = new Client({ host: parsed.host, port: parsed.port, database, user, password, ssl: false });
  await client.connect();
  return client;
}

async function cleanup() {
  const client = await adminClient();
  try {
    await client.query('DROP SCHEMA IF EXISTS spool_internal CASCADE');
    await client.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await client.query(`DROP TABLE IF EXISTS public."${SOURCE_TABLE}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public."${TARGET_TABLE}" CASCADE`);
    await dropPostgresReplicationSlot({
      ref: { endpoint, database, identity: { user }, secretRef: { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' } },
      credentialBroker: { withSecret: async (ref, fn) => fn(password) },
      slotName: SLOT
    }).catch(() => {});
  } finally { await client.end(); }
}

async function reset() {
  await cleanup();
  const client = await adminClient();
  try {
    await client.query(`CREATE TABLE public."${SOURCE_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE public."${TARGET_TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
    for (let id = 1; id <= 5; id += 1) {
      await client.query(`INSERT INTO public."${SOURCE_TABLE}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
    }
  } finally { await client.end(); }
}

async function writeRows(ids) {
  const client = await adminClient();
  try {
    for (const id of ids) {
      await client.query(`INSERT INTO public."${SOURCE_TABLE}"(id,name) VALUES ($1,$2)`, [id, `source-${id}`]);
    }
  } finally { await client.end(); }
}

async function tableRows(table) {
  const client = await adminClient();
  try {
    const result = await client.query(`SELECT id FROM public."${table}" ORDER BY id`);
    return result.rows.map(row => Number(row.id));
  } finally { await client.end(); }
}

function migrationRequest() {
  const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
  const pgRef = (table, connectionId) => ({
    connector: 'postgres', connectionId, resource: `public.${table}`, endpoint, database,
    schema: 'public', table, identity: { user }, secretRef
  });
  return {
    migrationId: MIGRATION_ID,
    principal: 'operator:postgres-cdc-cutover-drain',
    planInput: {
      planRevision: 1,
      sourceRef: pgRef(SOURCE_TABLE, 'pg-cutover-drain-source'),
      targetRef: pgRef(TARGET_TABLE, 'pg-cutover-drain-target'),
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

test('cutover final drain: armed cutover freezes catch-up, then the final drain converges a quiesced CDC source in bounded time through the canonical FINAL_DRAIN transition', { skip: !enabled, timeout: 300_000 }, async () => {
  await reset();
  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-cutover-drain-'));
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
    const request = migrationRequest();
    await service.inspect(request);
    const record = await service.establishCdcBoundary(request, { slotName: SLOT, publicationName: PUBLICATION });
    assert.ok(record.consistentPoint, 'the CDC boundary must reserve WAL before approval');
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'cutover-drain-1' });
    await writeRows([6, 7, 8]);
    const result = await service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');

    // Arm the cutover attempt: from here the only drain that may run is the
    // final drain inside commitCutover — operator catch-up is frozen so no
    // stream work can race the armed decision.
    const armed = await service.beginCutover(request, { receipt: result.receipt });
    assert.equal(armed.status, 'ARMED');
    assert.ok(armed.cutoverAttemptId, 'the armed attempt must carry an identity');
    await assert.rejects(
      () => service.catchUpCdc(request, { drainStallTimeoutMs: 1000 }),
      error => {
        assert.equal(error.code, 'CDC_NOT_RUNNING');
        return true;
      },
      'operator catch-up must be frozen while the cutover is armed'
    );

    // Commit with a quiesced source: the final drain reaches the
    // barrier-captured waterline via transaction commits plus server
    // keepalive heartbeats. The original defect class was this exact
    // drain hanging forever; a healthy drain must terminate promptly and
    // must never resolve by timeout.
    const barrier = await service.attestCutoverBarrier(request, {
      statement: 'Cutover-drain fixture has no active source writers during the cutover attempt.',
      routingDecision: 'fixture keeps source writes disabled through cutover completion'
    });
    const startedAt = Date.now();
    const committed = await service.commitCutover(request, { sourceBarrier: barrier });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(committed.status, 'COMMITTED');
    assert.equal(committed.cutoverAttemptId, armed.cutoverAttemptId, 'commit must reuse the armed attempt identity');
    assert.ok(elapsedMs < 120_000, `final drain of a quiesced source must finish promptly, took ${elapsedMs}ms`);

    // The stream applied the post-boundary backlog before/during drain:
    // target converges exactly, no missing or duplicated rows.
    assert.deepEqual(await tableRows(TARGET_TABLE), [1, 2, 3, 4, 5, 6, 7, 8]);

    // The final drain is a durable, observable phase: a FINAL_DRAIN
    // transition recorded under the canonical cutover command identity for
    // this attempt, not a side effect buried in the commit.
    const finalDrain = service.runs.findTransitionByCommand(
      request.migrationId,
      `cutover:${armed.cutoverAttemptId}:final-drain`
    );
    assert.ok(finalDrain, 'the final drain must run under its canonical cutover command identity');
    assert.equal(finalDrain.nextState, 'FINAL_DRAIN');
    assert.equal(finalDrain.reason, 'final drain');
    const transitions = service.runs.listTransitions(request.migrationId);
    assert.ok([...transitions].reverse().some(t => t.nextState === 'FINAL_DRAIN'), 'the commit must durably enter FINAL_DRAIN');

    // The drain recorded durable CDC progress through the binding — the
    // watermark the next resume would use.
    const binding = service.snapshotCdcBinding(request.migrationId);
    assert.ok(binding.appliedLsn, 'the final drain must leave a durable applied watermark');
  } finally {
    if (service) service.close();
    await cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
