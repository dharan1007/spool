import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { fail } from '../../core/errors.js';
import { postgresConnectionConfig } from './connection.js';
import { comparePostgresLsn } from './cdc.js';

const RETRYABLE_DEADLOCK = '40P01';
const RETRYABLE_SERIALIZATION = '40001';
const RETRYABLE_READ_ONLY = '25006';
const RETRYABLE_CODES = new Set([RETRYABLE_DEADLOCK, RETRYABLE_SERIALIZATION, RETRYABLE_READ_ONLY]);

export function isRetryablePostgresFault(error) {
  return Boolean(error && RETRYABLE_CODES.has(error.code));
}

export function classifyPostgresFault(error) {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  if (RETRYABLE_DEADLOCK === error.code) return 'DEADLOCK_DETECTED';
  if (RETRYABLE_SERIALIZATION === error.code) return 'SERIALIZATION_FAILURE';
  if (RETRYABLE_READ_ONLY === error.code) return 'READ_ONLY_TRANSACTION';
  if ('40P03' === error.code) return 'INVALID_TX_STATE';
  if ('57P01' === error.code) return 'ADMIN_SHUTDOWN';
  if ('57P02' === error.code) return 'CRASH_SHUTDOWN';
  if ('57P03' === error.code) return 'CANNOT_CONNECT_NOW';
  if ('08003' === error.code || '08006' === error.code || '08P01' === error.code) return 'CONNECTION_LOST';
  return 'UNHANDLED';
}

export function requirePostgresFaultPlan(fault) {
  if (!fault || typeof fault !== 'object' || Array.isArray(fault)) fail('INVALID_POSTGRES_FAULT', 'fault plan is required');
  const kind = fault.kind;
  if (typeof kind !== 'string' || !kind) fail('INVALID_POSTGRES_FAULT', 'fault.kind is required');
  return Object.freeze({
    kind,
    atRound: fault.atRound ?? null,
    cancelQuery: fault.cancelQuery ?? false,
    terminateBackend: fault.terminateBackend ?? false
  });
}

export function createSoakPlan({ rounds, batchSize, uniqueStart, uniqueEnd, writers = 1 }) {
  if (!Number.isSafeInteger(rounds) || rounds < 1) fail('INVALID_SOAK_PLAN', 'rounds must be a positive safe integer');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) fail('INVALID_SOAK_PLAN', 'batchSize must be a positive safe integer');
  if (!Number.isSafeInteger(uniqueStart) || uniqueStart < 0) fail('INVALID_SOAK_PLAN', 'uniqueStart must be a non-negative integer');
  if (!Number.isSafeInteger(uniqueEnd) || uniqueEnd <= uniqueStart) fail('INVALID_SOAK_PLAN', 'uniqueEnd must exceed uniqueStart');
  if (!Number.isSafeInteger(writers) || writers < 1) fail('INVALID_SOAK_PLAN', 'writers must be a positive safe integer');
  const capacity = uniqueEnd - uniqueStart;
  const totalRowsPerRound = batchSize * writers;
  if (totalRowsPerRound > capacity) fail('INVALID_SOAK_PLAN', 'one round exceeds the unique id space; enlarge uniqueStart..uniqueEnd');
  return Object.freeze({ rounds, batchSize, uniqueStart, uniqueEnd, writers, totalRowsPerRound });
}

export async function runSoakRound({ ref, credentialBroker, plan, round, writerIndex, table = 'soak_target' }) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_SOAK_RUN', 'credentialBroker.withSecret() is required');
  if (!plan || typeof plan !== 'object') fail('INVALID_SOAK_RUN', 'soak plan is required');
  if (typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) fail('INVALID_SOAK_RUN', 'soak table must be a safe SQL identifier');
  const start = performance.now();
  return credentialBroker.withSecret(ref.secretRef, async password => {
    const targetRef = { endpoint: ref.endpoint, database: ref.database, identity: ref.identity };
    const client = new Client(postgresConnectionConfig(targetRef, password));
    await client.connect();
    try {
      const capacity = plan.uniqueEnd - plan.uniqueStart;
      const offset = ((round - 1) * plan.totalRowsPerRound + writerIndex * plan.batchSize) % capacity;
      const low = plan.uniqueStart + offset;
      const high = Math.min(low + plan.batchSize, plan.uniqueEnd);
      if (high - low !== plan.batchSize) fail('SOAK_ID_SPACE', `soak writer ${writerIndex} exceeded the unique id window`);
      const values = [];
      const placeholders = [];
      for (let i = low; i < high; i += 1) {
        values.push(i, `soak-${i}`);
        placeholders.push(`($${values.length - 1}, $${values.length})`);
      }
      await client.query(`INSERT INTO public."${table}"(a,b) VALUES ${placeholders.join(', ')}`, values);
      return Object.freeze({
        writerIndex,
        round,
        rows: plan.batchSize,
        fromKey: low,
        toKey: high - 1,
        ms: Number((performance.now() - start).toFixed(2))
      });
    } finally {
      try { await client.end(); } catch { /* primary result wins */ }
    }
  });
}

export function createCdcSoakMeter({ windowMs, rowsPerTick }) {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) fail('INVALID_CDC_SOAK_METER', 'windowMs must be a positive safe integer');
  if (!Number.isSafeInteger(rowsPerTick) || rowsPerTick < 1) fail('INVALID_CDC_SOAK_METER', 'rowsPerTick must be a positive safe integer');
  let started = performance.now();
  let rows = 0;
  return Object.freeze({
    note(change) {
      if (change && change.tag === 'insert') rows += 1;
    },
    snapshot() {
      const elapsed = performance.now() - started;
      return Object.freeze({ rows, elapsedMs: elapsed });
    },
    rowsPerSecond() {
      const snapshot = this.snapshot();
      return snapshot.elapsedMs > 0 ? Math.round(snapshot.rows / (snapshot.elapsedMs / 1000)) : 0;
    }
  });
}

