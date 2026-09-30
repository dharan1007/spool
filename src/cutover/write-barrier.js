import { Client } from 'pg';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';
import { postgresConnectionConfig } from '../connectors/postgres/connection.js';

const BARRIER_DOMAIN = 'spool-source-write-barrier-v2';
const LSN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
const PG_LOCK_TIMEOUT = '55P03';
// Forgotten-barrier safety: a session that is never released would hold its
// SHARE lock indefinitely and wedge source writes. The idle timeout rolls a
// leaked barrier back server-side; verifyHeld() immediately before the
// cutover decision still fails closed if the lock is gone for any reason.
const BARRIER_IDLE_TIMEOUT = '10min';
const OPERATOR_SIGNATURE_DOMAIN = 'spool-source-write-barrier-operator-signature-v1';
const HASH = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE = /^hmac-sha256:[a-f0-9]{64}$/;

export const WRITE_BARRIER_KINDS = Object.freeze([
  'POSTGRES_TABLE_SHARE_LOCK',
  'EXTERNAL_OPERATOR_BARRIER'
]);

// Industrial cutover invariant:
//
// A source write barrier is evidence only when an independent session proves
// the database itself refuses the lock mode required by ordinary DML.
//
// PostgreSQL DML takes ROW EXCLUSIVE. A transaction holding SHARE on the
// migrated table conflicts with ROW EXCLUSIVE but not ACCESS SHARE, so:
//   - active writers drain before the barrier can be acquired;
//   - new INSERT/UPDATE/DELETE/TRUNCATE/DDL that need stronger locks block;
//   - verification SELECTs can continue;
//   - process/session loss releases the barrier automatically, so callers
//     must keep the handle alive and verifyHeld() before making the decision.
//
// ALTER DATABASE ... SET default_transaction_read_only is deliberately NOT a
// barrier: it changes defaults for new sessions and does not fence existing
// application sessions. Treating it as a fence can lose writes at cutover.
export function describeBarrierKind(kind) {
  if (kind === 'DATABASE_READ_ONLY') {
    fail(
      'WRITE_BARRIER_UNSAFE',
      'DATABASE_READ_ONLY is not an industrial write barrier: existing PostgreSQL sessions can continue writing. Use POSTGRES_TABLE_SHARE_LOCK or an explicit external operator barrier.',
      { kind }
    );
  }
  if (kind === 'APPLICATION_GATE' || kind === 'PROXY_ROUTER') {
    fail('WRITE_BARRIER_UNSUPPORTED', `Source write barrier kind ${kind} is not implemented; use POSTGRES_TABLE_SHARE_LOCK or EXTERNAL_OPERATOR_BARRIER`, { kind });
  }
  if (!WRITE_BARRIER_KINDS.includes(kind)) fail('WRITE_BARRIER_UNKNOWN', `Unknown source write barrier kind ${kind}`, { kind });
  return kind;
}

function signingBytes(signingKey) {
  if (!(typeof signingKey === 'string' || Buffer.isBuffer(signingKey) || signingKey instanceof Uint8Array)) {
    fail('INVALID_BARRIER_SIGNING_KEY', 'Source barrier signing key must be bytes or string');
  }
  const bytes = Buffer.from(signingKey);
  if (bytes.length < 16) fail('INVALID_BARRIER_SIGNING_KEY', 'Source barrier signing key must be at least 16 bytes');
  return bytes;
}

function operatorSignature(record, signingKey) {
  const digest = createHmac('sha256', signingBytes(signingKey))
    .update(`SPOOL\0${OPERATOR_SIGNATURE_DOMAIN}\0`, 'utf8')
    .update(canonicalJson(record), 'utf8')
    .digest('hex');
  return `hmac-sha256:${digest}`;
}

