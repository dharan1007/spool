import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { PostgresTarget } from '../../../src/connectors/postgres/target.js';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { SpoolCommandService } from '../../../src/daemon/command-service.js';
import { writeDatasetCsv } from '../dataset.js';


// PostgreSQL truncates identifiers past 63 characters: all scenario table
// names derive from a short deterministic hash so expected names always
// equal live names and parallel runs cannot collide on truncation.
function shortKey(seed, runId) {
  return createHash('sha256').update(`qualify-${seed}-${runId}`).digest('hex').slice(0, 12);
}

export async function runCrashRecovery({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.crashRecovery';
  const table = `qualify_crash_${shortKey(seed, runId)}`;
  const rowCount = profile.rows;
  const effectiveConfig = { rows: rowCount };
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

    // Phase 3: real OS kill mid-COPY (child process fault boundary).
    // Spawns a child that batches via PostgresTarget + MigrationRunner with a file checkpoint,
    // kills it SIGKILL after ledger-observed progress, then proves durable checkpoint + ledger
    // allow a fresh process to reconcile and complete without duplicates (RPO bounded to batch).
    {
      const killTable = `qualify_crash_kill_${runId.slice(-8).replaceAll('-', '_').toLowerCase()}_${Date.now().toString(36).slice(-4)}`;
      const killMigrationId = `qualify-crash-kill-${runId}`;
      const killRowCount = Math.min(20_000, Math.max(5000, rowCount));
      const killBatchSize = 1000;
      // Leave the dead owner's real DB-clock lease intact. A shortened
      // qualification-only TTL keeps the test bounded without admin DELETE.
      const killLeaseTtlMs = 8_000;
      const killSeed = `${seed}-crash-kill`;
      const checkpointPath = join(tmpdir(), `spool-qualify-checkpoint-${runId}.json`);
      const childConfigPath = join(tmpdir(), `spool-qualify-child-${runId}.json`);
      let killChild = null;
      let killFaultAt = null;
      let killRecoveredAt = null;
      let ledgerBeforeKill = 0;
      let checkpointBeforeKill = null;
      try {
        // Prepare target table for kill proof
        let c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
        await c.connect();
        await c.query(`DROP TABLE IF EXISTS public."${killTable}" CASCADE`);
        await c.query(`CREATE TABLE public."${killTable}" (id integer PRIMARY KEY, payload text NOT NULL)`);
        // Preflight: capture target contract id via a temporary execution
        const { createPostgresTargetRuntime } = await import('../../../src/connectors/postgres/runtime.js');
        const brokerKill = new CredentialBroker();
        brokerKill.withSecret = async (ref, fn) => fn(pgConfig.password);
        const rt = createPostgresTargetRuntime({ credentialBroker: brokerKill });
        const endpoint = `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`;
        const targetRefKill = { connector: 'postgres', connectionId: 'pg', resource: `public.${killTable}`, endpoint, database: pgConfig.database, schema: 'public', table: killTable, identity: { user: pgConfig.user }, secretRef: { provider: 'env', key: 'PGPASSWORD' } };
        const pre = await rt.preflight({ targetRef: targetRefKill, targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'payload', type: 'string', nullable: false }] });
        const targetContractId = pre.targetContractId;
        await c.end();

        // Write child config (contains password - temp file, removed after)
        const planId = `sha256:${'a'.repeat(64)}`;
        const sourceSnapshotId = `sha256:${'b'.repeat(64)}`;
        await writeFile(childConfigPath, JSON.stringify({ pgConfig, table: killTable, migrationId: killMigrationId, planId, sourceSnapshotId, mappingRevision: 1, batchSize: killBatchSize, rowCount: killRowCount, payloadBytes, seed: killSeed, targetContractId, checkpointPath, leaseTtlMs: killLeaseTtlMs }), { encoding: 'utf8', mode: 0o600 });

        const childScript = fileURLToPath(new URL('./crash-child.js', import.meta.url));
        killChild = spawn(process.execPath, [childScript, '--config', childConfigPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let childReady = false;
        let childLease = null;
        let childBatches = 0;
        let stdoutPending = '';
        killChild.stdout.on('data', chunk => {
          stdoutPending += chunk.toString();
          let newline;
          while ((newline = stdoutPending.indexOf('\n')) >= 0) {
            const line = stdoutPending.slice(0, newline).trim();
            stdoutPending = stdoutPending.slice(newline + 1);
            if (line.startsWith('CRASH_CHILD_READY ')) {
              try {
                const observed = JSON.parse(line.slice('CRASH_CHILD_READY '.length));
                if (typeof observed.resource === 'string'
                    && typeof observed.owner === 'string'
                    && Number.isSafeInteger(observed.fencingToken)
                    && Number.isFinite(Date.parse(observed.expiresAt))) {
                  childLease = observed;
                  childReady = true;
                }
              } catch { /* malformed child evidence never counts as READY */ }
            }
            if (line.startsWith('BATCH_COMMITTED ')) childBatches += 1;
          }
        });
        let childStderr = '';
        killChild.stderr.on('data', chunk => { childStderr += chunk.toString(); });
        const childExit = new Promise(resolve => {
          killChild.on('exit', (code, signal) => resolve({ code, signal }));
          killChild.on('error', err => resolve({ code: null, signal: null, error: err.message }));
        });

        // Wait for child ready (ledger-observed readiness, not time-assumed)
        const readyDeadline = Date.now() + 10_000;
        while (!childReady && Date.now() < readyDeadline) {
          if (killChild.exitCode != null) break;
          await new Promise(r => setTimeout(r, 5));
        }
        if (!childReady) {
          try { killChild.kill('SIGKILL'); } catch {}
          throw new Error(`crash child did not become ready (stderr: ${childStderr.slice(0, 500)})`);
        }
        if (childLease.resource !== `postgres:${targetRefKill.endpoint}:${targetRefKill.database}:${targetRefKill.schema}.${targetRefKill.table}`) {
          throw new Error('Crash child lease resource differs from intended target');
        }
        evidenceWriter.appendRaw({ scenario, event: 'crash_child_ready', pid: killChild.pid, lease: childLease });

        // Ledger-observed progress: poll batch_ledger until at least one batch committed, then kill mid-flight
        killFaultAt = Date.now();
        let ledgerCount = 0;
        const killDeadline = Date.now() + 15_000;
        while (Date.now() < killDeadline) {
          if (killChild.exitCode != null) break;
          try {
            const poll = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
            await poll.connect();
            const res = await poll.query(`SELECT count(*)::int AS c FROM spool_internal.batch_ledger WHERE migration_id = $1`, [killMigrationId]);
            ledgerCount = res.rows[0].c;
            await poll.end();
          } catch {}
          if (ledgerCount >= 1 && ledgerCount < Math.ceil(killRowCount / killBatchSize)) break;
          if (ledgerCount >= Math.ceil(killRowCount / killBatchSize)) break;
          await new Promise(r => setTimeout(r, 5));
        }
        ledgerBeforeKill = ledgerCount;
        try {
          const cpRaw = await readFile(checkpointPath, 'utf8');
          checkpointBeforeKill = JSON.parse(cpRaw);
        } catch { checkpointBeforeKill = null; }
        evidenceWriter.appendRaw({ scenario, event: 'crash_kill_ledger_observed', ledgerCount, checkpoint: checkpointBeforeKill, pid: killChild.pid });

        // The fault is valid only when an actual SIGKILL kills a still-live
        // writer after a durable ledger commit and before the last batch.
        // A graceful stop, already-exited child, or completed workload
        // cannot silently satisfy this adversarial proof.
        const totalBatchesBeforeKill = Math.ceil(killRowCount / killBatchSize);
        if (ledgerBeforeKill < 1 || ledgerBeforeKill >= totalBatchesBeforeKill) {
          throw new Error(`SIGKILL was not armed mid-flight: ledger=${ledgerBeforeKill}/${totalBatchesBeforeKill}`);
        }
        if (process.platform !== 'linux' || killChild.exitCode != null || !killChild.kill('SIGKILL')) {
          throw new Error('Required live Linux SIGKILL could not be delivered');
        }
        evidenceWriter.appendRaw({ scenario, event: 'crash_kill_signal', signal: 'SIGKILL', pid: killChild.pid, ledgerCount });
        const exitInfo = await Promise.race([childExit, new Promise(r => setTimeout(() => r({ code: null, signal: 'TIMEOUT' }), 5000))]);
        if (exitInfo.signal !== 'SIGKILL') {
          throw new Error(`SIGKILL was not independently observed at process exit: ${JSON.stringify(exitInfo)}`);
        }
        evidenceWriter.appendRaw({ scenario, event: 'crash_child_exit', ...exitInfo, killed: true, ledgerBeforeKill, checkpointBeforeKill });

        // A fresh contender must be refused WHILE the dead owner's lease
        // is still active. The PostgreSQL server clock, never a local
        // sleep assumption, decides when the lease has naturally expired.
        const broker2 = new CredentialBroker();
        broker2.withSecret = async (ref, fn) => fn(pgConfig.password);
        const { createPostgresTargetRuntime: createRt2 } = await import('../../../src/connectors/postgres/runtime.js');
        const rt2 = createRt2({ credentialBroker: broker2, leaseTtlMs: 30_000 });
        const exec2 = rt2.createExecution({ migrationId: killMigrationId, targetRef: targetRefKill });
        const leaseClient = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
        await leaseClient.connect();
        const readLease = async () => {
          const res = await leaseClient.query(
            'SELECT owner, fencing_token::text AS token, expires_at, expires_at > clock_timestamp() AS active FROM spool_internal.execution_leases WHERE resource = $1',
            [childLease.resource]
          );
          return res.rows[0] ?? null;
        };
        let lease2;
        try {
          const initialLease = await readLease();
          if (!initialLease || initialLease.owner !== childLease.owner
              || BigInt(initialLease.token) !== BigInt(childLease.fencingToken)
              || initialLease.active !== true) {
            throw new Error('Dead-owner lease was missing, already expired, or changed before the refusal test');
          }
          let earlyRefused = false;
          try {
            await exec2.renewLease();
          } catch (error) {
            if (error?.code !== 'LEASE_HELD') throw error;
            earlyRefused = true;
          }
          if (!earlyRefused) throw new Error('New worker acquired the still-active dead-owner lease');
          evidenceWriter.appendRaw({ scenario, event: 'dead_owner_lease_refused_before_expiry', lease: initialLease });

          const expiryDeadline = Date.now() + killLeaseTtlMs * 3;
          let expiredLease = null;
          while (Date.now() < expiryDeadline) {
            const observed = await readLease();
            if (!observed || observed.owner !== childLease.owner
                || BigInt(observed.token) !== BigInt(childLease.fencingToken)) {
              throw new Error('Dead-owner lease was altered during natural expiry wait');
            }
            if (observed.active === false) { expiredLease = observed; break; }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!expiredLease) throw new Error('Natural PostgreSQL lease expiry was not observed before deadline');
          evidenceWriter.appendRaw({ scenario, event: 'dead_owner_lease_expired_naturally', lease: expiredLease });

          lease2 = await exec2.renewLease();
          if (lease2.resource !== childLease.resource
              || lease2.owner === childLease.owner
              || BigInt(lease2.fencingToken) <= BigInt(childLease.fencingToken)) {
            throw new Error('Natural lease takeover did not advance the fencing token');
          }
          evidenceWriter.appendRaw({ scenario, event: 'lease_takeover_after_db_expiry', oldFence: childLease.fencingToken, newFence: lease2.fencingToken });
        } finally {
          await leaseClient.end();
        }
        // Prove that the old owner cannot use its previously valid fence
        // after takeover. A raised but unrelated input error is not proof.
        const staleTarget = new PostgresTarget({
          targetRef: targetRefKill, credentialBroker: broker2,
          requireFencing: true, fenceResource: childLease.resource,
          fenceOwner: childLease.owner
        });
        let staleRefused = false;
        try {
          await staleTarget.commitBatch({
            migrationId: killMigrationId, planId, sourceSnapshotId,
            mappingRevision: 1, targetContractId,
            batchIdentity: `sha256:${'e'.repeat(64)}`,
            fencingToken: childLease.fencingToken,
            rows: [{ id: killRowCount + 1, payload: 'stale-owner-canary' }]
          });
        } catch (error) {
          if (!['STALE_FENCE', 'LEASE_EXPIRED'].includes(error?.code)) throw error;
          staleRefused = true;
        } finally {
          staleTarget.close();
        }
        if (!staleRefused) throw new Error('Stale owner was able to mutate after lease takeover');
        evidenceWriter.appendRaw({ scenario, event: 'old_fence_mutation_refused', oldFence: childLease.fencingToken });

        // Fresh process must reconstruct durable checkpoint + ledger and complete without duplicates.
        killRecoveredAt = Date.now();
        const rtoMsKill = killRecoveredAt - killFaultAt;
        // Verify ledger has at least one entry (atomic batch ledger proved durable)
        let ledgerAfterKill = 0;
        try {
          const poll2 = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
          await poll2.connect();
          const res2 = await poll2.query(`SELECT count(*)::int AS c FROM spool_internal.batch_ledger WHERE migration_id = $1`, [killMigrationId]);
          ledgerAfterKill = res2.rows[0].c;
          await poll2.end();
        } catch {}

        // Replay remaining batches via fresh runner (reconciles already-committed batches)
        const { MigrationRunner: Runner2 } = await import('../../../src/execution/migration-runner.js');
        const { generateRow: genRow } = await import('../dataset.js');
        const target2 = exec2.openTarget();
        const cpStore2 = {
          async load() {
            try { return JSON.parse(await readFile(checkpointPath, 'utf8')); } catch { return null; }
          },
          async save(cp) { await writeFile(checkpointPath, JSON.stringify(cp), 'utf8'); }
        };
        const runner2 = new Runner2({ target: target2, checkpointStore: cpStore2 });
        let checkpointAfter = await cpStore2.load();
        let recoveredBatches = 0;
        const totalBatches = Math.ceil(killRowCount / killBatchSize);
        const resumeOffset = checkpointAfter?.nextOffset ?? 0;
        evidenceWriter.appendRaw({ scenario, event: 'crash_recovery_checkpoint', checkpointAfter, resumeOffset, ledgerAfterKill });
        for (let bi = resumeOffset / killBatchSize; bi < totalBatches; bi += 1) {
          const start = bi * killBatchSize;
          const endExclusive = Math.min(killRowCount, start + killBatchSize);
          const rows = [];
          for (let id = start + 1; id <= endExclusive; id += 1) {
            const r = genRow(killSeed, id, { payloadBytes });
            rows.push({ id: r.id, payload: r.payload });
          }
          const input = { migrationId: killMigrationId, planId, sourceSnapshotId, mappingRevision: 1, sourceRange: { start, endExclusive }, targetIdentity: targetRefKill, targetContractId, rows, fencingToken: lease2.fencingToken, bulk: false };
          const res = await runner2.runBatchAsync(input);
          if (res.recovered) recoveredBatches += 1;
        }
        await exec2.close();

        const verifyClient = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
        await verifyClient.connect();
        const cntKill = await verifyClient.query(`SELECT count(*)::int AS c FROM public."${killTable}"`);
        const ledgerFinal = await verifyClient.query(`SELECT count(*)::int AS c FROM spool_internal.batch_ledger WHERE migration_id = $1`, [killMigrationId]);
        await verifyClient.end();
        const finalCount = cntKill.rows[0].c;
        const finalLedger = ledgerFinal.rows[0].c;
        const rpoRows = killRowCount - finalCount;
        const passed = finalCount === killRowCount && finalLedger === totalBatches;
        if (!passed) {
          failures.push({ scenario, code: 'CRASH_KILL_REPLAY_MISMATCH', message: `kill recovery produced ${finalCount}/${killRowCount} rows, ledger ${finalLedger}/${totalBatches}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
        }
        // Must have killed mid-flight (at least one batch committed, not all)
        if (ledgerBeforeKill < 1) {
          failures.push({ scenario, code: 'CRASH_KILL_NOT_MID_FLIGHT', message: `kill did not land mid-flight: ledger ${ledgerBeforeKill}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
        }
        rpoRto.push({ faultId: 'os-kill-mid-copy', rtoMs: rtoMsKill, rpoRows: Math.max(0, rpoRows), finalVerification: passed ? 'VERIFIED' : 'MISMATCH', result: passed ? 'PASS' : 'FAIL', ledgerBeforeKill, ledgerFinal: finalLedger, recoveredBatches, checkpointBeforeKill, checkpointAfter });
        evidenceWriter.appendRaw({ scenario, event: 'crash_kill_recovery_completed', rtoMs: rtoMsKill, finalCount, finalLedger, passed, recoveredBatches });

        // Cleanup kill table
        const cleanKill = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
        await cleanKill.connect();
        await cleanKill.query(`DROP TABLE IF EXISTS public."${killTable}" CASCADE`);
        await cleanKill.query(`DELETE FROM spool_internal.batch_ledger WHERE migration_id = $1`, [killMigrationId]);
        await cleanKill.end();
      } catch (e) {
        failures.push({ scenario, code: e.code ?? 'CRASH_KILL_FAILED', message: e.message, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
        evidenceWriter.appendRaw({ scenario, event: 'crash_kill_failed', error: e.message, code: e.code ?? 'UNKNOWN' });
      } finally {
        try { if (killChild && killChild.exitCode == null) killChild.kill('SIGKILL'); } catch {}
        try { await rm(childConfigPath, { force: true }); } catch {}
        try { await rm(checkpointPath, { force: true }); } catch {}
        try {
          const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
          await c.connect();
          await c.query(`DROP TABLE IF EXISTS public."${killTable}" CASCADE`).catch(() => {});
          await c.query(`DELETE FROM spool_internal.batch_ledger WHERE migration_id = $1`, [killMigrationId]).catch(() => {});
          await c.end();
        } catch {}
      }
    }

    const status = failures.length ? 'FAIL' : 'PASS';
    return { metrics: { scenario, requestedConfig: { rows: profile.rows }, effectiveConfig, rowCount, rpoRto, status }, failures };
  } catch (e) {
    failures.push({ scenario, code: e.code ?? 'CRASH_RECOVERY_FAILED', message: e.message, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    return { metrics: { scenario, requestedConfig: { rows: profile.rows }, effectiveConfig, rowCount, rpoRto, status: 'FAIL' }, failures };
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


