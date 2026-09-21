import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { randomUUID, createHash } from 'node:crypto';
import { fail } from '../../core/errors.js';
import { sha256Canonical, canonicalJson } from '../../platform/canonical-json.js';
import { parsePostgresEndpoint, withPostgresClient } from './connection.js';
import { MigrationEngine } from '../../core/migration.js';
import { compileMapping } from '../../core/transforms.js';
import { connectorIdentity } from '../../platform/contracts.js';
import {
  comparePostgresLsn,
  normalizeMessage,
  classifyCdcStreamError,
  describePostgresSlot,
  assertSlotContractUsable
} from './cdc.js';
import { postgresContentRowHash } from './row-codec.js';

const LSN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
// Bounded wait for replication start: the subscribe() promise never settles
// while the stream is healthy, so a stream that never starts must fail
// loudly rather than hang the pump (or the drain, or cutover).
const SUBSCRIBE_START_TIMEOUT_MS = 30_000;
const CDC_BATCH_DOMAIN = 'spool-cdc-batch-v1';

function requireLsn(value, label) {
  if (typeof value !== 'string' || !LSN.test(value)) fail('INVALID_CDC_POSITION', `${label} must be a valid PostgreSQL LSN`);
  return value.toUpperCase();
}

// CDC batch identity: binds one source transaction application to the exact
// migration/plan/snapshot/mapping/target/fence context plus the transaction
// commit LSN and content hash. The same source transaction applied twice
// yields the same identity, so the target ledger reconciles replays as
// already-committed instead of duplicating rows.
export function createCdcBatchIdentity({ migrationId, planId, sourceSnapshotId, mappingRevision, targetIdentity, xid, commitLsn, payloadHash, rowCount } = {}) {
  if (typeof migrationId !== 'string' || !migrationId) fail('INVALID_CDC_BATCH', 'migrationId is required');
  if (typeof planId !== 'string' || !planId) fail('INVALID_CDC_BATCH', 'planId is required');
  if (typeof sourceSnapshotId !== 'string' || !sourceSnapshotId) fail('INVALID_CDC_BATCH', 'sourceSnapshotId is required');
  if (!Number.isInteger(mappingRevision) || mappingRevision < 1) fail('INVALID_CDC_BATCH', 'mappingRevision must be >= 1');
  if (!Number.isInteger(xid) || xid < 0) fail('INVALID_CDC_BATCH', 'xid must be a non-negative integer');
  requireLsn(commitLsn, 'commitLsn');
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) fail('INVALID_CDC_BATCH', 'rowCount must be a non-negative safe integer');
  return sha256Canonical(CDC_BATCH_DOMAIN, {
    migrationId,
    planId,
    sourceSnapshotId,
    mappingRevision,
    targetIdentity: connectorIdentity(targetIdentity),
    sourceTransaction: { xid, commitLsn: commitLsn.toUpperCase() },
    payloadHash,
    rowCount
  });
}

function eventBytes(change) {
  return Buffer.byteLength(canonicalJson(change), 'utf8');
}

// Bounded fixed-capacity circular buffer for debug history. O(1) insertion
// via head/length over a preallocated array — no Array.shift() compaction.
// Production correctness never depends on retained history; limit 0 retains
// nothing and allocates only the frozen handle.
export function createRingBuffer(limit = 1000) {
  if (!Number.isSafeInteger(limit) || limit < 0) fail('INVALID_CDC_BUFFER', 'ring buffer limit must be a non-negative safe integer');
  if (limit === 0) {
    return Object.freeze({
      limit,
      push() {},
      values() { return Object.freeze([]); },
      size() { return 0; }
    });
  }
  const slots = new Array(limit);
  let head = 0;
  let length = 0;
  return Object.freeze({
    limit,
    push(item) {
      slots[(head + length) % limit] = item;
      if (length < limit) length += 1;
      else head = (head + 1) % limit;
    },
    values() {
      const ordered = new Array(length);
      for (let i = 0; i < length; i++) ordered[i] = slots[(head + i) % limit];
      return Object.freeze(ordered);
    },
    size() {
      return length;
    }
  });
}

