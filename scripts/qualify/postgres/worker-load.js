import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { SpoolCommandService } from '../../../src/daemon/command-service.js';
import { writeDatasetCsv, datasetId } from '../dataset.js';
import { rowsPerSecond } from '../metrics.js';


// PostgreSQL truncates identifiers past 63 characters: all scenario table
// names derive from a short deterministic hash so expected names always
// equal live names and parallel runs cannot collide on truncation.
function shortKey(seed, runId) {
  return createHash('sha256').update(`qualify-${seed}-${runId}`).digest('hex').slice(0, 12);
}

export async function runWorkerLoad({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.workers.load';
  const workers = profile.workers;
  const rowCount = profile.rows;
  const effectiveConfig = { rows: rowCount, workers };
  const payloadBytes = profile.payloadBytes;
  const batchSize = profile.batchSize;
  const perWorkerRows = Math.floor(rowCount / workers);
  const sourceRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-source-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-target-'));
  let client;
  const tables = Array.from({ length: workers }, (_, i) => `qualify_worker_${shortKey(seed, runId)}_${i}`);
  const failures = [];

  try {
    // Create tables
    client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    for (const table of tables) {
      await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
      await client.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`);
    }
    await client.end(); client = null;

    const start = process.hrtime.bigint();
    const results = await Promise.all(tables.map(async (table, idx) => {
      const csvPath = join(sourceRoot, `dataset-${idx}.csv`);
      await writeDatasetCsv({ seed: `${seed}-worker-${idx}`, rowCount: perWorkerRows, payloadBytes, filePath: csvPath });
      const statePath = join(targetRoot, `state-${runId}-${idx}.db`);
      const snapshotDir = join(tmpdir(), `spool-qualify-snap-${runId}-${idx}`);
      const broker = new CredentialBroker();
      broker.withSecret = async (ref, fn) => fn(pgConfig.password);
      const service = await SpoolCommandService.create({
        sourceRoot, targetRoot, statePath, snapshotDir,
        approvalSigningKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        release: { version: '1.1.1', commitSha: process.env.SPOOL_COMMIT_SHA ?? 'unknown' },
        credentialBroker: broker, maxSourceBytes: 1024 * 1024 * 1024
      });
      const request = {
        migrationId: `qualify-worker-${runId}-${idx}`,
        principal: 'qualify:worker',
        planInput: {
          planRevision: 1,
          sourceRef: { connector: 'filesystem', connectionId: 'src', resource: `dataset-${idx}.csv`, path: csvPath },
          targetRef: { connector: 'postgres', connectionId: 'pg', resource: `public.${table}`, endpoint: `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`, database: pgConfig.database, schema: 'public', table, identity: { user: pgConfig.user }, secretRef: { provider: 'env', key: 'PGPASSWORD' } },
          targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'payload', type: 'string', nullable: false }],
          mapping: [{ target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } }, { target: 'payload', expr: { op: 'field', name: 'payload' } }],
          mappingRevision: 1,
          writeStrategy: { mode: 'insert', batchSize, bulk: false },
          verification: { checks: ['row_accounting', 'ledger_complete'] },
          risk: { level: 'medium', approvals: ['target_write'] },
          capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
        }
      };
      const plan = await service.plan(request);
      const approval = await service.approve(request, { expiresAt: new Date(Date.now() + 3600_000).toISOString(), nonce: `worker-${runId}-${idx}` });
      const r = await service.run(request, { approval });
      // Capture state BEFORE close (close invalidates the service).
      const state = service.migrationState(request.migrationId);
      const transitions = service.transitions(request.migrationId);
      service.close();

      // Verify the real target independently from command-service state.
      // A worker result is not accepted merely because the service returned:
      // the table must contain exactly the declared worker partition.
      const verifier = new Client({
        host: pgConfig.host, port: pgConfig.port, database: pgConfig.database,
        user: pgConfig.user, password: pgConfig.password, ssl: false
      });
      await verifier.connect();
      let targetRows;
      try {
        const counted = await verifier.query(`SELECT count(*)::int AS n FROM public."${table}"`);
        targetRows = Number(counted.rows[0]?.n ?? -1);
      } finally {
        await verifier.end();
      }
      return {
        table, rows: perWorkerRows, targetRows,
        status: r.status, state: state.currentState, transitions: transitions.length
      };
    }));

    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const totalRows = results.reduce((a, b) => a + b.rows, 0);
    for (const result of results) {
      if (result.status !== 'COMPLETE') {
        failures.push({
          scenario,
          code: 'WORKER_RUN_INCOMPLETE',
          message: `${result.table}: command service ended with status ${result.status}`,
          expected: false,
          classification: 'CORRECTNESS',
          timestamp: new Date().toISOString()
        });
      }
      if (result.state !== 'READY_FOR_CUTOVER') {
        failures.push({
          scenario,
          code: 'WORKER_STATE_NOT_READY',
          message: `${result.table}: durable state is ${result.state}, expected READY_FOR_CUTOVER`,
          expected: false,
          classification: 'CORRECTNESS',
          timestamp: new Date().toISOString()
        });
      }
      if (result.targetRows !== result.rows) {
        failures.push({
          scenario,
          code: 'WORKER_TARGET_ROW_MISMATCH',
          message: `${result.table}: target has ${result.targetRows} rows, expected ${result.rows}`,
          expected: false,
          classification: 'CORRECTNESS',
          timestamp: new Date().toISOString()
        });
      }
    }
    const metrics = {
      scenario,
      requestedConfig: { rows: profile.rows, workers: profile.workers },
      effectiveConfig,
      workers,
      perWorkerRows,
      totalRows,
      durationMs: ms,
      rowsPerSec: rowsPerSecond(totalRows, ms),
      results,
      // This scenario proves parallel independent services only. It is not
      // evidence of a shared durable scheduler, leader failover or quorum HA.
      executionModel: 'independent-services-independent-state-independent-targets',
      haProven: false,
      verification: failures.length ? 'FAILED' : 'VERIFIED'
    };
    evidenceWriter.appendRaw({ scenario, event: 'worker_load_completed', ...metrics });
    return { metrics, failures };
  } finally {
    try { if (client) await client.end(); } catch {}
    try { await rm(sourceRoot, { recursive: true, force: true }); } catch {}
    try { await rm(targetRoot, { recursive: true, force: true }); } catch {}
    try {
      const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await c.connect();
      for (const table of tables) await c.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
      await c.end();
    } catch {}
  }
}