function safeEqualSignature(expected, actual) {
  if (!SIGNATURE.test(expected ?? '') || !SIGNATURE.test(actual ?? '')) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

function operatorSignedRecord(barrier) {
  return {
    schemaVersion: 1,
    barrierId: barrier.barrierId,
    kind: barrier.kind,
    migrationId: barrier.migrationId,
    acquiredAt: barrier.acquiredAt,
    finalLsn: barrier.finalLsn,
    zeroDowntime: barrier.zeroDowntime,
    attestation: barrier.attestation
  };
}

function requireMigrationId(value) {
  if (typeof value !== 'string' || !value) fail('INVALID_BARRIER_REQUEST', 'migrationId is required');
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\u0000')) {
    fail('INVALID_BARRIER_REQUEST', `${label} must be a non-empty PostgreSQL identifier`);
  }
  if (Buffer.byteLength(value, 'utf8') > 63) {
    fail('INVALID_BARRIER_REQUEST', `${label} exceeds PostgreSQL's 63-byte identifier limit`);
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function requireTimeout(value, label, { min = 50, max = 300_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_BARRIER_REQUEST', `${label} must be an integer between ${min} and ${max} milliseconds`);
  }
  return value;
}

// Barrier sessions live in a module-level registry (mirroring the pool
// registry in connection.js): a live pg.Client embeds the password in its
// connection parameters, so it must never cross the broker callback scope
// outward — the hardened broker fails such results closed as
// SECRET_LEAK_DETECTED. Only an opaque random handle id crosses outward;
// every session operation resolves it here, inside this trust domain.
const barrierSessions = new Map();

async function openBarrierSession({ sourceRef, credentialBroker }) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') {
    fail('INVALID_BARRIER_REQUEST', 'credentialBroker.withSecret() is required');
  }
  return credentialBroker.withSecret(sourceRef?.secretRef, async password => {
    const client = new Client({
      ...postgresConnectionConfig(sourceRef, password),
      application_name: 'spool-write-barrier'
    });
    await client.connect();
    const handle = randomUUID().replaceAll('-', '');
    barrierSessions.set(handle, { client, inTransaction: false, released: false });
    if (process.env.SPOOL_TRACE_DRAIN === '1') console.error(`[trace-barrier ${Date.now()}] opened session ${handle.slice(0, 8)} map=${barrierSessions.size}`);
    return handle;
  });
}

function barrierSession(handle) {
  const entry = barrierSessions.get(handle);
  if (!entry || entry.released) fail('WRITE_BARRIER_RELEASED', 'Source write barrier session is no longer held');
  return entry;
}

async function closeBarrierSession(handle) {
  if (process.env.SPOOL_TRACE_DRAIN === '1') console.error(`[trace-barrier ${Date.now()}] close ${String(handle).slice(0, 8)} present=${barrierSessions.has(handle)} map=${barrierSessions.size}`);
  const entry = barrierSessions.get(handle);
  if (!entry) return;
  barrierSessions.delete(handle);
  entry.released = true;
  if (entry.inTransaction) {
    try { await entry.client.query('ROLLBACK'); } catch {}
    entry.inTransaction = false;
  }
  try { await entry.client.end(); } catch {}
}

export function barrierIdentity({ migrationId, kind, acquiredAt, finalLsn, attestation = null } = {}) {
  requireMigrationId(migrationId);
  describeBarrierKind(kind);
  if (!Number.isFinite(Date.parse(acquiredAt ?? ''))) fail('INVALID_BARRIER_REQUEST', 'acquiredAt must be an ISO timestamp');
  if (typeof finalLsn !== 'string' || !LSN.test(finalLsn)) fail('INVALID_BARRIER_REQUEST', 'finalLsn must be a valid PostgreSQL LSN');
  return sha256Canonical(BARRIER_DOMAIN, {
    migrationId, kind, acquiredAt, finalLsn: finalLsn.toUpperCase(), attestation
  });
}

// Operator attestation for an externally enforced freeze. The attestation is
// evidence of an operator-controlled gate, not proof that SPOOL itself fenced
// the source. It is therefore never a zero-downtime or autonomous-cutover claim.
export function attestOperatorBarrier({
  migrationId,
  cutoverAttemptId,
  principal,
  statement,
  finalLsn,
  routingDecision
} = {}, { signingKey } = {}) {
  requireMigrationId(migrationId);
  if (typeof cutoverAttemptId !== 'string' || !HASH.test(cutoverAttemptId)) {
    fail('INVALID_BARRIER_ATTESTATION', 'cutoverAttemptId must be the canonical cutover attempt identity');
  }
  if (typeof principal !== 'string' || !principal) fail('INVALID_BARRIER_ATTESTATION', 'attesting principal is required');
  if (typeof statement !== 'string' || !statement.trim() || statement.length > 2000) {
    fail('INVALID_BARRIER_ATTESTATION', 'attestation statement must be a non-empty bounded string');
  }
  if (typeof finalLsn !== 'string' || !LSN.test(finalLsn)) fail('INVALID_BARRIER_ATTESTATION', 'finalLsn must be a valid PostgreSQL LSN');
  if (typeof routingDecision !== 'string' || !routingDecision.trim() || routingDecision.length > 2000) {
    fail('INVALID_BARRIER_ATTESTATION', 'routingDecision must be a non-empty bounded string');
  }
  const attestedAt = new Date().toISOString();
  const attestation = Object.freeze({
    cutoverAttemptId,
    principal,
    statement: statement.trim(),
    finalLsn: finalLsn.toUpperCase(),
    routingDecision: routingDecision.trim(),
    attestedAt
  });
  const barrierId = barrierIdentity({
    migrationId,
    kind: 'EXTERNAL_OPERATOR_BARRIER',
    acquiredAt: attestedAt,
    finalLsn,
    attestation
  });
  const unsigned = {
    barrierId,
    kind: 'EXTERNAL_OPERATOR_BARRIER',
    migrationId,
    acquiredAt: attestedAt,
    finalLsn: finalLsn.toUpperCase(),
    attestation,
    zeroDowntime: false
  };
  const signature = operatorSignature(operatorSignedRecord(unsigned), signingKey);
  return Object.freeze({ ...unsigned, signature });
}