// Serialized PostgreSQL transaction assembler. pgoutput emits complete
// transactions in commit order; the assembler buffers one open transaction,
// enforces commit-LSN monotonicity, and spills oversized transactions to
// durable local staging so arbitrarily large source transactions cannot
// exhaust process memory.
export function createCdcTransactionAssembler({ maxInMemoryBytes = 4 * 1024 * 1024, maxInMemoryEvents = 10000, stagingDir = null } = {}) {
  if (!Number.isSafeInteger(maxInMemoryBytes) || maxInMemoryBytes < 1024) fail('INVALID_CDC_ASSEMBLER', 'maxInMemoryBytes must be >= 1024');
  if (!Number.isSafeInteger(maxInMemoryEvents) || maxInMemoryEvents < 1) fail('INVALID_CDC_ASSEMBLER', 'maxInMemoryEvents must be >= 1');
  let current = null;
  let lastCommitLsn = null;
  let stagedCount = 0;

  function spillPath(xid) {
    if (!stagingDir) fail('CDC_TRANSACTION_TOO_LARGE', 'Source transaction exceeds in-memory assembly limits and no staging directory is configured', { xid });
    return join(stagingDir, `cdc-tx-${xid}.jsonl`);
  }

  async function spillEvent(tx, change) {
    await mkdir(stagingDir, { recursive: true });
    const stream = createWriteStream(spillPath(tx.xid), { flags: 'a', encoding: 'utf8' });
    await new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.write(`${canonicalJson(change)}\n`, 'utf8', error => {
        if (error) reject(error);
        else resolve();
      });
      stream.end();
    });
    tx.spilled = true;
    tx.spillBytes = (tx.spillBytes ?? 0) + eventBytes(change);
  }

  // Streaming staged reader: yields spilled events one line at a time so a
  // multi-million-event source transaction never materializes as a JS array.
  // Callers needing two passes (identity hash, then apply) simply iterate
  // twice; the file is sequential and cheap to re-stream.
  async function *streamStaged(xid) {
    const stream = createReadStream(spillPath(xid), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line);
    }
  }

  return Object.freeze({
    async feed(change) {
      if (!change || typeof change !== 'object') fail('CDC_PROTOCOL_VIOLATION', 'CDC change must be an object');
      if (change.tag === 'begin') {
        if (current) fail('CDC_PROTOCOL_VIOLATION', 'Nested BEGIN inside an open CDC transaction', { xid: current.xid });
        current = { xid: change.xid ?? 0, beginLsn: change.lsn, events: [], bytes: 0, spilled: false, spillBytes: 0 };
        stagedCount = 0;
        return null;
      }
      if (change.tag === 'commit') {
        if (!current) fail('CDC_PROTOCOL_VIOLATION', 'COMMIT without an open CDC transaction');
        if (lastCommitLsn && comparePostgresLsn(change.lsn, lastCommitLsn) < 0) {
          fail('CDC_ORDER_VIOLATION', 'CDC commit LSN moved backwards; transaction order is broken', {
            previous: lastCommitLsn, current: change.lsn
          });
        }
        // The finalized value is a HANDLE, not the event array: memory holds
        // at most maxInMemoryEvents oldest events, the staging file the
        // newest. Consumers stream arrival order via iterateTransactionEvents
        // (memory first, then the staged file). Materializing the merge here
        // would defeat the memory bound for huge source transactions.
        const eventCount = current.events.length + stagedCount;
        const completed = Object.freeze({
          xid: current.xid,
          beginLsn: current.beginLsn,
          commitLsn: change.lsn,
          commitEndLsn: change.commitEndLsn ?? null,
          memoryEvents: Object.freeze([...current.events]),
          eventCount,
          spilled: current.spilled,
          stagedEvents: stagedCount,
          stagedBytes: current.spillBytes ?? 0
        });
        lastCommitLsn = change.lsn;
        current = null;
        stagedCount = 0;
        return completed;
      }
      if (!['insert', 'update', 'delete', 'truncate'].includes(change.tag)) return null;
      if (!current) fail('CDC_PROTOCOL_VIOLATION', `Row change outside a CDC transaction: ${change.tag}`);
      const size = eventBytes(change);
      current.bytes += size;
      if (current.bytes > maxInMemoryBytes || current.events.length + stagedCount >= maxInMemoryEvents) {
        // Spill OLDEST buffered events first to keep memory bounded, newest
        // stay in memory for locality. Simplest correct scheme: spill the
        // incoming event and keep counting; finalize merges staged+memory.
        await spillEvent(current, change);
        stagedCount += 1;
      } else {
        current.events.push(change);
      }
      return null;
    },
    async finish() {
      if (current) {
        fail('CDC_TRANSACTION_INCOMPLETE', 'CDC stream ended with an uncommitted open transaction; refusing to silently drop it', {
          xid: current.xid, bufferedEvents: current.events.length + stagedCount
        });
      }
      return null;
    },
    // Peek for waterline termination: the pump may stop on an idle stream
    // only when no transaction is open, so an in-flight transaction is never
    // abandoned at the waterline.
    hasOpenTransaction() {
      return current != null;
    },
    async discardStaged(xid) {
      if (!stagingDir) return;
      try { await rm(spillPath(xid), { force: true }); } catch {}
    },
    async listStaged() {
      if (!stagingDir) return Object.freeze([]);
      let files;
      try {
        files = await readdir(stagingDir);
      } catch {
        return Object.freeze([]);
      }
      const xids = [];
      for (const file of files) {
        const match = /^cdc-tx-(\d+)\.jsonl$/.exec(basename(file));
        if (match) xids.push(Number(match[1]));
      }
      return Object.freeze(xids.sort((a, b) => a - b));
    },
    async recoverStaged(xid) {
      // Recover a staging handle left behind by a crash without
      // materializing it. The caller counts streamed events for evidence,
      // re-applies through the normal idempotent path (ledger
      // reconciliation absorbs already-committed work), then discards it.
      let eventCount = 0;
      for await (const _ignored of streamStaged(xid)) eventCount += 1;
      return Object.freeze({ xid, memoryEvents: Object.freeze([]), eventCount, spilled: true, stagedEvents: eventCount, stagedBytes: null });
    }
  });
}

// Stream one finalized transaction handle in arrival order: bounded memory
// events first, then the durable spill segments. Peak memory scales with the
// configured chunk/segment size, never with source transaction size.
export async function *iterateTransactionEvents(handle, { stagingDir = null } = {}) {
  if (!handle || typeof handle !== 'object') fail('INVALID_CDC_TRANSACTION', 'A finalized CDC transaction handle is required');
  for (const event of handle.memoryEvents ?? []) yield event;
  if (handle.spilled === true) {
    if (!stagingDir) fail('CDC_STAGING_REQUIRED', 'Spilled transaction requires its staging directory to stream', { xid: handle.xid });
    const stream = createReadStream(join(stagingDir, `cdc-tx-${handle.xid}.jsonl`), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line);
    }
  }
}

const CDC_TRANSACTION_DOMAIN = 'spool-cdc-transaction-v1';