export async function describeSlotLsn({ ref, credentialBroker, slotName }) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_SLOT_PROBE', 'credentialBroker.withSecret() is required');
  return credentialBroker.withSecret(ref.secretRef, async password => {
    const targetRef = { endpoint: ref.endpoint, database: ref.database, identity: ref.identity };
    const client = new Client(postgresConnectionConfig(targetRef, password));
    await client.connect();
    try {
      const result = await client.query(`
        SELECT slot_name AS "slotName",
               active AS "active",
               confirmed_flush_lsn::text AS "confirmedFlushLsn",
               restart_lsn::text AS "restartLsn"
        FROM pg_catalog.pg_replication_slots
        WHERE slot_name = $1
      `, [slotName]);
      const row = result.rows[0] ?? null;
      if (!row) return Object.freeze({ present: false });
      return Object.freeze({ present: true, active: row.active === true, confirmedFlushLsn: row.confirmedFlushLsn, restartLsn: row.restartLsn });
    } finally {
      try { await client.end(); } catch { /* probe result wins */ }
    }
  });
}

export async function waitForLsnToPass({ ref, credentialBroker, thresholdLsn, timeoutMs = 60_000 }) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_LSN_WAIT', 'credentialBroker.withSecret() is required');
  const started = performance.now();
  return credentialBroker.withSecret(ref.secretRef, async password => {
    const targetRef = { endpoint: ref.endpoint, database: ref.database, identity: ref.identity };
    const client = new Client(postgresConnectionConfig(targetRef, password));
    await client.connect();
    try {
      let last = null;
      while (performance.now() - started < timeoutMs) {
        const result = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
        last = result.rows[0].lsn;
        if (comparePostgresLsn(last, thresholdLsn) >= 0) return Object.freeze({ reached: true, lsn: last, waitedMs: Math.round(performance.now() - started) });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return Object.freeze({ reached: false, lsn: last, waitedMs: Math.round(performance.now() - started) });
    } finally {
      try { await client.end(); } catch { /* wait result wins */ }
    }
  });
}

export function recoverDroppedSlot({ present }) {
  if (!present) fail('REPLICATION_SLOT_LOST', 'PostgreSQL replication slot was dropped or the primary restarted and it was not recovered');
}

export function createRecoveryMeter({ now = () => performance.now() } = {}) {
  if (typeof now !== 'function') fail('INVALID_RECOVERY_METER', 'now must be a function');
  let lastFlush = null;
  let failures = 0;
  return Object.freeze({
    markFlushed() { lastFlush = now(); },
    markFailure() { failures += 1; },
    clear() { lastFlush = null; failures = 0; },
    rpo() {
      if (lastFlush == null) return null;
      return Math.max(0, now() - lastFlush);
    },
    failures() { return failures; }
  });
}

export function recordRpoRto({ name, rpoMs = null, rtoMs = null }) {
  if (typeof name !== 'string' || !name) fail('INVALID_RPO_RTO', 'name is required');
  if (rpoMs != null && (!Number.isFinite(rpoMs) || rpoMs < 0)) fail('INVALID_RPO_RTO', 'rpoMs must be a non-negative finite number');
  if (rtoMs != null && (!Number.isFinite(rtoMs) || rtoMs < 0)) fail('INVALID_RPO_RTO', 'rtoMs must be a non-negative finite number');
  return Object.freeze({ name, rpoMs, rtoMs });
}

export function partitionFaultBy({ client, kind = 'terminate' } = {}) {
  if (!client || typeof client.query !== 'function') fail('INVALID_FAULT_INJECTION', 'client is required');
  if (kind !== 'terminate' && kind !== 'cancel') fail('INVALID_FAULT_INJECTION', 'kind must be terminate or cancel');
  return Object.freeze({
    kind,
    describe() {
      return `partition: ${kind === 'terminate' ? 'backend terminated by server' : 'query cancelled by server'}`;
    }
  });
}

export async function terminateBackendByPid({ ref, credentialBroker, pid, cancel = false } = {}) {
  if (!Number.isInteger(pid) || pid < 1) fail('INVALID_FAULT_INJECTION', 'pid must be a positive integer');
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_FAULT_INJECTION', 'credentialBroker.withSecret() is required');
  return credentialBroker.withSecret(ref.secretRef, async password => {
    const targetRef = { endpoint: ref.endpoint, database: ref.database, identity: ref.identity };
    const admin = new Client(postgresConnectionConfig(targetRef, password));
    await admin.connect();
    try {
      const command = cancel ? 'SELECT pg_cancel_backend($1)' : 'SELECT pg_terminate_backend($1)';
      const result = await admin.query(command, [pid]);
      return Object.freeze({ pid, cancelled: cancel, terminated: !cancel, result: result.rows[0][cancel ? 'pg_cancel_backend' : 'pg_terminate_backend'] });
    } finally {
      try { await admin.end(); } catch { /* fault result wins */ }
    }
  });
}

export async function terminateBackendOf({ ref, credentialBroker, client, cancel = false } = {}) {
  if (!client || typeof client.query !== 'function') fail('INVALID_FAULT_INJECTION', 'client is required');
  const me = await client.query('SELECT pg_backend_pid() AS pid');
  return terminateBackendByPid({ ref, credentialBroker, pid: me.rows[0].pid, cancel });
}