export function assertOperatorBarrier(barrier, {
  signingKey,
  migrationId,
  cutoverAttemptId,
  principal
} = {}) {
  requireMigrationId(migrationId);
  if (!barrier || typeof barrier !== 'object' || Array.isArray(barrier)) {
    fail('CUTOVER_SOURCE_BARRIER_REQUIRED', 'PostgreSQL cutover requires a signed external source-write freeze attestation');
  }
  if (barrier.kind !== 'EXTERNAL_OPERATOR_BARRIER') {
    fail('CUTOVER_SOURCE_BARRIER_REQUIRED', 'PostgreSQL cutover requires EXTERNAL_OPERATOR_BARRIER attestation in addition to the database lock fence', {
      kind: barrier.kind ?? null
    });
  }
  if (barrier.migrationId !== migrationId) {
    fail('CUTOVER_SOURCE_BARRIER_MISMATCH', 'Source-write barrier is bound to a different migration', {
      expectedMigrationId: migrationId,
      barrierMigrationId: barrier.migrationId ?? null
    });
  }
  if (barrier.zeroDowntime !== false) {
    fail('CUTOVER_SOURCE_BARRIER_INVALID', 'External source-write barrier must not claim zero-downtime');
  }
  const attestation = barrier.attestation;
  if (!attestation || typeof attestation !== 'object'
    || typeof attestation.principal !== 'string' || !attestation.principal
    || typeof attestation.statement !== 'string' || !attestation.statement.trim()
    || typeof attestation.routingDecision !== 'string' || !attestation.routingDecision.trim()
    || typeof attestation.cutoverAttemptId !== 'string' || !HASH.test(attestation.cutoverAttemptId)) {
    fail('CUTOVER_SOURCE_BARRIER_INVALID', 'External source-write barrier requires attempt, principal, statement, and routingDecision evidence');
  }
  if (attestation.cutoverAttemptId !== cutoverAttemptId) {
    fail('CUTOVER_SOURCE_BARRIER_ATTEMPT_MISMATCH', 'Source-write barrier is bound to a different cutover attempt', {
      expectedCutoverAttemptId: cutoverAttemptId,
      barrierCutoverAttemptId: attestation.cutoverAttemptId
    });
  }
  if (attestation.principal !== principal) {
    fail('CUTOVER_SOURCE_BARRIER_PRINCIPAL_MISMATCH', 'Source-write barrier attesting principal does not match the cutover request principal', {
      expectedPrincipal: principal,
      barrierPrincipal: attestation.principal
    });
  }
  const expectedId = barrierIdentity({
    migrationId,
    kind: barrier.kind,
    acquiredAt: barrier.acquiredAt,
    finalLsn: barrier.finalLsn,
    attestation
  });
  if (expectedId !== barrier.barrierId) {
    fail('CUTOVER_SOURCE_BARRIER_INVALID', 'External source-write barrier identity does not match its evidence payload');
  }
  const expectedSignature = operatorSignature(operatorSignedRecord(barrier), signingKey);
  if (!safeEqualSignature(expectedSignature, barrier.signature)) {
    fail('CUTOVER_SOURCE_BARRIER_SIGNATURE_INVALID', 'External source-write barrier signature does not verify');
  }
  return true;
}