// Identity binding the COMPLETE source transaction: migration/plan/
// snapshot/mapping/target/fence context plus xid, begin/commit LSN, ordered
// mutation count and the incremental ordered-payload hash. One source
// transaction maps to exactly one target ledger record — never independent
// upsert/delete batch identities.
export function createCdcTransactionIdentity({ migrationId, planId, sourceSnapshotId, mappingRevision, targetIdentity, xid, beginLsn, commitLsn, mutationCount, payloadHash } = {}) {
  if (typeof migrationId !== 'string' || !migrationId) fail('INVALID_CDC_TRANSACTION', 'migrationId is required');
  if (typeof planId !== 'string' || !planId) fail('INVALID_CDC_TRANSACTION', 'planId is required');
  if (typeof sourceSnapshotId !== 'string' || !sourceSnapshotId) fail('INVALID_CDC_TRANSACTION', 'sourceSnapshotId is required');
  if (!Number.isInteger(mappingRevision) || mappingRevision < 1) fail('INVALID_CDC_TRANSACTION', 'mappingRevision must be >= 1');
  if (!Number.isSafeInteger(xid) || xid < 0) fail('INVALID_CDC_TRANSACTION', 'xid must be a non-negative safe integer');
  requireLsn(beginLsn, 'beginLsn');
  requireLsn(commitLsn, 'commitLsn');
  if (!Number.isSafeInteger(mutationCount) || mutationCount < 0) fail('INVALID_CDC_TRANSACTION', 'mutationCount must be a non-negative safe integer');
  if (typeof payloadHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(payloadHash)) fail('INVALID_CDC_TRANSACTION', 'payloadHash must be a canonical sha256 identity');
  return sha256Canonical(CDC_TRANSACTION_DOMAIN, {
    migrationId,
    planId,
    sourceSnapshotId,
    mappingRevision,
    targetIdentity: connectorIdentity(targetIdentity),
    sourceTransaction: { xid, beginLsn: beginLsn.toUpperCase(), commitLsn: commitLsn.toUpperCase() },
    mutationCount,
    payloadHash
  });
}

// Incremental ordered-payload hash over a mutation stream: each canonical
// mutation record is length-framed into a running SHA-256, so the hash binds
// exact order without buffering the stream.
export function hashOrderedMutations(mutations) {
  const digest = createHash('sha256');
  let count = 0;
  const feed = record => {
    const text = canonicalJson(record);
    digest.update(`${Buffer.byteLength(text, 'utf8')}:`, 'utf8');
    digest.update(text, 'utf8');
    count += 1;
  };
  if (typeof mutations?.[Symbol.asyncIterator] === 'function') {
    return (async () => {
      for await (const mutation of mutations) feed(mutation);
      return Object.freeze({ payloadHash: `sha256:${digest.digest('hex')}`, mutationCount: count });
    })();
  }
  for (const mutation of mutations ?? []) feed(mutation);
  return Object.freeze({ payloadHash: `sha256:${digest.digest('hex')}`, mutationCount: count });
}

// Map one assembled source transaction to target mutations through the
// migration plan mapping. Transform is row-local (MigrationEngine carries no
// cross-row transform state); a source row the mapping rejects fails the
// transaction closed (CDC_TRANSFORM_REJECTED) rather than being silently
// dropped — a dropped row would be undetectable data loss.
function pickKey(row, primaryKey) {
  const key = {};
  for (const field of primaryKey) {
    if (row[field] === null || row[field] === undefined) {
      fail('CDC_ROW_UNMAPPABLE', `Mapped row is missing primary-key field ${field}`);
    }
    key[field] = row[field];
  }
  return key;
}

// Discover the live primary-key column list for CDC keying. The caller may
// supply an expected key; a mismatch with the live primary key fails closed
// (CDC_PRIMARY_KEY_MISMATCH) instead of applying by the wrong key.
export async function discoverTargetPrimaryKey({ targetRef, credentialBroker, expected = null } = {}) {
  if (!targetRef || typeof targetRef !== 'object') fail('INVALID_CDC_APPLY_TARGET', 'targetRef is required');
  const live = await withPostgresClient({ targetRef, credentialBroker }, async client => {
    const result = await client.query(
      `SELECT a.attname AS "column"
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
       WHERE n.nspname = $1 AND t.relname = $2 AND i.indisprimary AND i.indisvalid AND i.indisready
       ORDER BY array_position(i.indkey, a.attnum)`,
      [targetRef.schema, targetRef.table]
    );
    return result.rows.map(row => row.column);
  });
  if (live.length === 0) fail('CDC_PRIMARY_KEY_UNKNOWN', 'Target table has no valid ready primary key for CDC keying', { table: `${targetRef.schema}.${targetRef.table}` });
  if (expected != null) {
    const same = Array.isArray(expected) && expected.length === live.length && expected.every((field, index) => field === live[index]);
    if (!same) {
      fail('CDC_PRIMARY_KEY_MISMATCH', 'Supplied CDC primary key does not match the live target primary key', {
        expected: live, supplied: expected
      });
    }
  }
  return Object.freeze(live);
}

// Serialized CDC applier: replication messages arrive on an EventEmitter
// (whose async listeners do NOT serialize), so the handler only enqueues
// while a single pump loop assembles, applies, checkpoints, and acknowledges
// strictly in order. The guaranteed per-transaction order is:
//   receive -> validate/map -> fenced target commit (+ledger) ->
//   durable checkpoint persist -> source acknowledgement.
// Acknowledgement therefore always trails durability; a crash before ack
// replays through ledger reconciliation, a crash after ack is already proven.
function requireSourceTable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CDC_APPLY_CONFIG', 'sourceTable is required');
  if (typeof value.schema !== 'string' || !value.schema || typeof value.table !== 'string' || !value.table) {
    fail('INVALID_CDC_APPLY_CONFIG', 'sourceTable.schema and sourceTable.table are required');
  }
  return Object.freeze({ schema: value.schema, table: value.table });
}

