import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { SpoolCommandService } from '../../../src/daemon/command-service.js';
import { writeDatasetCsv } from '../dataset.js';

export async function runCrashRecovery({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.crashRecovery';
  const table = `qualify_crash_${runId.replaceAll('-', '_').toLowerCase()}`;
  const rowCount = Math.min(profile.rows, 50_000);
  const payloadBytes = profile.payloadBytes;
  const failures = [];
  const rpoRto = [];

  const sourceRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-source-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-target-'));
  const statePath = join(targetRoot, `state-${runId}.db`);
  const snapshotDir = join(tmpdir(), `spool-qualify-snap-${runId}`);
  const csvPath = join(sourceRoot, 'dataset.csv');

  const broker = new CredentialBroker();
  broker.withSecret = async (ref, fn) => fn(pgConfig.password);

  async function makeService() {
    return SpoolCommandService.create({
      sourceRoot,
      targetRoot,
      statePath,
      snapshotDir,
      approvalSigningKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      release: { version: '1.1.1', commitSha: process.env.SPOOL_COMMIT_SHA ?? 'unknown' },
      credentialBroker: broker
    });
  }

  function makeRequest() {
    return {
      migrationId: `qualify-crash-${runId}`,
      principal: 'qualify:crash',
      planInput: {
        planRevision: 1,
        sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'dataset.csv', path: csvPath },
        targetRef: { connector: 'postgres', connectionId: 'pg', resource: `public.${table}`, endpoint: `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`, database: pgConfig.database, schema: 'public', table, identity: { user: pgConfig.user }, secretRef: { provider: 'env', key: 'PGPASSWORD' } },
        targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'payload', type: 'string', nullable: false }],
        mapping: [{ target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } }, { target: 'payload', expr: { op: 'field', name: 'payload' } }],
        mappingRevision: 1,
        writeStrategy: { mode: 'insert', batchSize: 1000 },
        verification: { checks: ['row_accounting', 'ledger_complete'] },
        risk: { level: 'medium', approvals: ['target_write'] },
        capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
      }
    };
  }

  try {
    await writeDatasetCsv({ seed: `${seed}-crash`, rowCount, payloadBytes, filePath: csvPath });

    let client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`);
    await client.end();

    // Phase 1: run to completion (first process).
    const service1 = await makeService();
    const request = makeRequest();
    const approval = await service1.approve(request, { expiresAt: new Date(Date.now() + 3600_000).toISOString(), nonce: `crash-${runId}` });
    const faultAt = Date.now();
    const result1 = await service1.run(request, { approval });
    if (result1.status !== 'COMPLETE') throw new Error(`initial run did not complete: ${result1.status}`);
    const state1 = service1.migrationState(request.migrationId);
    evidenceWriter.appendRaw({ scenario, event: 'initial_run_completed', state: state1.currentState, sequence: state1.sequence });
    // Simulate process death: close without cleanup (checkpoints already cleared
    // on success; the point is a FRESH process must reconstruct, not reuse memory).
    service1.close();

    // Phase 2: fresh process reconstructs durable state and reconciles via replay.
    // Re-running the same approved migration must be idempotent (no duplicates).
    const service2 = await makeService();
    const recoveredAt = Date.now();
    const state2 = service2.migrationState(request.migrationId);
    evidenceWriter.appendRaw({ scenario, event: 'recovery_state', state: state2?.currentState, sequence: state2?.sequence });
    if (!state2 || state2.currentState !== 'READY_FOR_CUTOVER') {
      failures.push({ scenario, code: 'RECOVERY_STATE_MISMATCH', message: `expected READY_FOR_CUTOVER after restart, got ${state2?.currentState}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    }
    const rtoMs = recoveredAt - faultAt;
    const result2 = await service2.run(request, { approval });
    if (result2.status !== 'COMPLETE') throw new Error(`recovery replay did not complete: ${result2.status}`);
    service2.close();

    client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    const cnt = await client.query(`SELECT count(*)::int as c FROM public."${table}"`);
    await client.end();
    if (cnt.rows[0].c !== rowCount) {
      failures.push({ scenario, code: 'REPLAY_DUPLICATED', message: `replay produced ${cnt.rows[0].c} rows, expected ${rowCount}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    }
    rpoRto.push({ faultId: 'process-restart-after-complete', rtoMs, rpoRows: 0, finalVerification: cnt.rows[0].c === rowCount ? 'VERIFIED' : 'MISMATCH', result: cnt.rows[0].c === rowCount ? 'PASS' : 'FAIL' });
    evidenceWriter.appendRaw({ scenario, event: 'crash_recovery_completed', rtoMs, targetCount: cnt.rows[0].c });

    const cleanup = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await cleanup.connect(); await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); await cleanup.end();

    const status = failures.length ? 'FAIL' : 'PASS';
    return { metrics: { scenario, rpoRto, status }, failures };
  } catch (e) {
    failures.push({ scenario, code: e.code ?? 'CRASH_RECOVERY_FAILED', message: e.message, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    return { metrics: { scenario, rpoRto, status: 'FAIL' }, failures };
  } finally {
    try { await rm(sourceRoot, { recursive: true, force: true }); } catch {}
    try { await rm(targetRoot, { recursive: true, force: true }); } catch {}
    try { await rm(snapshotDir, { recursive: true, force: true }); } catch {}
    try {
      const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await c.connect(); await c.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); await c.end();
    } catch {}
  }
}