// Strong PostgreSQL table barrier.
//
// The returned handle owns a dedicated backend and an open transaction holding
// SHARE on exactly sourceRef.schema/sourceRef.table. The caller MUST retain the
// handle through FINAL_DRAIN -> FINAL_VERIFY -> CUTOVER_COMMITTED and must call
// verifyHeld() immediately before the irreversible decision.
//
// This is table-scoped by design. It avoids the false guarantee of database
// default_transaction_read_only and does not require superuser privileges.
export async function acquirePostgresTableShareLockBarrier({
  migrationId,
  sourceRef,
  credentialBroker,
  lockTimeoutMs = 60_000,
  probeTimeoutMs = 500
} = {}) {
  requireMigrationId(migrationId);
  if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) {
    fail('INVALID_BARRIER_REQUEST', 'sourceRef is required');
  }
  if (sourceRef.connector !== 'postgres') {
    fail('INVALID_BARRIER_REQUEST', 'POSTGRES_TABLE_SHARE_LOCK requires a PostgreSQL sourceRef');
  }
  const schema = requireIdentifier(sourceRef.schema, 'sourceRef.schema');
  const table = requireIdentifier(sourceRef.table, 'sourceRef.table');
  requireTimeout(lockTimeoutMs, 'lockTimeoutMs');
  requireTimeout(probeTimeoutMs, 'probeTimeoutMs', { min: 50, max: 10_000 });

  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const session = await openBarrierSession({ sourceRef, credentialBroker });
  const entry = barrierSession(session);
  const locker = entry.client;

  const rollbackAndClose = async () => {
    await closeBarrierSession(session);
  };

  try {
    await locker.query('BEGIN');
    entry.inTransaction = true;
    await locker.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await locker.query(`SET LOCAL idle_in_transaction_session_timeout = '${BARRIER_IDLE_TIMEOUT}'`);
    try {
      await locker.query(`LOCK TABLE ${qualified} IN SHARE MODE`);
    } catch (error) {
      if (String(error?.code) === PG_LOCK_TIMEOUT) {
        await rollbackAndClose();
        fail('WRITE_BARRIER_ACQUIRE_TIMEOUT', 'Timed out waiting for active PostgreSQL writers to drain before acquiring the source write barrier', {
          schema, table, lockTimeoutMs, postgresCode: String(error.code)
        });
      }
      throw error;
    }

    const backend = await locker.query('SELECT pg_backend_pid()::int AS pid');
    const backendPid = Number(backend.rows[0].pid);

    // Independent-session proof: ROW EXCLUSIVE is the table lock mode acquired
    // by ordinary INSERT/UPDATE/DELETE. It must fail while SHARE is held.
    const probeSession = await openBarrierSession({ sourceRef, credentialBroker });
    const probe = barrierSession(probeSession).client;
    let probeError = null;
    try {
      await probe.query('BEGIN');
      await probe.query(`SET LOCAL lock_timeout = '${probeTimeoutMs}ms'`);
      await probe.query(`LOCK TABLE ${qualified} IN ROW EXCLUSIVE MODE`);
    } catch (error) {
      probeError = error;
    } finally {
      await closeBarrierSession(probeSession);
    }

    if (!probeError || String(probeError.code) !== PG_LOCK_TIMEOUT) {
      await rollbackAndClose();
      fail('WRITE_BARRIER_NOT_PROVEN', 'Independent session was not blocked from acquiring PostgreSQL ROW EXCLUSIVE; refusing to claim a source write barrier', {
        schema,
        table,
        expectedPostgresCode: PG_LOCK_TIMEOUT,
        actualPostgresCode: probeError?.code ?? null
      });
    }

    const lsnResult = await locker.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    const finalLsn = String(lsnResult.rows[0].lsn).toUpperCase();
    if (!LSN.test(finalLsn)) {
      await rollbackAndClose();
      fail('WRITE_BARRIER_NOT_PROVEN', 'PostgreSQL returned an invalid final WAL position while the source barrier was held', {
        schema, table, finalLsn
      });
    }

    const acquiredAt = new Date().toISOString();
    const proof = Object.freeze({
      schema,
      table,
      backendPid,
      heldLockMode: 'ShareLock',
      conflictingDmlLockMode: 'RowExclusiveLock',
      rejectedProbeCode: PG_LOCK_TIMEOUT,
      probeTimeoutMs
    });
    const barrierId = barrierIdentity({
      migrationId,
      kind: 'POSTGRES_TABLE_SHARE_LOCK',
      acquiredAt,
      finalLsn,
      attestation: proof
    });

    return Object.freeze({
      barrierId,
      kind: 'POSTGRES_TABLE_SHARE_LOCK',
      migrationId,
      acquiredAt,
      finalLsn,
      proof,
      zeroDowntime: false,
      async verifyHeld() {
        const live = barrierSessions.get(session);
        if (!live || live.released || !live.inTransaction) {
          fail('WRITE_BARRIER_RELEASED', 'Source write barrier is no longer held', { barrierId });
        }
        let result;
        try {
          result = await locker.query(
            `SELECT 1
               FROM pg_catalog.pg_locks l
               JOIN pg_catalog.pg_class c ON c.oid = l.relation
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE l.pid = $1
                AND l.granted = true
                AND l.mode = 'ShareLock'
                AND n.nspname = $2
                AND c.relname = $3
              LIMIT 1`,
            [backendPid, schema, table]
          );
        } catch (error) {
          fail('WRITE_BARRIER_LOST', 'Cannot prove the PostgreSQL source write barrier is still held', {
            barrierId,
            code: error?.code ?? null
          });
        }
        if (result.rows.length !== 1) {
          fail('WRITE_BARRIER_LOST', 'PostgreSQL source write barrier lock disappeared before cutover decision', {
            barrierId, backendPid, schema, table
          });
        }
        return Object.freeze({ barrierId, held: true, backendPid, verifiedAt: new Date().toISOString() });
      },
      async release() {
        if (process.env.SPOOL_TRACE_DRAIN === '1') console.error(`[trace-barrier ${Date.now()}] release enter ${barrierId.slice(0, 12)} session=${session.slice(0, 8)}`);
        const live = barrierSessions.get(session);
        if (!live || live.released) return Object.freeze({ barrierId, released: true, repeated: true });
        await rollbackAndClose();
        return Object.freeze({ barrierId, released: true, releasedAt: new Date().toISOString() });
      }
    });
  } catch (error) {
    await rollbackAndClose();
    throw error;
  }
}