export function createCdcApplier({
  ref, credentialBroker, slotName, publicationNames,
  migration, plan, targetContractId, primaryKey, sourceTable,
  target, checkpoint, renewFence, ownerEpoch,
  startLsn = null, untilLsn = null, maxTransactions = null,
  assemblerOptions = {}, stagingDir = null, debugHistoryLimit = 1000,
  maxQueueMessages = 50000, maxReconnects = 5, maxCdcTransactionMutations = 5000000,
  onTransaction = null
} = {}) {
  if (!ref || typeof ref !== 'object') fail('INVALID_CDC_APPLY_CONFIG', 'source ref is required');
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_CDC_APPLY_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof slotName !== 'string' || !slotName) fail('INVALID_CDC_APPLY_CONFIG', 'slotName is required');
  if (!Array.isArray(publicationNames) || publicationNames.length === 0) fail('INVALID_CDC_APPLY_CONFIG', 'publicationNames must be a non-empty array');
  if (!migration || typeof migration.migrationId !== 'string' || typeof migration.sourceSnapshotId !== 'string') {
    fail('INVALID_CDC_APPLY_CONFIG', 'migration.migrationId and migration.sourceSnapshotId are required');
  }
  if (!plan || typeof plan.planId !== 'string' || !Number.isInteger(plan.mappingRevision) || plan.mappingRevision < 1) {
    fail('INVALID_CDC_APPLY_CONFIG', 'plan.planId and plan.mappingRevision are required');
  }
  if (!Array.isArray(primaryKey) || primaryKey.length === 0) fail('INVALID_CDC_APPLY_CONFIG', 'primaryKey is required');
  const source = requireSourceTable(sourceTable);
  if (!target || typeof target.commitCdcTransaction !== 'function') {
    fail('INVALID_CDC_APPLY_CONFIG', 'an opened target with atomic CDC transaction commits is required');
  }
  if (!checkpoint || typeof checkpoint.load !== 'function' || typeof checkpoint.save !== 'function') {
    fail('INVALID_CDC_APPLY_CONFIG', 'checkpoint store with load/save is required');
  }
  if (typeof renewFence !== 'function') fail('INVALID_CDC_APPLY_CONFIG', 'renewFence callback is required');
  if (typeof ownerEpoch !== 'string' || !ownerEpoch) fail('INVALID_CDC_APPLY_CONFIG', 'ownerEpoch is required');
  if (startLsn != null) requireLsn(startLsn, 'startLsn');
  if (untilLsn != null) requireLsn(untilLsn, 'untilLsn');
  if (maxTransactions != null && (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1)) {
    fail('INVALID_CDC_APPLY_CONFIG', 'maxTransactions must be a positive safe integer');
  }

  const assembler = createCdcTransactionAssembler({ ...assemblerOptions, stagingDir });
  // Shared server-ack state (applier scope, visible to both the per-
  // transaction checkpoint writer and the stream pump): pending names the
  // latest applied-but-unacked LSN, last the latest server-acked one.
  const ACK_BATCH_TXNS = 50;
  const ACK_BATCH_MS = 2000;
  const serverAck = { pending: null, last: null, atCount: 0, atMs: Date.now() };
  const history = createRingBuffer(debugHistoryLimit);
  const metrics = {
    receivedMessages: 0, receivedTransactions: 0, appliedTransactions: 0,
    recoveredTransactions: 0, spilledTransactions: 0, skippedMissingDeletes: 0,
    reconnects: 0, lastCommitLsn: null
  };

  function isRetryableCdcTransportError(error) {
    if (!error || typeof error !== 'object') return false;
    const retryable = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', '57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004', '08007', '08P01', '40001', '40P01']);
    if (error.code && retryable.has(String(error.code))) return true;
    return /connection|timeout|terminat|closed|reset|broken pipe/i.test(String(error.message ?? ''));
  }

  return Object.freeze({
    metrics: () => Object.freeze({ ...metrics }),
    history: () => history.values(),
    async run() {
      // Validate the slot contract before consuming: same name with wrong
      // plugin/database/type fails closed here, never silently reused.
      const slotRecord = await describePostgresSlot({ ref, credentialBroker, slotName });
      assertSlotContractUsable({ slot: slotRecord, database: ref.database, plugin: 'pgoutput', slotName });

      // Fence + checkpoint snapshot for this run. The lease is renewed ahead
      // of the first apply and then at most every FENCE_RENEW_INTERVAL_MS:
      // renewal only extends expiry (same owner keeps its token), while the
      // synchronous in-commit fence check inside every target commit is the
      // real per-transaction stale-owner guard. Renewing a lease per
      // transaction would collapse throughput at volume with zero added
      // safety; the checkpoint version is still reloaded after reconnects.
      // The 5s interval assumes lease TTLs comfortably above it (service
      // default is 5 minutes): a lapsed lease fails the next commit closed
      // with LEASE_EXPIRED rather than committing unfenced.
      const FENCE_RENEW_INTERVAL_MS = 5000;
      let fenceToken = await renewFence();
      if (!Number.isSafeInteger(fenceToken) || fenceToken < 1) fail('FENCE_REQUIRED', 'CDC apply requires a fresh fence token');
      let fenceRenewedAt = Date.now();
      serverAck.pending = null;
      serverAck.last = null;
      serverAck.atCount = metrics.appliedTransactions;
      serverAck.atMs = Date.now();
      let stored = await checkpoint.load();
      let expectedVersion = stored?.version ?? 0;

      const applyOneTransaction = async tx => {
        if (Date.now() - fenceRenewedAt >= FENCE_RENEW_INTERVAL_MS) {
          fenceToken = await renewFence();
          if (!Number.isSafeInteger(fenceToken) || fenceToken < 1) fail('FENCE_REQUIRED', 'CDC apply requires a fresh fence token');
          fenceRenewedAt = Date.now();
        }
        const result = await applyCdcTransaction({
          target,
          migration,
          plan: { ...plan, targetRef: plan.targetRef },
          targetContractId,
          fencingToken: fenceToken,
          transaction: tx,
          primaryKey,
          sourceTable: source,
          stagingDir,
          maxMutations: maxCdcTransactionMutations
        });
        // Exact replay counts come from the target ledger row on recovery,
        // so the checkpoint carries watermarks only. acknowledgedLsn is the
        // last SERVER-acked LSN (honestly behind appliedLsn mid-batch);
        // resume uses appliedLsn first, server replay reconciles via ledger.
        const saved = await checkpoint.save({
          slot: slotName,
          expectedVersion,
          ownerEpoch,
          fenceToken,
          receivedLsn: tx.commitLsn,
          appliedLsn: tx.commitLsn,
          acknowledgedLsn: serverAck.last ?? null
        });
        expectedVersion = saved.version;
        metrics.appliedTransactions += 1;
        if (result.recovered) metrics.recoveredTransactions += 1;
        if (tx.spilled) metrics.spilledTransactions += 1;
        metrics.skippedMissingDeletes += result.skippedMissingCount ?? result.skippedMissing.length;
        metrics.lastCommitLsn = tx.commitLsn;
        history.push({ commitLsn: tx.commitLsn, eventCount: tx.eventCount ?? 0, recovered: result.recovered, spilled: tx.spilled === true });
        if (onTransaction) await onTransaction(result);
        return { result, ackLsn: tx.commitLsn };
      };

      // Discard transactions staged (spilled) by a crashed predecessor. This is
      // safe — never data loss — because watermarks advance only for COMPLETE
      // transactions: anything staged-but-unapplied sits at or after the
      // durable watermark and will be re-delivered by the live stream from
      // the resume position below. Re-applying from staging instead would
      // risk double-apply outside the watermark protocol.
      for (const xid of await assembler.listStaged()) {
        await assembler.discardStaged(xid);
        metrics.spilledTransactions += 1;
      }

      // Resume position: durable applied watermark wins over the caller hint.
      stored = await checkpoint.load();
      expectedVersion = stored?.version ?? expectedVersion;
      let resumeLsn = stored?.appliedLsn ?? stored?.acknowledgedLsn ?? startLsn;
      let reconnectsLeft = maxReconnects;
      let appliedCount = metrics.appliedTransactions;

      // Bounded drains must terminate even when the resume position already
      // reaches the waterline (drain retry, idle source): subscribing and
      // waiting for a transaction that will never arrive would hang.
      if (untilLsn != null && resumeLsn != null && comparePostgresLsn(resumeLsn, untilLsn) >= 0) {
        const current = await checkpoint.load();
        return Object.freeze({
          ...metrics,
          appliedCount,
          resumeLsn,
          receivedLsn: current?.receivedLsn ?? null,
          appliedLsn: current?.appliedLsn ?? null,
          acknowledgedLsn: current?.acknowledgedLsn ?? null
        });
      }

      for (;;) {
        try {
          const outcome = await subscribeAndPump(resumeLsn, applyOneTransaction);
          resumeLsn = outcome.resumeLsn;
          appliedCount = metrics.appliedTransactions;
          if (outcome.finished) break;
        } catch (error) {
          // Slot loss and WAL loss are operator decisions, never retried:
          // silently recreating a slot would skip source history.
          if (error?.code === 'CDC_SLOT_LOST' || error?.code === 'CDC_WAL_UNAVAILABLE') throw error;
          if (isRetryableCdcTransportError(error) && reconnectsLeft > 0) {
            reconnectsLeft -= 1;
            metrics.reconnects += 1;
            // Re-read the durable watermark: another owner may have advanced
            // (or this process crashed and restarted) — never resume from
            // volatile memory after a transport failure.
            stored = await checkpoint.load();
            expectedVersion = stored?.version ?? expectedVersion;
            resumeLsn = stored?.appliedLsn ?? stored?.acknowledgedLsn ?? resumeLsn;
            continue;
          }
          throw error;
        }
        break;
      }
      try { await assembler.finish(); } catch (error) {
        // An uncommitted trailing transaction at stream end is data at risk,
        // never a clean stop.
        throw error;
      }
      // Watermarks for binding progress: reloaded from the durable checkpoint
      // (null when nothing was ever applied), never reconstructed from memory.
      stored = await checkpoint.load();
      return Object.freeze({
        ...metrics,
        appliedCount,
        resumeLsn,
        receivedLsn: stored?.receivedLsn ?? null,
        appliedLsn: stored?.appliedLsn ?? null,
        acknowledgedLsn: stored?.acknowledgedLsn ?? null
      });
    }
  });

  // Subscribe from a durable position and pump exactly one transaction at a
  // time through apply -> checkpoint -> ack. The replication secret never
  // leaves the broker callback scope: the whole subscription lives inside it.
  async function subscribeAndPump(fromLsn, applyOneTransaction) {
    return credentialBroker.withSecret(ref.secretRef, async password => {
      if (typeof password !== 'string' || !password) fail('SECRET_NOT_FOUND', 'PostgreSQL password is required');
      const parsed = parsePostgresEndpoint(ref.endpoint);
      const service = new LogicalReplicationService(
        {
          host: parsed.host,
          port: parsed.port,
          database: ref.database,
          user: ref.identity.user,
          password,
          ssl: parsed.sslMode === 'disable' ? false : { rejectUnauthorized: parsed.sslMode === 'verify-full' },
          application_name: 'spool-cdc-apply'
        },
        { acknowledge: { auto: false, timeoutSeconds: 10 }, flowControl: { enabled: true } }
      );
      const queue = [];
      let streamError = null;
      let notify;
      let notified = new Promise(resolve => { notify = resolve; });
      const wake = () => { const n = notify; notified = new Promise(resolve => { notify = resolve; }); n(); };
      // Waterline tracking across every stream position, including primary
      // keepalive heartbeats (which carry the server WAL position but no
      // change; they arrive as 'heartbeat' events, never as 'data'). A
      // quiesced source sends no further transactions after the backlog, so
      // without heartbeats the drain would wait forever for a commit that
      // never comes. Stopping here is safe only with an empty local queue
      // AND no open transaction: emission order guarantees every message at
      // or below the heartbeat position was already dequeued, and an empty
      // queue plus a closed assembler means every dequeued transaction is
      // applied, checkpointed, and acked. Never stop over unapplied work.
      let maxSeenLsn = null;
      const trackPosition = raw => {
        const text = typeof raw === 'string' ? raw : String(raw ?? '');
        if (!LSN.test(text)) return;
        if (maxSeenLsn == null || comparePostgresLsn(text, maxSeenLsn) > 0) maxSeenLsn = text.toUpperCase();
      };
      const idleStopReached = () => untilLsn != null
        && maxSeenLsn != null
        && queue.length === 0
        && comparePostgresLsn(maxSeenLsn, untilLsn) >= 0
        && !assembler.hasOpenTransaction();
      service.on('error', error => {
        streamError = error;
        wake();
      });
      service.on('heartbeat', lsn => {
        // Server WAL position with no change attached: the only termination
        // signal on a quiesced source. Tracked for the waterline, and wakes
        // the pump so an idle drain can observe it and stop.
        trackPosition(lsn);
        wake();
      });
      service.on('data', (lsn, message) => {
        // Synchronous enqueue only: async EventEmitter listeners do NOT
        // serialize, so all ordering is enforced by the single pump below.
        // The queue is bounded: an overwhelmed consumer fails closed with an
        // actionable code instead of growing memory without limit.
        if (queue.length >= maxQueueMessages) {
          streamError = Object.assign(new Error(`CDC inbound queue exceeded ${maxQueueMessages} buffered messages; consumer cannot keep up`), { code: 'CDC_QUEUE_OVERFLOW' });
          wake();
          return;
        }
        const lsnText = typeof lsn === 'string' ? lsn : String(lsn ?? '');
        queue.push({ lsn: lsnText, message });
        wake();
      });
      const stopService = async () => {
        try { await service.stop(); } catch { /* stopping wins over stop errors */ }
        try { await service.destroy(); } catch { /* shutdown must not mask results */ }
      };
      // Batched server-ack state lives in serverAck (run scope, shared with
      // the checkpoint writer): acknowledgedLsn in the checkpoint always
      // names the last SERVER-acked LSN (never the merely applied one).
      const flushPendingAck = async () => {
        if (serverAck.pending == null) return;
        await service.acknowledge(serverAck.pending);
        serverAck.last = serverAck.pending;
        serverAck.atCount = metrics.appliedTransactions;
        serverAck.atMs = Date.now();
        serverAck.pending = null;
      };
      const shouldStop = tx => {
        if (maxTransactions != null && metrics.appliedTransactions >= maxTransactions) return true;
        if (untilLsn != null && tx && comparePostgresLsn(tx.commitLsn, untilLsn) >= 0) return true;
        return false;
      };
      try {
        // The library settles subscribe() only when replication ENDS (its
        // own README drives it fire-and-forget): awaiting it would hang the
        // pump forever. Gate pump start on the 'start' event instead, feed
        // subscribe failures into streamError, and bound the wait so a
        // never-starting stream fails loudly instead of hanging.
        let started = false;
        let subscribeSettled = false;
        service.once('start', () => { started = true; wake(); });
        const subscribeDone = service.subscribe(
          new PgoutputPlugin({ protoVersion: 1, publicationNames: [...publicationNames] }), slotName, fromLsn ?? undefined
        ).then(
          () => { subscribeSettled = true; wake(); },
          error => { if (!streamError) streamError = error; subscribeSettled = true; wake(); }
        );
        const startDeadline = Date.now() + SUBSCRIBE_START_TIMEOUT_MS;
        for (;;) {
          if (started || streamError || subscribeSettled) break;
          if (Date.now() >= startDeadline) {
            try { await service.stop(); } catch { /* stopping wins */ }
            try { await subscribeDone; } catch { /* reported below */ }
            fail('CDC_SUBSCRIBE_TIMEOUT', 'Replication stream did not start in time; refusing to wait indefinitely', { slotName });
          }
          await notified;
        }
        if (!started) {
          try { await subscribeDone; } catch { /* reported below */ }
          if (streamError) {
            try { classifyCdcStreamError(streamError, { slotName }); } catch (classified) {
              await stopService();
              throw classified;
            }
            await stopService();
            throw streamError;
          }
          await stopService();
          fail('CDC_SUBSCRIBE_FAILED', 'Replication subscription ended before replication started', { slotName });
        }
        for (;;) {
          if (queue.length === 0) {
            if (streamError) break;
            // A heartbeat may have carried the waterline while the pump was
            // waiting: observe it here instead of sleeping past the drain.
            // Queue empty + no open transaction means everything dequeued is
            // applied, so flushing the batched ack here is exact.
            if (idleStopReached()) {
              await flushPendingAck();
              await stopService();
              return { finished: true, resumeLsn: metrics.lastCommitLsn ?? fromLsn };
            }
            await notified;
            continue;
          }
          const { lsn, message } = queue.shift();
          trackPosition(lsn);
          let change;
          try {
            change = normalizeMessage(lsn, message);
          } catch (error) {
            await stopService();
            throw error;
          }
          if (!change) {
            if (idleStopReached()) {
              await stopService();
              return { finished: true, resumeLsn: metrics.lastCommitLsn ?? fromLsn };
            }
            continue;
          }
          metrics.receivedMessages += 1;
          let tx = null;
          try {
            tx = await assembler.feed(change);
          } catch (error) {
            await stopService();
            throw error;
          }
          if (!tx) {
            if (idleStopReached()) {
              await stopService();
              return { finished: true, resumeLsn: metrics.lastCommitLsn ?? fromLsn };
            }
            continue;
          }
          metrics.receivedTransactions += 1;
          // applyOneTransaction performs fenced target commit, durable CAS
          // checkpoint persist, metrics/history; only then is the source acked.
          // Server acknowledgements are batched (every ACK_BATCH_TXNS or
          // ACK_BATCH_MS, plus every stop): ack position is cumulative, so
          // acking LSN-100 after applying through LSN-200 releases the same
          // WAL with far fewer roundtrips. Crash-before-ack replays from the
          // server position and reconciles through the ledger — never loss,
          // never duplication. The checkpoint's acknowledgedLsn always names
          // the last SERVER-acked LSN, honestly behind appliedLsn mid-batch.
          const { ackLsn } = await applyOneTransaction(tx);
          serverAck.pending = ackLsn;
          const ackDue = metrics.appliedTransactions - serverAck.atCount >= ACK_BATCH_TXNS
            || Date.now() - serverAck.atMs >= ACK_BATCH_MS;
          if (ackDue) await flushPendingAck();
          if (shouldStop(tx) || idleStopReached()) {
            await flushPendingAck();
            await stopService();
            return { finished: true, resumeLsn: ackLsn };
          }
        }
        if (streamError) {
          try { classifyCdcStreamError(streamError, { slotName }); } catch (classified) {
            await stopService();
            throw classified;
          }
          await stopService();
          throw streamError;
        }
        await stopService();
        return { finished: true, resumeLsn: metrics.lastCommitLsn };
      } catch (error) {
        await stopService();
        throw error;
      }
    });
  }
}

