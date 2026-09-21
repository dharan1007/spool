import { fail } from '../core/errors.js';
import { sha256Canonical } from '../platform/canonical-json.js';
import { withPostgresClient } from '../connectors/postgres/connection.js';

const BARRIER_DOMAIN = 'spool-source-write-barrier-v1';
const LSN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;

export const WRITE_BARRIER_KINDS = Object.freeze([
  'DATABASE_READ_ONLY',
  'EXTERNAL_OPERATOR_BARRIER'
]);

// Source write-barrier protocol for cutover. A barrier proves the source
// stopped accepting writes before the final LSN is captured, so draining
// through that LSN provably reaches the end of source history.
//
// Kinds:
// - DATABASE_READ_ONLY: SPOOL sets the PG database default_transaction_read_only
//   on, proves a fresh write is rejected, captures the final LSN, and restores
//   the setting on release. Zero-downtime only if writers drain gracefully.
// - EXTERNAL_OPERATOR_BARRIER: a human-controlled gate (application deploy
//   freeze, proxy route change, manual quiesce). Requires an explicit signed
//   attestation bound to the migration; NEVER a zero-downtime claim.
// - APPLICATION_GATE / PROXY_ROUTER: explicit UNSUPPORTED — no silent stub.
export function describeBarrierKind(kind) {
  if (kind === 'APPLICATION_GATE' || kind === 'PROXY_ROUTER') {
    fail('WRITE_BARRIER_UNSUPPORTED', `Source write barrier kind ${kind} is not implemented; use DATABASE_READ_ONLY or EXTERNAL_OPERATOR_BARRIER`, { kind });
  }
  if (!WRITE_BARRIER_KINDS.includes(kind)) fail('WRITE_BARRIER_UNKNOWN', `Unknown source write barrier kind ${kind}`, { kind });
  return kind;
}

function requireMigrationId(value) {
  if (typeof value !== 'string' || !value) fail('INVALID_BARRIER_REQUEST', 'migrationId is required');
  return value;
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

// Operator attestation for EXTERNAL_OPERATOR_BARRIER. Every field is
// mandatory: an unattributed "source is quiet" claim is not evidence.
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
    principal, statement: statement.trim(), finalLsn: finalLsn.toUpperCase(),
    routingDecision: routingDecision?.trim() ?? null, attestedAt
  });
  const barrierId = barrierIdentity({ migrationId, kind: 'EXTERNAL_OPERATOR_BARRIER', acquiredAt: attestedAt, finalLsn, attestation });
  return Object.freeze({
    barrierId, kind: 'EXTERNAL_OPERATOR_BARRIER', migrationId,
    acquiredAt: attestedAt, finalLsn: finalLsn.toUpperCase(),
    attestation, zeroDowntime: false
  });
}

// DATABASE_READ_ONLY barrier against a live PostgreSQL database. Sets the
// database-level default_transaction_read_only flag, proves a fresh session
// write is rejected (error 25006), captures the final flush LSN, and returns
// a handle whose release() restores the writable default. Proof of barrier
// activity (the rejected write) is part of the returned evidence.
export async function acquireDatabaseReadOnlyBarrier({ migrationId, targetRef, credentialBroker } = {}) {
  requireMigrationId(migrationId);
  if (!targetRef || typeof targetRef !== 'object') fail('INVALID_BARRIER_REQUEST', 'targetRef is required');
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_BARRIER_REQUEST', 'credentialBroker.withSecret() is required');
  const database = targetRef.database;
  if (typeof database !== 'string' || !database) fail('INVALID_BARRIER_REQUEST', 'targetRef.database is required');
  if (/["\\\u0000]/.test(database)) fail('INVALID_BARRIER_REQUEST', 'database name is not barrier-safe');

  const prior = await withPostgresClient({ targetRef, credentialBroker }, async client => {
    const res = await client.query('SELECT setting FROM pg_catalog.pg_db_role_setting($1::regclass, 0)', [`"${database}"`]).catch(() => null);
    return res?.rows ?? null;
  }).catch(() => null);

  await withPostgresClient({ targetRef, credentialBroker }, async client => {
    await client.query(`ALTER DATABASE "${database.replaceAll('"', '""')}" SET default_transaction_read_only = on`);
  });
  const acquiredAt = new Date().toISOString();

  // Prove the barrier is active: a fresh session write must be rejected.
  let proofError = null;
  try {
    await withPostgresClient({ targetRef, credentialBroker }, async client => {
      await client.query('CREATE TEMPORARY TABLE spool_barrier_proof (id integer)');
      await client.query('INSERT INTO spool_barrier_proof(id) VALUES (1)');
    });
  } catch (error) {
    proofError = error;
  }
  if (!proofError || String(proofError.code) !== '25006') {
    try {
      await withPostgresClient({ targetRef, credentialBroker }, async client => {
        await client.query(`ALTER DATABASE "${database.replaceAll('"', '""')}" SET default_transaction_read_only = off`);
      });
    } catch {}
    fail('WRITE_BARRIER_NOT_PROVEN', 'DATABASE_READ_ONLY barrier did not reject a fresh write; refusing to claim a fenced source', {
      code: proofError?.code ?? null
    });
  }

  const finalLsn = await withPostgresClient({ targetRef, credentialBroker }, async client => {
    const res = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    return String(res.rows[0].lsn).toUpperCase();
  });
  const proof = Object.freeze({ rejectedWriteCode: String(proofError.code), rejectedAt: new Date().toISOString() });
  const barrierId = barrierIdentity({ migrationId, kind: 'DATABASE_READ_ONLY', acquiredAt, finalLsn, attestation: proof });
  let released = false;
  return Object.freeze({
    barrierId, kind: 'DATABASE_READ_ONLY', migrationId, acquiredAt, finalLsn,
    proof, priorSetting: prior, zeroDowntime: false,
    async release() {
      if (released) return Object.freeze({ barrierId, released: true, repeated: true });
      await withPostgresClient({ targetRef, credentialBroker }, async client => {
        await client.query(`ALTER DATABASE "${database.replaceAll('"', '""')}" SET default_transaction_read_only = off`);
      });
      released = true;
      return Object.freeze({ barrierId, released: true, releasedAt: new Date().toISOString() });
    }
  });
}