// Strong PostgreSQL TARGET write barrier.
//
// This deliberately wraps the proven table-scoped SHARE-lock primitive rather
// than inventing a second locking protocol. It is acquired only after the
// final CDC drain (so SPOOL itself no longer needs target DML) and is retained
// across FINAL_PRE_CUTOVER verification -> CUTOVER_COMMITTED ->
// POST_CUTOVER verification -> COMPLETED. PostgreSQL ordinary DML acquires
// ROW EXCLUSIVE, which conflicts with SHARE, closing the target-side TOCTOU
// window between proof and irreversible decision.
//
// The wrapped primitive obtains an otherwise-unused WAL position as part of
// its generic proof. Target safety is based on the held table lock and the
// independent ROW EXCLUSIVE rejection probe, not that WAL value.
export async function acquirePostgresTargetTableShareLockBarrier({
  migrationId,
  targetRef,
  credentialBroker,
  lockTimeoutMs = 60_000,
  probeTimeoutMs = 500
} = {}) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) {
    fail('INVALID_BARRIER_REQUEST', 'targetRef is required');
  }
  if (targetRef.connector !== 'postgres') {
    fail('INVALID_BARRIER_REQUEST', 'POSTGRES_TARGET_TABLE_SHARE_LOCK requires a PostgreSQL targetRef');
  }

  const inner = await acquirePostgresTableShareLockBarrier({
    migrationId,
    sourceRef: targetRef,
    credentialBroker,
    lockTimeoutMs,
    probeTimeoutMs
  });

  const proof = Object.freeze({
    ...inner.proof,
    role: 'target',
    purpose: 'freeze-target-dml-between-verification-and-cutover-decision'
  });
  const barrierId = barrierIdentity({
    migrationId,
    kind: 'POSTGRES_TARGET_TABLE_SHARE_LOCK',
    acquiredAt: inner.acquiredAt,
    finalLsn: inner.finalLsn,
    attestation: proof
  });

  return Object.freeze({
    barrierId,
    kind: 'POSTGRES_TARGET_TABLE_SHARE_LOCK',
    migrationId,
    acquiredAt: inner.acquiredAt,
    proof,
    zeroDowntime: false,
    async verifyHeld() {
      const held = await inner.verifyHeld();
      return Object.freeze({
        barrierId,
        held: held.held === true,
        backendPid: held.backendPid,
        verifiedAt: held.verifiedAt
      });
    },
    async release() {
      const result = await inner.release();
      return Object.freeze({
        barrierId,
        released: result.released === true,
        repeated: result.repeated === true,
        releasedAt: result.releasedAt ?? null
      });
    }
  });
}

// Kept only as an explicit fail-closed compatibility trap. Older callers must
// not silently retain the unsafe semantics.
export async function acquireDatabaseReadOnlyBarrier() {
  fail(
    'WRITE_BARRIER_UNSAFE',
    'DATABASE_READ_ONLY barrier has been disabled because it does not fence existing PostgreSQL sessions. Use acquirePostgresTableShareLockBarrier().'
  );
}