// Apply one assembled source transaction to the target under the given fence
// and return a DurableApplyResult. The complete source transaction commits
// as exactly ONE target transaction (commitCdcTransaction) bound to a single
// transaction identity — never split into separate upsert/delete commits.
// Mapping streams incrementally in two passes (identity-hash pass, apply
// pass) so memory stays bounded by chunk size, not transaction size. The
// caller persists the checkpoint and only then acknowledges the source — ack
// never precedes durability.
export async function applyCdcTransaction({
  target, migration, plan, targetContractId, fencingToken, transaction, primaryKey, sourceTable,
  stagingDir = null, maxMutations = null
} = {}) {
  if (!target || typeof target.commitCdcTransaction !== 'function') {
    fail('INVALID_CDC_APPLY_TARGET', 'CDC apply requires an opened target with atomic CDC transaction commits');
  }
  if (!migration || typeof migration.migrationId !== 'string') fail('INVALID_CDC_APPLY_TARGET', 'migration.migrationId is required');
  if (!plan || typeof plan.planId !== 'string') fail('INVALID_CDC_APPLY_TARGET', 'plan.planId is required');
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) fail('FENCE_REQUIRED', 'CDC apply requires a fresh fence token');
  if (!transaction || transaction.commitLsn == null) fail('INVALID_CDC_TRANSACTION', 'A complete assembled CDC transaction is required');
  // Streamed changes carry SOURCE table identity (the publication side);
  // the target table is where they land after mapping. An event for any
  // other table means the publication was altered mid-migration: fail closed
  // rather than skipping it past the watermark (silent data loss).
  const source = requireSourceTable(sourceTable);
  const mapOptions = {
    mapping: plan.mapping,
    mappingRevision: plan.mappingRevision,
    targetSchema: plan.targetSchema,
    sourceTable: source,
    primaryKey,
    commitLsn: transaction.commitLsn
  };
  const streamMutations = async function *() {
    let index = 0;
    const engine = new MigrationEngine();
    const accumulator = engine.createAccumulator(mapOptions.mapping, mapOptions.mappingRevision, mapOptions.targetSchema);
    const compiledKeyMapping = compileMapping(mapOptions.mapping);
    for await (const change of iterateTransactionEvents(transaction, { stagingDir })) {
      yield mapOneCdcEvent({ change, accumulator, compiledKeyMapping, index, ...mapOptions });
      index += 1;
    }
  };
  // Pass 1 (streaming, O(1) memory): ordered payload hash + exact count.
  const hashed = await hashOrderedMutations(streamMutations());
  const transactionIdentity = createCdcTransactionIdentity({
    migrationId: migration.migrationId,
    planId: plan.planId,
    sourceSnapshotId: migration.sourceSnapshotId,
    mappingRevision: plan.mappingRevision,
    targetIdentity: plan.targetRef,
    xid: transaction.xid,
    beginLsn: transaction.beginLsn,
    commitLsn: transaction.commitLsn,
    mutationCount: hashed.mutationCount,
    payloadHash: hashed.payloadHash
  });
  // Pass 2 (streaming): the target consumes the mutation iterable
  // incrementally inside ONE transaction — no materialized array.
  const commit = await target.commitCdcTransaction({
    migrationId: migration.migrationId,
    planId: plan.planId,
    sourceSnapshotId: migration.sourceSnapshotId,
    mappingRevision: plan.mappingRevision,
    targetContractId,
    fencingToken,
    transactionIdentity,
    xid: transaction.xid,
    beginLsn: transaction.beginLsn,
    commitLsn: transaction.commitLsn,
    mutationCount: hashed.mutationCount,
    payloadHash: hashed.payloadHash,
    primaryKey,
    mutations: streamMutations(),
    maxMutations
  });
  return Object.freeze({
    migrationId: migration.migrationId,
    sourceTransactionId: transaction.xid,
    commitLsn: transaction.commitLsn.toUpperCase(),
    targetCommitIdentity: Object.freeze({ transactionIdentity: commit.transactionIdentity }),
    fenceToken: fencingToken,
    inserted: commit.inserted ?? 0,
    updated: commit.updated ?? 0,
    deleted: commit.deleted ?? 0,
    skippedMissingCount: commit.skippedMissing ?? 0,
    recovered: commit.alreadyCommitted === true,
    spilled: transaction.spilled === true,
    appliedAt: new Date().toISOString()
  });
}

