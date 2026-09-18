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
  const durationSec = Math.min(profile.cdcDurationSeconds, 30);
  const writers = Math.min(profile.writers, 2);
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

  const CHUNKS = Math.max(4, Math.min(12, Math.floor(durationSec / 3)));
  const opsPerChunk = Math.max(4, Math.floor((durationSec * 1000) / (30 * CHUNKS)));
  const writerPaceMs = Math.max(1, Math.floor((durationSec * 1000) / (CHUNKS * opsPerChunk)));

  // Deterministic per-chunk plan: op indices advance globally so capture order is stable.
  // update/delete ops may target rows that do not exist yet and emit no change message,
  // so equality is asserted on unique insert captures only; all captured changes still
  // carry monotonicity and resume-bound checks below.
  const plans = [];
  let expectedInsertCount = 0;
  let eventsAttempted = 0;
  for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
    const chunkPlans = Array.from({ length: writers }, () => []);
    for (let wi = 0; wi < writers; wi += 1) {
      for (let op = 0; op < opsPerChunk; op += 1) {
        const opIndex = chunk * opsPerChunk * writers + wi * opsPerChunk + op;
        const kind = opMix(wi, opIndex);
        eventsAttempted += opEvents(kind);
        if (kind === 'insert') expectedInsertCount += 1;
        chunkPlans[wi].push({ opIndex, kind });
      }
    }
    plans.push(chunkPlans);
  }

  let capturedChanges = 0;
  let insertCapturedTotal = 0;
  let currentCheckpoint = null;
  let streamOrdered = true;
  let strictResume = true;
  let tailEvents = 0;
  let tailCaptured = 0;
  let windowBounded = true;
  let lastLagBytes = null;

  async function writePlan(plan) {
    const tasks = Array.from({ length: writers }, async (_, wi) => {
      const wClient = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await wClient.connect();
      try {
        const ops = plan[wi];
        for (let i = 0; i < ops.length; i += 1) {
          const { opIndex, kind } = ops[i];
          const baseId = wi * 1_000_000 + opIndex;
          try {
            if (kind === 'insert') {
              await wClient.query(`INSERT INTO public."${table}"(id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [baseId + 1, `payload-${opIndex}`]);
            } else if (kind === 'update') {
              await wClient.query(`UPDATE public."${table}" SET payload = $2 WHERE id = $1`, [baseId % 200 + 1, `updated-${opIndex}`]);
            } else if (kind === 'delete') {
              await wClient.query(`DELETE FROM public."${table}" WHERE id = $1`, [baseId % 200 + 1]);
            } else {
              const multiId = baseId + 100_000;
              await wClient.query(`BEGIN; INSERT INTO public."${table}"(id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING; UPDATE public."${table}" SET payload = $3 WHERE id = $4; COMMIT`, [multiId, `m-${opIndex}`, `mu-${opIndex}`, multiId % 200 + 1]);
            }
          } catch {}
          if (i < ops.length - 1) await sleep(writerPaceMs);
        }
      } finally {
        await wClient.end();
      }
    });
    await Promise.all(tasks);
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
    for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
      const chunkStart = Date.now();
      await writePlan(plans[chunk]);
      // Flush anchor: a deterministic insert that is the last WAL record of the chunk,
      // guaranteeing the streaming stop condition observes a commit at the waterline.
      const anchorId = 5_000_000 + chunk;
      await adminClient.query(`INSERT INTO public."${table}"(id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [anchorId, `anchor-${chunk}`]);
      expectedInsertCount += 1;
      eventsAttempted += 1;
      const untilLsn = await flushLsn(adminClient);
      const streamed = await streamPostgresChanges({
        ref: dbRef, credentialBroker: broker, slotName, publicationNames: [publicationName],
        startLsn: currentCheckpoint, untilLsn, maxMessages: 1_000_000
      });
      const rowChanges = streamed.changes.filter(change => ['insert', 'update', 'delete'].includes(change.tag) && change.table === table);
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
      durationSec,
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