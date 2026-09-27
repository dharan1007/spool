import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import {
  comparePostgresLsn,
  createCdcCheckpointStore,
  createPostgresReplicationSlot,
  dropPostgresReplicationSlot,
  ensurePostgresPublication,
  streamPostgresChanges
} from '../../../src/connectors/postgres/cdc.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Deterministic operation mix per (writer, opIndex): no RNG, evidence must be reproducible.
// 30% insert, 45% update, 20% delete, 5% multi-row transaction (2 events).
function opMix(writer, opIndex) {
  const r = (writer * 13 + opIndex * 7) % 100;
  if (r < 30) return 'insert';
  if (r < 75) return 'update';
  if (r < 95) return 'delete';
  return 'multi';
}

function opEvents(kind) {
  return kind === 'multi' ? 2 : 1;
}

export async function runCdcSoak({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.cdc.soak';
  // No silent caps: the scenario executes the declared profile workload
  // exactly. Requested and effective configuration are both recorded; any
  // divergence fails the run (the verifier enforces requested==effective for
  // immutable profile names).
  const durationSec = profile.cdcDurationSeconds;
  const writers = profile.writers;
  const effectiveConfig = { cdcDurationSeconds: durationSec, writers };
  const seedKey = createHash('sha256').update(`cdc-soak-${runId}-${seed}`).digest('hex').slice(0, 12);
  const table = `qualify_cdc_${seedKey}`;
  const publicationName = `qcdc_pub_${seedKey}`;
  const slotName = `qcdc_${seedKey}`;
  let adminClient;
  const failures = [];
  let checkpointDir;

  const dbRef = {
    endpoint: `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`,
    database: pgConfig.database,
    identity: { user: pgConfig.user },
    secretRef: { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' }
  };
  const broker = new CredentialBroker();
  broker.withSecret = async (ref, fn) => fn(pgConfig.password);

  const flushLsn = async client => {
    const res = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    return res.rows[0].lsn;
  };

  // Each 30-second slice allocates at most 100 operations per writer. A
  // seven-day run cannot allocate billions of planned operations upfront.
  const CHUNK_WINDOW_MS = 30_000;
  const CHUNKS = Math.max(1, Math.ceil(durationSec * 1000 / CHUNK_WINDOW_MS));
  const opsPerChunk = 100;
  const writerPaceMs = Math.max(1, Math.floor((durationSec * 1000) / (CHUNKS * opsPerChunk)));
  const WRITER_BASE = 100_000_000, WRITER_STRIDE = 20_000_000, MULTI_OFFSET = 10_000_000;

  // Only count SQL operations and inserts once the exact effect completed.
  let expectedInsertCount = 0;
  let eventsAttempted = 0;

  let capturedChanges = 0;
  let insertCapturedTotal = 0;
  let currentCheckpoint = null;
  let streamOrdered = true;
  let strictResume = true;
  let tailEvents = 0;
  let tailCaptured = 0;
  let windowBounded = true;
  let lastLagBytes = null;

  async function writePlan(chunk) {
    const jobs = Array.from({ length: writers }, async (_, wi) => {
      const client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await client.connect();
      let inserted = 0, attempted = 0, operations = 0;
      try {
        for (let op = 0; op < opsPerChunk; op += 1) {
          const opIndex = chunk * opsPerChunk + op;
          const kind = opMix(wi, opIndex);
          const singleId = WRITER_BASE + wi * WRITER_STRIDE + opIndex + 1;
          const id = kind === 'multi' ? singleId + MULTI_OFFSET : singleId;
          if (opIndex >= MULTI_OFFSET || id > 2_147_483_647) {
            throw new Error('CDC writer exhausted its disjoint 32-bit identifier band');
          }
          let inTx = false;
          try {
            if (kind !== 'insert') { await client.query('BEGIN'); inTx = true; }
            const added = await client.query(`INSERT INTO public."${table}"(id, payload) VALUES ($1, $2)`, [id, `new-${wi}-${opIndex}`]);
            if (added.rowCount !== 1) throw new Error('CDC writer insert was not exactly one row');
            // All update/delete/multi events MUST mutate a row that exists.
            // A setup INSERT and its mutation share one source transaction:
            // this proves event order and atomicity rather than no-op SQL.
            if (kind === 'update' || kind === 'multi') {
              const updated = await client.query(`UPDATE public."${table}" SET payload = $2 WHERE id = $1`, [id, `updated-${wi}-${opIndex}`]);
              if (updated.rowCount !== 1) throw new Error('CDC writer update was not exactly one row');
            } else if (kind === 'delete') {
              const deleted = await client.query(`DELETE FROM public."${table}" WHERE id = $1`, [id]);
              if (deleted.rowCount !== 1) throw new Error('CDC writer delete was not exactly one row');
            }
            if (inTx) await client.query('COMMIT');
            inserted += 1;
            attempted += opEvents(kind);
            operations += 1;
          } catch (error) {
            if (inTx) {
              try { await client.query('ROLLBACK'); } catch { /* original failure wins */ }
            }
            throw error;
          }
          if (op < opsPerChunk - 1) await sleep(writerPaceMs);
        }
      } finally {
        await client.end();
      }
      return { inserted, attempted, operations };
    });
    // Every writer must close before a failed run may drop the test tables.
    const completed = await Promise.allSettled(jobs);
    const rejected = completed.find(outcome => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
    const result = completed.reduce((acc, outcome) => {
      acc.inserted += outcome.value.inserted;
      acc.attempted += outcome.value.attempted;
      acc.operations += outcome.value.operations;
      return acc;
    }, { inserted: 0, attempted: 0, operations: 0 });
    if (result.operations !== writers * opsPerChunk) {
      throw new Error('CDC workload did not execute every required writer operation');
    }
    return result;
  }

  // Streaming-ordering invariant: pgoutput emits complete transactions in commit
  // order, and row changes within one transaction are ordered by their WAL record.
  // Two concurrent writers therefore do NOT imply globally monotonic row LSNs in
  // emission order — a later transaction may carry earlier row-LSNs than a previous
  // transaction's commit. What is guaranteed (and what we assert):
  //   (a) commit LSNs are non-decreasing across the stream;
  //   (b) row LSNs within each transaction are non-decreasing.
  function recordStream(changes) {
    let lastCommit = null;
    let inTx = false;
    let txLastRow = null;
    for (const change of changes) {
      if (change.tag === 'begin') { inTx = true; txLastRow = null; continue; }
      if (change.tag === 'commit') {
        if (lastCommit && comparePostgresLsn(change.lsn, lastCommit) < 0) streamOrdered = false;
        lastCommit = change.lsn;
        inTx = false;
        continue;
      }
      if (inTx && ['insert', 'update', 'delete'].includes(change.tag)) {
        if (txLastRow && comparePostgresLsn(change.lsn, txLastRow) < 0) streamOrdered = false;
        txLastRow = change.lsn;
      }
    }
  }

  function checkResumeBound(rowChanges, priorCheckpoint) {
    if (!priorCheckpoint) return;
    for (const change of rowChanges) {
      if (comparePostgresLsn(change.lsn, priorCheckpoint) < 0) strictResume = false;
    }
  }

  const lastCheckpointLsn = changes => {
    const commits = changes.filter(change => change.tag === 'commit');
    return commits.length ? commits[commits.length - 1].lsn : changes.length ? changes[changes.length - 1].lsn : null;
  };

  try {
    adminClient = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await adminClient.connect();
    await adminClient.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await adminClient.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`);
    await adminClient.query(`ALTER TABLE public."${table}" REPLICA IDENTITY FULL`);

    await ensurePostgresPublication({ ref: dbRef, credentialBroker: broker, publicationName, tables: [{ schema: 'public', table }] });
    await dropPostgresReplicationSlot({ ref: dbRef, credentialBroker: broker, slotName });
    const slot = await createPostgresReplicationSlot({ ref: dbRef, credentialBroker: broker, slotName });
    if (slot.existed) throw new Error(`cdc soak slot ${slotName} unexpectedly already existed`);
    currentCheckpoint = slot.lsn;
    evidenceWriter.appendRaw({ scenario, event: 'cdc_soak_started', durationSec, writers, table, publication: publicationName, slot: slotName, initialCheckpoint: currentCheckpoint });

    checkpointDir = await mkdtemp(join(tmpdir(), 'spool-qualify-cdc-checkpoint-'));
    const store = createCdcCheckpointStore({ path: join(checkpointDir, 'cdc-checkpoint.db') });

    // Steady-state capture: each chunk writes its deterministic plan, then the real
    // SPOOL CDC connector streams from the durable cursor to the chunk waterline.
    const soakStart = process.hrtime.bigint();
    for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
      const chunkStart = Date.now();
      const applied = await writePlan(chunk);
      expectedInsertCount += applied.inserted;
      eventsAttempted += applied.attempted;
      // Flush anchor: a deterministic insert that is the last WAL record of the chunk,
      // guaranteeing the streaming stop condition observes a commit at the waterline.
      const anchorId = 5_000_000 + chunk;
      const anchored = await adminClient.query(`INSERT INTO public."${table}"(id, payload) VALUES ($1, $2)`, [anchorId, `anchor-${chunk}`]);
      if (anchored.rowCount !== 1) throw new Error('CDC anchor was not inserted exactly once');
      expectedInsertCount += 1;
      eventsAttempted += 1;
      const untilLsn = await flushLsn(adminClient);
      const streamed = await streamPostgresChanges({
        ref: dbRef, credentialBroker: broker, slotName, publicationNames: [publicationName],
        startLsn: currentCheckpoint, untilLsn, maxMessages: 1_000_000
      });
      const rowChanges = streamed.changes.filter(change => ['insert', 'update', 'delete'].includes(change.tag) && change.table === table);
      if (rowChanges.length !== applied.attempted + 1) {
        failures.push({ code: 'CDC_ACTUAL_EVENT_COUNT_MISMATCH',
          message: `chunk ${chunk} captured ${rowChanges.length} row events; expected ${applied.attempted + 1}`,
          expected: false, classification: 'CORRECTNESS' });
      }
      capturedChanges += rowChanges.length;
      insertCapturedTotal += rowChanges.filter(change => change.tag === 'insert').length;
      checkResumeBound(rowChanges, currentCheckpoint);
      recordStream(streamed.changes);
      currentCheckpoint = lastCheckpointLsn(streamed.changes) ?? currentCheckpoint;
      store.saveCheckpoint(slotName, currentCheckpoint);
      evidenceWriter.appendRaw({ scenario, event: 'cdc_chunk_captured', chunk, rowChanges: rowChanges.length, messages: streamed.changes.length, untilLsn, checkpoint: currentCheckpoint, streamOrdered, strictResume });

      const elapsed = Date.now() - chunkStart;
      if (elapsed < writerPaceMs * opsPerChunk) await sleep(writerPaceMs * opsPerChunk - elapsed);
    }

    const observedSoakMs = Number(process.hrtime.bigint() - soakStart) / 1e6;
    if (observedSoakMs < durationSec * 1000) {
      failures.push({ code: 'CDC_SOAK_UNDER_EXECUTED', message: 'Monotonic CDC duration was shorter than declared workload', expected: false, classification: 'HARNESS' });
    }

    // Concurrent-window proof: a capture whose waterline was fixed BEFORE a burst
    // commits must not see the burst (window bounded), and a fresh restart from that
    // capture's durable cursor must absorb the burst exactly once (no loss, no replay).
    const burstWriter = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await burstWriter.connect();
    await burstWriter.query(`INSERT INTO public."${table}"(id, payload) VALUES ($1, $2)`, [8_000_000, `window-marker`]);
    tailEvents += 1;
    const burstCount = Math.max(8, opsPerChunk * writers * 2);
    // marker + burst rows are deterministic captures within the evidence set
    expectedInsertCount += 1 + burstCount;
    eventsAttempted += 1 + burstCount;
    const waterline = await flushLsn(adminClient);

    const streamPromise = streamPostgresChanges({
      ref: dbRef, credentialBroker: broker, slotName, publicationNames: [publicationName],
      startLsn: currentCheckpoint, untilLsn: waterline, maxMessages: 1_000_000
    });
    const burstPromise = (async () => {
      try {
        const idBase = 9_000_000;
        for (let i = 0; i < burstCount; i += 1) {
          await burstWriter.query(`INSERT INTO public."${table}"(id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [idBase + i, `tail-${i}`]);
          tailEvents += 1;
        }
      } finally {
        await burstWriter.end();
      }
    })();

    const [windowResult, burstResult] = await Promise.all([streamPromise, burstPromise]);
    const windowRows = windowResult.changes.filter(change => ['insert', 'update', 'delete'].includes(change.tag) && change.table === table);
    if (windowRows.some(change => change.row?.id >= 9_000_000)) windowBounded = false;
    // The in-flight capture stops at the marker: it must contain exactly the window row.
    if (windowRows.length !== 1) {
      failures.push({ code: 'CDC_WINDOW_CONSISTENCY', message: `in-flight capture saw ${windowRows.length} rows, expected exactly the window marker`, expected: false, classification: 'CORRECTNESS' });
    }
    tailCaptured += windowRows.length;
    insertCapturedTotal += windowRows.filter(change => change.tag === 'insert').length;
    currentCheckpoint = lastCheckpointLsn(windowResult.changes) ?? currentCheckpoint;
    store.saveCheckpoint(slotName, currentCheckpoint);

    const tailUntil = await flushLsn(adminClient);
    const resume = await streamPostgresChanges({
      ref: dbRef, credentialBroker: broker, slotName, publicationNames: [publicationName],
      startLsn: currentCheckpoint, untilLsn: tailUntil, maxMessages: 1_000_000
    });
    const resumeRows = resume.changes.filter(change => ['insert', 'update', 'delete'].includes(change.tag) && change.table === table);
    checkResumeBound(resumeRows, currentCheckpoint);
    recordStream(resume.changes);
    if (resumeRows.some(change => change.row?.id < 9_000_000)) windowBounded = false;
    tailCaptured += resumeRows.length;
    insertCapturedTotal += resumeRows.filter(change => change.tag === 'insert').length;
    currentCheckpoint = lastCheckpointLsn(resume.changes) ?? currentCheckpoint;
    store.saveCheckpoint(slotName, currentCheckpoint);
    evidenceWriter.appendRaw({
      scenario, event: 'cdc_cursor_restart', checkpoint: currentCheckpoint, tailEvents, tailCaptured, windowBounded,
      inFlightWindowRows: windowRows.length, resumeRows: resumeRows.length, streamOrdered, strictResume
    });

    if (!windowBounded) {
      failures.push({ code: 'CDC_WINDOW_VIOLATION', message: 'capture observed rows outside its waterline-bounded window', expected: false, classification: 'CORRECTNESS' });
    }
    if (tailCaptured !== tailEvents) {
      failures.push({ code: 'CDC_TAIL_LOSS', message: `cursor restart captured ${tailCaptured} tail events, expected ${tailEvents}`, expected: false, classification: 'CORRECTNESS' });
    }

    const lagRes = await adminClient.query('SELECT pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_flush_lsn()::pg_lsn, $1::pg_lsn)::bigint AS bytes', [currentCheckpoint]);
    lastLagBytes = lagRes.rows[0].bytes;

    // Slot-loss fail-closed: streaming against a dropped slot must refuse loudly, never
    // continue silently; recovery requires an operator call (REPLICATION_SLOT_LOST).
    await dropPostgresReplicationSlot({ ref: dbRef, credentialBroker: broker, slotName });
    let slotLossDetected = false;
    let slotLossCode = null;
    try {
      const probeUntil = await flushLsn(adminClient);
      await streamPostgresChanges({
        ref: dbRef, credentialBroker: broker, slotName, publicationNames: [publicationName],
        startLsn: currentCheckpoint, untilLsn: probeUntil, maxMessages: 100
      });
    } catch (error) {
      slotLossDetected = true;
      slotLossCode = error?.code ?? 'UNKNOWN';
      evidenceWriter.appendRaw({ scenario, event: 'slot_loss_fail_closed', code: slotLossCode, message: error?.message });
    }
    if (!slotLossDetected) {
      failures.push({ code: 'SLOT_LOSS_FAIL_CLOSED_VIOLATED', message: 'streaming continued after the replication slot was dropped', expected: false, classification: 'CORRECTNESS' });
    }

    if (!strictResume) {
      failures.push({ code: 'CDC_RESTART_REPLAY', message: 'resumed stream replayed rows below the durable checkpoint', expected: false, classification: 'CORRECTNESS' });
    }
    if (!streamOrdered) {
      failures.push({ code: 'CDC_STREAM_ORDER_VIOLATION', message: 'change stream violated commit or per-transaction ordering', expected: false, classification: 'CORRECTNESS' });
    }
    if (insertCapturedTotal !== expectedInsertCount) {
      failures.push({ code: 'CDC_INSERT_COUNT_MISMATCH', message: `captured ${insertCapturedTotal} insert changes, expected ${expectedInsertCount}`, expected: false, classification: 'CORRECTNESS' });
    }

    store.close();
    await rm(checkpointDir, { recursive: true, force: true });
    checkpointDir = null;
    await adminClient.end(); adminClient = null;

    const metrics = {
      scenario,
      requestedConfig: { cdcDurationSeconds: profile.cdcDurationSeconds, writers: profile.writers },
      effectiveConfig,
      durationSec,
      observedSoakMs,
      writers,
      chunks: CHUNKS,
      eventsAttempted,
      expectedInsertCount,
      capturedChanges,
      insertCapturedTotal,
      tailEvents,
      tailCaptured,
      windowBounded,
      strictResume,
      streamOrdered,
      slotLossDetected,
      slotLossCode,
      lagBytes: lastLagBytes,
      checkpoint: currentCheckpoint,
      status: failures.length ? 'FAIL' : 'PASS'
    };
    evidenceWriter.appendRaw({ scenario, event: 'cdc_soak_completed', ...metrics });
    return { metrics, failures };
  } catch (e) {
    throw e;
  } finally {
    try { if (checkpointDir) await rm(checkpointDir, { recursive: true, force: true }); } catch {}
    try { if (adminClient) await adminClient.end(); } catch {}
    try {
      const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await c.connect();
      await dropPostgresReplicationSlot({ ref: dbRef, credentialBroker: broker, slotName }).catch(() => {});
      await c.query(`DROP PUBLICATION IF EXISTS "${publicationName}"`).catch(() => {});
      await c.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`).catch(() => {});
      await c.end();
    } catch {}
  }
}