// Map ONE CDC event to ONE ordered target mutation. Stateless across calls
// except the row-local accumulator (no cross-row transform state), so the
// apply path can stream events incrementally in two passes without ever
// buffering the transaction. Returned mutations are frozen and carry an
// explicit op: upsert mutations carry the full mapped row, delete mutations
// carry the mapped key plus precondition evidence.
function mapOneCdcEvent({ change, accumulator, compiledKeyMapping, primaryKey, sourceTable, commitLsn, index }) {
  if (change.table !== sourceTable.table || change.schema !== sourceTable.schema) {
    fail('CDC_UNEXPECTED_TABLE', 'CDC event is for a table outside the bound publication set; the publication may have been altered mid-migration', {
      schema: change.schema ?? null, table: change.table ?? null, commitLsn
    });
  }
  if (change.tag === 'truncate') {
    // A source TRUNCATE empties the table, but the target truncate path
    // requires a bound truncate approval which CDC cannot mint. Refusing
    // closed with an operator-actionable code beats silent divergence.
    fail('CDC_TRUNCATE_REQUIRES_OPERATOR', 'Source TRUNCATE requires an explicit operator decision; CDC apply refuses to truncate without a bound approval', {
      schema: change.schema, table: change.table, commitLsn
    });
  }
  if (change.tag === 'delete') {
    const mapped = mapDeleteKey({ change, accumulator, compiledKeyMapping, primaryKey, commitLsn });
    return Object.freeze({ op: 'delete', key: mapped.key, expectedRowHash: mapped.expectedRowHash, precondition: mapped.precondition });
  }
  const sourceRow = change.row ?? change.new;
  if (!sourceRow || typeof sourceRow !== 'object') {
    fail('CDC_ROW_UNMAPPABLE', `CDC ${change.tag} event carries no mappable row`, { commitLsn });
  }
  const transformed = accumulator.process(sourceRow, index);
  if (!transformed.ok) {
    fail('CDC_TRANSFORM_REJECTED', 'Source row rejected by the migration mapping; refusing to drop it silently', {
      code: transformed.code ?? null, commitLsn
    });
  }
  return Object.freeze({ op: 'upsert', row: Object.freeze({ ...transformed.row }) });
}

