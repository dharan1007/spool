import { fail } from '../../core/errors.js';
import { parsePostgresEndpoint, withPostgresClient } from './connection.js';
import { POSTGRES_METADATA_SCHEMA } from './preflight.js';
import { acquirePostgresLease, ensurePostgresMetadata, releasePostgresLease } from './target.js';
import { validateSecretRef } from '../../platform/secrets.js';

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_WORKER_CLAIM', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_WORKER_CLAIM', `${label} cannot contain NUL`);
  return value.trim();
}

function requireWorkerId(value) {
  const id = requireText(value, 'workerId');
  if (!WORKER_ID.test(id)) fail('INVALID_WORKER_CLAIM', 'workerId must start alphanumerically and contain only letters, digits, dot, underscore, colon or dash (max 128)');
  return id;
}

function requireResource(value) {
  return requireText(value, 'resource');
}

function requireTtlMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_WORKER_CLAIM', 'ttlMs must be a positive safe integer');
  return value;
}

function requireBroker(credentialBroker) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_WORKER_CLAIM', 'credentialBroker.withSecret() is required');
  return credentialBroker;
}

function requireDatabaseRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('INVALID_WORKER_CLAIM', 'PostgreSQL database ref is required');
  const endpoint = parsePostgresEndpoint(ref.endpoint);
  const database = requireText(ref.database, 'ref.database');
  const user = requireText(ref.identity?.user, 'ref.identity.user');
  const secretRef = validateSecretRef(ref.secretRef);
  return Object.freeze({ endpoint: endpoint.endpoint, database, identity: Object.freeze({ user }), secretRef });
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function describeRow(row) {
  if (!row) return null;
  return Object.freeze({
    resource: row.resource,
    owner: row.owner,
    fencingToken: Number(row.fencing_token),
    active: row.active === true,
    expiresAt: new Date(row.expires_at).toISOString()
  });
}

export async function describeWorkerLease({ ref, credentialBroker, resource } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  requireBroker(credentialBroker);
  const name = requireResource(resource);
  await ensurePostgresMetadata({ targetRef: databaseRef, credentialBroker });
  const result = await withPostgresClient({ targetRef: databaseRef, credentialBroker }, async client => {
    const found = await client.query(`
      SELECT resource, owner, fencing_token::text AS fencing_token,
             expires_at > clock_timestamp() AS active, expires_at
      FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.execution_leases
      WHERE resource = $1
    `, [name]);
    return describeRow(found.rows[0] ?? null);
  });
  return result;
}

export async function claimWorkerLease({ ref, credentialBroker, resource, workerId, ttlMs } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  requireBroker(credentialBroker);
  const name = requireResource(resource);
  const owner = requireWorkerId(workerId);
  const ttl = requireTtlMs(ttlMs);
  try {
    const lease = await acquirePostgresLease({ targetRef: databaseRef, credentialBroker, resource: name, owner, ttlMs: ttl });
    return Object.freeze({ status: 'ACQUIRED', resource: lease.resource, owner: lease.owner, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt });
  } catch (error) {
    if (error?.code !== 'LEASE_HELD') throw error;
    const holder = await describeWorkerLease({ ref: databaseRef, credentialBroker, resource: name });
    return Object.freeze({ status: 'HELD', resource: name, holder });
  }
}

export async function heartbeatWorkerLease({ ref, credentialBroker, resource, workerId, ttlMs } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  requireBroker(credentialBroker);
  const name = requireResource(resource);
  const owner = requireWorkerId(workerId);
  const ttl = requireTtlMs(ttlMs);
  const current = await describeWorkerLease({ ref: databaseRef, credentialBroker, resource: name });
  if (current && current.active === true && current.owner !== owner) {
    fail('WORKER_CLAIM_LOST', 'Worker claim was taken over by another worker', { resource: name, owner, holder: current.owner });
  }
  try {
    const lease = await acquirePostgresLease({ targetRef: databaseRef, credentialBroker, resource: name, owner, ttlMs: ttl });
    return Object.freeze({ status: 'ACQUIRED', resource: lease.resource, owner: lease.owner, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt });
  } catch (error) {
    if (error?.code !== 'LEASE_HELD') throw error;
    fail('WORKER_CLAIM_LOST', 'Worker claim is held by another worker', { resource: name, owner });
  }
}

export async function releaseWorkerLease({ ref, credentialBroker, resource, workerId, fencingToken } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  requireBroker(credentialBroker);
  const name = requireResource(resource);
  const owner = requireWorkerId(workerId);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) fail('INVALID_WORKER_CLAIM', 'fencingToken must be a positive safe integer');
  await releasePostgresLease({ targetRef: databaseRef, credentialBroker, resource: name, owner, fencingToken });
  return Object.freeze({ status: 'RELEASED', resource: name, owner });
}

export async function listWorkerLeases({ ref, credentialBroker, resourcePrefix } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  requireBroker(credentialBroker);
  const prefix = requireText(resourcePrefix, 'resourcePrefix');
  const escaped = prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  await ensurePostgresMetadata({ targetRef: databaseRef, credentialBroker });
  const result = await withPostgresClient({ targetRef: databaseRef, credentialBroker }, async client => {
    const found = await client.query(`
      SELECT resource, owner, fencing_token::text AS fencing_token,
             expires_at > clock_timestamp() AS active, expires_at
      FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.execution_leases
      WHERE resource LIKE $1 ESCAPE '\\'
      ORDER BY resource
    `, [`${escaped}%`]);
    return Object.freeze(found.rows.map(describeRow));
  });
  return result;
}
