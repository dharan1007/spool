import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { SpoolCommandService } from '../../../src/daemon/command-service.js';
import { writeDatasetCsv, datasetId } from '../dataset.js';
import { LatencyHistogram, rowsPerSecond, mibPerSecond } from '../metrics.js';

export async function runTargetLoad({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.target.load';
  const startMonotonic = process.hrtime.bigint();
  const startWall = new Date().toISOString();
  const histogram = new LatencyHistogram();
  const failures = [];
  const metrics = {};

  // Prepare temp directories
  const sourceRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-source-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-target-'));
  const statePath = join(targetRoot, `state-${runId}.db`);
  const snapshotDir = join(tmpdir(), `spool-qualify-snap-${runId}`);
  const csvPath = join(sourceRoot, 'dataset.csv');

  let client;
  let service;
  const table = `qualify_target_${runId.replaceAll('-', '_').toLowerCase()}`;
  const datasetSeed = seed ?? `target-${runId}`;
  const rowCount = profile.rows;
  const payloadBytes = profile.payloadBytes;
  const batchSize = profile.batchSize;

  try {
    // 1. Generate deterministic dataset CSV
    const genStart = process.hrtime.bigint();
    const did = datasetId({ seed: datasetSeed, rowCount, payloadBytes });
    await writeDatasetCsv({ seed: datasetSeed, rowCount, payloadBytes, filePath: csvPath });
    const genMs = Number(process.hrtime.bigint() - genStart) / 1e6;
    evidenceWriter.appendRaw({ scenario, event: 'dataset_generated', datasetId: did, rowCount, payloadBytes, durationMs: genMs });

    // 2. Create PostgreSQL target table
    client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`
      CREATE TABLE public."${table}" (
        id integer PRIMARY KEY,
        tenant_id integer NOT NULL,
        external_id text NOT NULL,
        name text NOT NULL,
        email text NOT NULL,
        status text NOT NULL,
        integer_value text NOT NULL,
        decimal_value text NOT NULL,
        boolean_value text NOT NULL,
        timestamp_value text NOT NULL,
        nullable_value text,
        unicode_value text NOT NULL,
        json_value text NOT NULL,
        payload text NOT NULL,
        updated_at text NOT NULL
      )
    `);
    // Record target contract for later verification
    const contractRes = await client.query(`SELECT 'public.${table}'::regclass::oid as oid`);
    await client.end(); client = null;

    // 3. Create SpoolCommandService with real production path
    const broker = new CredentialBroker();
    // Mock broker to return password for our pgConfig
    broker.withSecret = async (ref, fn) => fn(pgConfig.password);

    service = await SpoolCommandService.create({
      sourceRoot,
      targetRoot,
      statePath,
      snapshotDir,
      approvalSigningKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      release: { version: '1.1.1', commitSha: process.env.SPOOL_COMMIT_SHA ?? '0000000000000000000000000000000000000000' },
      credentialBroker: broker,
      maxSourceBytes: 1024 * 1024 * 1024
    });

    const request = {
      migrationId: `qualify-target-${runId}`,
      principal: 'qualify:target-load',
      planInput: {
        planRevision: 1,
        sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'dataset.csv', path: csvPath },
        targetRef: { connector: 'postgres', connectionId: 'pg', resource: `public.${table}`, endpoint: `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`, database: pgConfig.database, schema: 'public', table, identity: { user: pgConfig.user }, secretRef: { provider: 'env', key: 'PGPASSWORD' } },
        targetSchema: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'tenant_id', type: 'integer', nullable: false },
          { name: 'external_id', type: 'string', nullable: false },
          { name: 'name', type: 'string', nullable: false },
          { name: 'email', type: 'string', nullable: false },
          { name: 'status', type: 'string', nullable: false },
          { name: 'integer_value', type: 'string', nullable: false },
          { name: 'decimal_value', type: 'string', nullable: false },
          { name: 'boolean_value', type: 'string', nullable: false },
          { name: 'timestamp_value', type: 'string', nullable: false },
          { name: 'nullable_value', type: 'string', nullable: true },
          { name: 'unicode_value', type: 'string', nullable: false },
          { name: 'json_value', type: 'string', nullable: false },
          { name: 'payload', type: 'string', nullable: false },
          { name: 'updated_at', type: 'string', nullable: false }
        ],
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
          { target: 'tenant_id', expr: { op: 'cast_number', value: { op: 'field', name: 'tenant_id' } } },
          { target: 'external_id', expr: { op: 'field', name: 'external_id' } },
          { target: 'name', expr: { op: 'field', name: 'name' } },
          { target: 'email', expr: { op: 'field', name: 'email' } },
          { target: 'status', expr: { op: 'field', name: 'status' } },
          { target: 'integer_value', expr: { op: 'field', name: 'integer_value' } },
          { target: 'decimal_value', expr: { op: 'field', name: 'decimal_value' } },
          { target: 'boolean_value', expr: { op: 'field', name: 'boolean_value' } },
          { target: 'timestamp_value', expr: { op: 'field', name: 'timestamp_value' } },
          { target: 'nullable_value', expr: { op: 'field', name: 'nullable_value' } },
          { target: 'unicode_value', expr: { op: 'field', name: 'unicode_value' } },
          { target: 'json_value', expr: { op: 'field', name: 'json_value' } },
          { target: 'payload', expr: { op: 'field', name: 'payload' } },
          { target: 'updated_at', expr: { op: 'field', name: 'updated_at' } }
        ],
        mappingRevision: 1,
        writeStrategy: { mode: 'insert', batchSize, bulk: false },
        verification: { checks: ['row_accounting', 'ledger_complete'] },
        risk: { level: 'medium', approvals: ['target_write'] },
        capabilityAssumptions: {
          source: { snapshotBinding: true },
          target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true }
        }
      }
    };

    // Prepare and approve
    const planStart = process.hrtime.bigint();
    const plan = await service.plan(request);
    const planMs = Number(process.hrtime.bigint() - planStart) / 1e6;
    evidenceWriter.appendRaw({ scenario, event: 'plan_created', planId: plan.planId, durationMs: planMs });

    const approval = await service.approve(request, { expiresAt: new Date(Date.now() + 3600_000).toISOString(), nonce: `qualify-${runId}` });

    // Execute with timing
    const execStart = process.hrtime.bigint();
    const execStartWall = new Date().toISOString();
    let result;
    try {
      const batchStart = process.hrtime.bigint();
      result = await service.run(request, { approval });
      const batchMs = Number(process.hrtime.bigint() - batchStart) / 1e6;
      histogram.add(batchMs / Math.ceil(rowCount / batchSize)); // approximate per-batch
      evidenceWriter.appendRaw({ scenario, event: 'batch_committed', rows: rowCount, bytes: rowCount * payloadBytes, durationMs: batchMs });
    } catch (e) {
      failures.push({ scenario, code: e.code ?? 'UNKNOWN', message: e.message, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
      throw e;
    }
    const execMs = Number(process.hrtime.bigint() - execStart) / 1e6;
    const execEndWall = new Date().toISOString();

    // Verification is already done inside service.run (row accounting). Ensure target row count matches
    client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    const countRes = await client.query(`SELECT count(*)::int as c FROM public."${table}"`);
    const targetCount = countRes.rows[0].c;
    await client.end(); client = null;

    if (targetCount !== rowCount) {
      failures.push({ scenario, code: 'VERIFICATION_FAILED', message: `targetCount ${targetCount} != expected ${rowCount}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
      throw new Error(`Verification failed: targetCount ${targetCount} != ${rowCount}`);
    }

    // Collect metrics
    const totalBytes = rowCount * (payloadBytes + 100); // approximate
    const lat = histogram.percentiles();
    const finalMetrics = {
      scenario,
      requestedConfig: { rows: profile.rows, batchSize: profile.batchSize },
      effectiveConfig: { rows: rowCount, batchSize },
      rowCount,
      payloadBytes,
      batchSize,
      totalBytes,
      durationMs: execMs,
      rowsPerSec: rowsPerSecond(rowCount, execMs),
      mibPerSec: mibPerSecond(totalBytes, execMs),
      latency: lat,
      targetCount,
      verification: result.verification,
      startWall: execStartWall,
      endWall: execEndWall,
      datasetId: did,
      planId: plan.planId,
      table
    };

    evidenceWriter.appendRaw({ scenario, event: 'target_load_completed', ...finalMetrics });

    // State machine validation
    const transitions = service.transitions(request.migrationId);
    const state = service.migrationState(request.migrationId);
    const stateValid = transitions.length > 0 && state.currentState === 'READY_FOR_CUTOVER';
    if (!stateValid) {
      failures.push({ scenario, code: 'STATE_MACHINE_INVALID', message: `Expected READY_FOR_CUTOVER but got ${state?.currentState}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    }

    return {
      metrics: finalMetrics,
      failures,
      stateTransitions: transitions.length,
      currentState: state.currentState,
      durationMs: execMs,
      throughput: finalMetrics.rowsPerSec,
      verification: 'VERIFIED'
    };
  } finally {
    try { if (client) await client.end(); } catch {}
    try { if (service) service.close(); } catch {}
    try { await rm(sourceRoot, { recursive: true, force: true }); } catch {}
    try { await rm(targetRoot, { recursive: true, force: true }); } catch {}
    try { await rm(snapshotDir, { recursive: true, force: true }); } catch {}
    // Cleanup table
    if (pgConfig) {
      let c;
      try {
        c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
        await c.connect();
        await c.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
        await c.end();
      } catch {}
    }
  }
}