// Map a delete to its target key. With a full old row (REPLICA IDENTITY
// FULL) the row travels the strict accumulator path with a full-row
// precondition. With a key-only image (default identity) only the target
// key is computed — through the SAME compiled mapping expressions, so an
// upsert and a delete for one key always agree — with no full-row validation
// (there is no row to validate) and an explicit key-only precondition so
// evidence distinguishes proven deletes from key deletes.
function mapDeleteKey({ change, accumulator, compiledKeyMapping, primaryKey, commitLsn }) {
  const hasOldRow = change.old != null && typeof change.old === 'object';
  if (hasOldRow) {
    const transformed = accumulator.process(change.old, 0);
    if (!transformed.ok) {
      fail('CDC_TRANSFORM_REJECTED', 'Delete old row rejected by the migration mapping; refusing to drop it silently', {
        code: transformed.code ?? null, commitLsn
      });
    }
    const key = pickKey(transformed.row, primaryKey);
    return Object.freeze({
      key: Object.freeze({ ...key }),
      expectedRowHash: postgresContentRowHash({
        primaryKey,
        columns: Object.keys(transformed.row).sort(),
        key,
        row: transformed.row
      }),
      precondition: 'full-row'
    });
  }
  const keySource = change.key;
  if (!keySource || typeof keySource !== 'object') {
    fail('CDC_ROW_UNMAPPABLE', 'CDC delete event carries no key image', { commitLsn });
  }
  let mappedKeyRow;
  try {
    mappedKeyRow = compiledKeyMapping.mapRow(keySource);
  } catch (error) {
    fail('CDC_TRANSFORM_REJECTED', 'Delete key image rejected by the migration mapping; the target key cannot be computed', {
      code: error?.code ?? null, commitLsn
    });
  }
  return Object.freeze({
    key: Object.freeze({ ...pickKey(mappedKeyRow, primaryKey) }),
    expectedRowHash: null,
    precondition: 'key-only'
  });
}
