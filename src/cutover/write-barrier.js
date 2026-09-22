import { Client } from 'pg';
import { fail } from '../core/errors.js';
import { sha256Canonical } from '../platform/canonical-json.js';
import { postgresConnectionConfig } from '../connectors/postgres/connection.js';

const BARRIER_DOMAIN = 'spool-source-write-barrier-v2';
const LSN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
const PG_LOCK_TIMEOUT = '55P03';

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

async function openDedicatedClient({ sourceRef, credentialBroker }) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') {
    fail('INVALID_BARRIER_REQUEST', 'credentialBroker.withSecret() is required');
  }
  return credentialBroker.withSecret(sourceRef?.secretRef, async password => {
    const client = new Client({
      ...postgresConnectionConfig(sourceRef, password),
      application_name: 'spool-write-barrier'
    });
    await client.connect();
    return client;
  });
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
export function attestOperatorBarrier({ migrationId, principal, statement, finalLsn, routingDecision = null } = {}) {
  requireMigrationId(migrationId);
  if (typeof principal !== 'string' || !principal) fail('INVALID_BARRIER_ATTESTATION', 'attesting principal is required');
  if (typeof statement !== 'string' || !statement.trim() || statement.length > 2000) {
    fail('INVALID_BARRIER_ATTESTATION', 'attestation statement must be a non-empty bounded string');
  }
  if (typeof finalLsn !== 'string' || !LSN.test(finalLsn)) fail('INVALID_BARRIER_ATTESTATION', 'finalLsn must be a valid PostgreSQL LSN');
  if (routingDecision != null && (typeof routingDecision !== 'string' || !routingDecision.trim())) {
    fail('INVALID_BARRIER_ATTESTATION', 'routingDecision must be a non-empty string when provided');
  }
  const attestedAt = new Date().toISOString();
  const attestation = Object.freeze({
    principal,
    statement: statement.trim(),
    finalLsn: finalLsn.toUpperCase(),
    routingDecision: routingDecision?.trim() ?? null,
    attestedAt
  });
  const barrierId = barrierIdentity({
    migrationId,
    kind: 'EXTERNAL_OPERATOR_BARRIER',
    acquiredAt: attestedAt,
    finalLsn,
    attestation
  });
  return Object.freeze({
    barrierId,
    kind: 'EXTERNAL_OPERATOR_BARRIER',
    migrationId,
    acquiredAt: attestedAt,
    finalLsn: finalLsn.toUpperCase(),
    attestation,
    zeroDowntime: false
  });
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
  const locker = await openDedicatedClient({ sourceRef, credentialBroker });
  let inTransaction = false;
  let released = false;

  const rollbackAndClose = async () => {
    if (inTransaction) {
      try { await locker.query('ROLLBACK'); } catch {}
      inTransaction = false;
    }
    try { await locker.end(); } catch {}
  };

  try {
    await locker.query('BEGIN');
    inTransaction = true;
    await locker.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
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
    const probe = await openDedicatedClient({ sourceRef, credentialBroker });
    let probeError = null;
    try {
      await probe.query('BEGIN');
      await probe.query(`SET LOCAL lock_timeout = '${probeTimeoutMs}ms'`);
      await probe.query(`LOCK TABLE ${qualified} IN ROW EXCLUSIVE MODE`);
    } catch (error) {
      probeError = error;
    } finally {
      try { await probe.query('ROLLBACK'); } catch {}
      try { await probe.end(); } catch {}
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
        if (released || !inTransaction) {
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
        if (released) return Object.freeze({ barrierId, released: true, repeated: true });
        released = true;
        await rollbackAndClose();
        return Object.freeze({ barrierId, released: true, releasedAt: new Date().toISOString() });
      }
    });
  } catch (error) {
    if (!released) await rollbackAndClose();
    throw error;
  }
}

// Kept only as an explicit fail-closed compatibility trap. Older callers must
// not silently retain the unsafe semantics.
export async function acquireDatabaseReadOnlyBarrier() {
  fail(
    'WRITE_BARRIER_UNSAFE',
    'DATABASE_READ_ONLY barrier has been disabled because it does not fence existing PostgreSQL sessions. Use acquirePostgresTableShareLockBarrier().'
  );
}
