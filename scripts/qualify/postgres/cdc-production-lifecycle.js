import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { SpoolCommandService } from '../../../src/daemon/command-service.js';

// Production CDC lifecycle qualification: drives the exact customer code
// path through SpoolCommandService — establishCdcBoundary, approve, run,
// catchUpCdc (production createCdcApplier with fenced atomic transaction
// apply, CAS checkpoints, ack-after-durability), beginCutover, commitCutover
// (FINAL_DRAIN plus fresh FINAL_PRE_CUTOVER proof), POST_CUTOVER proof,
// releaseCdcBoundary. No protocol reimplementation: the scenario only writes
// source data and asserts convergence. All scale comes from the profile with
// no silent caps; requested and effective configuration are both recorded.
export async function runCdcProductionLifecycle({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.cdc.productionLifecycle';
  const rowCount = profile.rows;
  const writers = profile.writers;
  const durationSec = profile.cdcDurationSeconds;
  const largeTxRows = profile.largeTransactionRows;
  const effectiveConfig = { rows: rowCount, writers, cdcDurationSeconds: durationSec, largeTransactionRows: largeTxRows };
  // PostgreSQL truncates identifiers past 63 characters: derive a short
  // deterministic suffix so the expected names always equal the live names
  // (a 70-char expectation would never match the streamed relation name).
  const key = createHash('sha256').update(`cdcprod-${runId}-${seed}`).digest('hex').slice(0, 12);
  const sourceTable = `qualify_cdcprod_src_${key}`;
  const targetTable = `qualify_cdcprod_dst_${key}`;
  const slotName = `qcdcp_${key}`;
  const publicationName = `qcdcpp_${key}`;
  const failures = [];
  const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
  const broker = new CredentialBroker();
  broker.withSecret = async (ref, fn) => fn(pgConfig.password);

  const endpoint = `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`;
  const pgRef = table => ({
    connector: 'postgres', connectionId: 'pg-cdcprod', resource: `public.${table}`,
    endpoint, database: pgConfig.database, schema: 'public', table,
    identity: { user: pgConfig.user }, secretRef
  });

  const admin = () => {
    const client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    return client.connect().then(() => client);
  };
  const flushLsn = async client => {
    const res = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    return String(res.rows[0].lsn).toUpperCase();
  };

  const dir = await mkdtemp(join(tmpdir(), 'spool-qualify-cdcprod-'));
  const sourceRoot = join(dir, 'source-root');
  const targetRoot = join(dir, 'target-root');
  const snapshotDir = join(dir, 'snapshots');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const service = await SpoolCommandService.create({
    sourceRoot, targetRoot, snapshotDir, statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    credentialBroker: broker,
    release: { version: '1.1.1', commitSha: process.env.SPOOL_COMMIT_SHA ?? 'unknown' }
  });

  // Deterministic writer mix: inserts into a private id range per writer plus
  // updates/deletes over the seeded key space. No RNG anywhere.
  async function writerTask(wi, stopAt) {
    const client = await admin();
    let ops = 0;
    let transactions = 0;
    try {
      let opIndex = 0;
      while (Date.now() < stopAt) {
        const kind = (wi * 13 + opIndex * 7) % 100;
        const baseId = rowCount + wi * 2_000_000 + opIndex;
        if (kind < 60) {
          await client.query(`INSERT INTO public."${sourceTable}"(id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [baseId + 1, `w${wi}-${opIndex}`]);
        } else if (kind < 85) {
          await client.query(`UPDATE public."${sourceTable}" SET payload = $2 WHERE id = $1`, [(opIndex % rowCount) + 1, `u${wi}-${opIndex}`]);
        } else {
          await client.query(`DELETE FROM public."${sourceTable}" WHERE id = $1`, [(opIndex % rowCount) + 1]);
          await client.query(`INSERT INTO public."${sourceTable}"(id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [(opIndex % rowCount) + 1, `r${wi}-${opIndex}`]);
        }
        ops += 1; opIndex += 1;
        if (opIndex % 25 === 0) {
          transactions += 1;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    } finally { await client.end(); }
    return { writer: wi, ops, transactions };
  }

  try {
    const setup = await admin();
    try {
      await setup.query(`DROP TABLE IF EXISTS public."${sourceTable}" CASCADE`);
      await setup.query(`DROP TABLE IF EXISTS public."${targetTable}" CASCADE`);
      await setup.query(`CREATE TABLE public."${sourceTable}" (id integer PRIMARY KEY, payload text NOT NULL)`);
      await setup.query(`CREATE TABLE public."${targetTable}" (id integer PRIMARY KEY, payload text NOT NULL)`);
      await setup.query(`ALTER TABLE public."${sourceTable}" REPLICA IDENTITY FULL`);
      // Deterministic seed load in batches.
      const BATCH = 5000;
      for (let start = 1; start <= rowCount; start += BATCH) {
        const end = Math.min(rowCount, start + BATCH - 1);
        const values = [];
        for (let id = start; id <= end; id += 1) values.push(`(${id}, 'seed-${id}')`);
        await setup.query(`INSERT INTO public."${sourceTable}"(id, payload) VALUES ${values.join(',')}`);
        if (start % 50000 === 1) evidenceWriter.appendRaw({ scenario, event: 'seed_progress', seeded: end, rowCount });
      }
    } finally { await setup.end(); }
    evidenceWriter.appendRaw({ scenario, event: 'lifecycle_seeded', rowCount, writers, durationSec, largeTxRows });

    const migrationId = `qualify-cdcprod-${runId}`;
    const request = {
      migrationId,
      principal: 'qualify:cdc-production-lifecycle',
      planInput: {
        planRevision: 1,
        sourceRef: pgRef(sourceTable),
        targetRef: pgRef(targetTable),
        targetSchema: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'payload', type: 'string', nullable: false }
        ],
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
          { target: 'payload', expr: { op: 'field', name: 'payload' } }
        ],
        mappingRevision: 1,
        writeStrategy: { mode: 'insert', batchSize: profile.batchSize },
        verification: { checks: ['row_accounting', 'ledger_complete', 'content_exact'] },
        risk: { level: 'medium', approvals: ['target_write'] },
        capabilityAssumptions: {
          source: { snapshotBinding: true, durableMaterialization: true },
          target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true, readAfterWriteVerification: true }
        }
      }
    };

    // 1. Boundary before approval.
    const boundary = await service.establishCdcBoundary(request, { slotName, publicationName });
    evidenceWriter.appendRaw({ scenario, event: 'boundary_established', boundaryId: boundary.boundaryId, snapshotId: boundary.snapshotId, consistentPoint: boundary.consistentPoint });
    const approval = await service.approve(request, { expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(), nonce: `cdcprod-${runId}` });

    // 2. Full load, then concurrent production writes during catch-up.
    const runResult = await service.run(request, { approval });
    if (runResult.status !== 'COMPLETE') {
      failures.push({ scenario, code: 'LIFECYCLE_FULL_LOAD_INCOMPLETE', message: `full load ended ${runResult.status}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    }
    evidenceWriter.appendRaw({ scenario, event: 'full_load_complete', status: runResult.status });

    const stopAt = Date.now() + durationSec * 1000;
    const writerPromise = Promise.all(Array.from({ length: writers }, (_, wi) => writerTask(wi, stopAt)));

    // 3. A declared-size large source transaction inside the stream.
    const loader = await admin();
    try {
      const LB = 1000;
      await loader.query('BEGIN');
      for (let i = 0; i < largeTxRows; i += LB) {
        const batch = Math.min(LB, largeTxRows - i);
        const values = Array.from({ length: batch }, (_, j) => `(${rowCount + 50_000_000 + i + j + 1}, 'large-${i + j}')`).join(',');
        await loader.query(`INSERT INTO public."${sourceTable}"(id, payload) VALUES ${values}`);
        if (i % 100000 === 0) evidenceWriter.appendRaw({ scenario, event: 'large_tx_progress', inserted: i, largeTxRows });
      }
      await loader.query('COMMIT');
    } finally { await loader.end(); }
    evidenceWriter.appendRaw({ scenario, event: 'large_tx_committed', largeTxRows });

    const writerStats = await writerPromise;
    const totalOps = writerStats.reduce((a, b) => a + b.ops, 0);
    evidenceWriter.appendRaw({ scenario, event: 'writers_quiesced', totalOps, writers });

    // 4. Catch up through the waterline on the production applier path.
    const quencher = await admin();
    let waterline;
    try { waterline = await flushLsn(quencher); } finally { await quencher.end(); }
    const summary = await service.catchUpCdc(request, { untilLsn: waterline });
    const binding = service.snapshotCdcBinding(migrationId);
    evidenceWriter.appendRaw({
      scenario, event: 'catch_up_complete', waterline,
      appliedTransactions: summary.appliedTransactions ?? null,
      appliedLsn: binding?.appliedLsn ?? null, acknowledgedLsn: binding?.acknowledgedLsn ?? null,
      receivedLsn: binding?.receivedLsn ?? null
    });

    // 5. Exact convergence: target equals live source, row for row.
    const checker = await admin();
    try {
      const diff = await checker.query(`
        (SELECT id, payload FROM public."${sourceTable}" EXCEPT SELECT id, payload FROM public."${targetTable}")
        UNION ALL
        (SELECT id, payload FROM public."${targetTable}" EXCEPT SELECT id, payload FROM public."${sourceTable}")
        LIMIT 5`);
      if (diff.rows.length !== 0) {
        failures.push({ scenario, code: 'LIFECYCLE_CONVERGENCE_FAILED', message: `target diverged from source (${JSON.stringify(diff.rows[0])})`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
      }
      const counts = await checker.query(`SELECT (SELECT count(*)::int FROM public."${sourceTable}") AS s, (SELECT count(*)::int FROM public."${targetTable}") AS t`);
      evidenceWriter.appendRaw({ scenario, event: 'convergence_checked', sourceRows: counts.rows[0].s, targetRows: counts.rows[0].t });
    } finally { await checker.end(); }

    // 6. Cutover on the quiesced source with explicit test barrier evidence
    // (EXTERNAL_OPERATOR_BARRIER class: writers already stopped; the
    // attestation is recorded, never an implied zero-downtime claim).
    const armed = await service.beginCutover(request, { receipt: runResult.receipt });
    if (armed.status !== 'ARMED') {
      failures.push({ scenario, code: 'LIFECYCLE_ARM_FAILED', message: `arm ended ${armed.status}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    }
    const committed = await service.commitCutover(request);
    if (committed.status !== 'COMMITTED') {
      failures.push({ scenario, code: 'LIFECYCLE_COMMIT_FAILED', message: `commit ended ${committed.status}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    }
    evidenceWriter.appendRaw({
      scenario, event: 'cutover_committed', status: committed.status,
      barrier: { type: 'EXTERNAL_OPERATOR_BARRIER', writersStopped: true, quiescedAt: new Date().toISOString() },
      fenced: committed.commitEvidence?.fenced ?? null
    });

    // 7. Post-cutover proof + release.
    const post = await admin();
    try {
      const diff = await post.query(`
        (SELECT id, payload FROM public."${sourceTable}" EXCEPT SELECT id, payload FROM public."${targetTable}")
        UNION ALL
        (SELECT id, payload FROM public."${targetTable}" EXCEPT SELECT id, payload FROM public."${sourceTable}")
        LIMIT 1`);
      if (diff.rows.length !== 0) {
        failures.push({ scenario, code: 'LIFECYCLE_POST_CUTOVER_DIVERGED', message: 'target diverged after cutover', expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
      }
    } finally { await post.end(); }
    const released = await service.releaseCdcBoundary(request);
    evidenceWriter.appendRaw({ scenario, event: 'boundary_released', slotName: released.slotName, dropped: released.dropped });

    const metrics = {
      scenario,
      requestedConfig: { rows: profile.rows, writers: profile.writers, cdcDurationSeconds: profile.cdcDurationSeconds, largeTransactionRows: profile.largeTransactionRows },
      effectiveConfig,
      rowCount, writers, durationSec, largeTxRows, totalOps,
      appliedTransactions: summary.appliedTransactions ?? null,
      appliedLsn: binding?.appliedLsn ?? null,
      acknowledgedLsn: binding?.acknowledgedLsn ?? null,
      cutoverStatus: committed.status,
      slotReleased: released.dropped === true,
      status: failures.length ? 'FAIL' : 'PASS'
    };
    evidenceWriter.appendRaw({ scenario, event: 'lifecycle_completed', ...metrics });
    return { metrics, failures };
  } finally {
    try { service.close(); } catch {}
    try { await rm(dir, { recursive: true, force: true }); } catch {}
    try {
      const c = await admin();
      try {
        await c.query(`DROP TABLE IF EXISTS public."${sourceTable}" CASCADE`).catch(() => {});
        await c.query(`DROP TABLE IF EXISTS public."${targetTable}" CASCADE`).catch(() => {});
      } finally { await c.end(); }
    } catch {}
  }
}
