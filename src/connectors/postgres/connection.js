import { Client, Pool } from 'pg';
import { createHash } from 'node:crypto';
import { fail } from '../../core/errors.js';

const TLS_MODES = new Set(['disable', 'require', 'verify-full']);
export const MAX_POSTGRES_POOL_IDENTITIES = 64;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_POSTGRES_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_POSTGRES_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

export function parsePostgresEndpoint(endpoint) {
  const text = requireText(endpoint, 'endpoint');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('INVALID_POSTGRES_ENDPOINT', 'PostgreSQL endpoint must be a postgres:// or postgresql:// URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('INVALID_POSTGRES_ENDPOINT', 'PostgreSQL endpoint protocol must be postgres:// or postgresql://');
  if (url.username || url.password) fail('RAW_SECRET_FORBIDDEN', 'PostgreSQL endpoint must not contain credentials; use secretRef and identity.user');
  if (url.hash) fail('INVALID_POSTGRES_ENDPOINT', 'PostgreSQL endpoint must not contain a fragment');
  if (url.pathname && url.pathname !== '/') fail('INVALID_POSTGRES_ENDPOINT', 'PostgreSQL database must be supplied in targetRef.database, not the endpoint path');

  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'sslmode') || keys.filter(key => key === 'sslmode').length > 1) {
    fail('INVALID_POSTGRES_ENDPOINT', 'PostgreSQL endpoint only supports the sslmode query parameter');
  }
  const sslMode = url.searchParams.get('sslmode') ?? 'verify-full';
  if (!TLS_MODES.has(sslMode)) fail('INVALID_POSTGRES_TLS_MODE', 'sslmode must be disable, require, or verify-full');
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('INVALID_POSTGRES_ENDPOINT', 'PostgreSQL endpoint port is invalid');
  const host = requireText(url.hostname, 'endpoint hostname');

  const normalized = new URL(`${url.protocol}//${host}${port === 5432 ? '' : `:${port}`}/`);
  normalized.searchParams.set('sslmode', sslMode);
  return Object.freeze({ endpoint: normalized.toString(), host, port, sslMode });
}

export function postgresConnectionConfig(targetRef, password) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) fail('INVALID_TARGET_REF', 'PostgreSQL targetRef is required');
  const endpoint = parsePostgresEndpoint(targetRef.endpoint);
  const database = requireText(targetRef.database, 'database');
  const user = requireText(targetRef.identity?.user, 'identity.user');
  if (typeof password !== 'string' || !password) fail('SECRET_NOT_FOUND', 'PostgreSQL password is required');

  const ssl = endpoint.sslMode === 'disable'
    ? false
    : { rejectUnauthorized: endpoint.sslMode === 'verify-full' };

  return {
    host: endpoint.host,
    port: endpoint.port,
    database,
    user,
    password,
    ssl,
    application_name: 'spool-local-runner',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 65_000,
    keepAlive: true
  };
}

// Process-wide connection pools keyed by server/database/user/password.
// A fresh TCP+auth handshake costs tens of milliseconds per use — fatal for
// per-transaction CDC apply at volume. Pooling preserves every semantic the
// callback relies on: pool.connect() hands out a DEDICATED backend for the
// callback's duration, so BEGIN/COMMIT, advisory locks, FOR UPDATE rows and
// temp objects behave exactly as with a fresh client. allowExitOnIdle keeps
// short-lived test processes from hanging on idle sockets.
// Registry records are bounded independently from pg's per-pool idle socket
// timeout. Without this bound, rotating credentials or tenant/endpoint churn
// leaves an unbounded number of empty Pool objects in a long-running daemon.
const pools = new Map();

function evictablePoolRecord(record) {
  return record
    && record.pool.totalCount === record.pool.idleCount
    && record.pool.waitingCount === 0;
}

export function selectPostgresPoolEvictionKey(entries) {
  let candidate = null;
  for (const [key, record] of entries ?? []) {
    if (!evictablePoolRecord(record)) continue;
    if (candidate == null
      || record.lastUsedAt < candidate.lastUsedAt
      || (record.lastUsedAt === candidate.lastUsedAt && key < candidate.key)) {
      candidate = { key, lastUsedAt: record.lastUsedAt };
    }
  }
  return candidate?.key ?? null;
}

function tlsPolicyIdentity(ssl) {
  if (ssl === false) return 'disable';
  if (ssl && ssl.rejectUnauthorized === true) return 'verify-full';
  return 'require';
}

// Pool identity is part of the transport-security boundary. Two refs that
// differ only by TLS policy MUST NOT share a pg Pool: otherwise a pool first
// created for sslmode=disable could later satisfy a verify-full request.
// Exported as a pure opaque identity so the invariant can be regression-tested
// without opening a network connection or exposing raw credentials.
export function postgresPoolIdentity(config, password = config?.password) {
  if (!config || typeof config !== 'object') fail('INVALID_POSTGRES_CONFIG', 'PostgreSQL pool config is required');
  if (typeof password !== 'string' || !password) fail('SECRET_NOT_FOUND', 'PostgreSQL password is required');
  const passwordDigest = createHash('sha256').update(password, 'utf8').digest('hex');
  const material = JSON.stringify({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    tlsPolicy: tlsPolicyIdentity(config.ssl),
    passwordDigest
  });
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function poolKey(config) {
  return postgresPoolIdentity(config, config.password);
}

function poolFor(config) {
  const key = poolKey(config);
  const now = Date.now();
  let record = pools.get(key);
  if (record) {
    record.lastUsedAt = now;
    return record.pool;
  }

  if (pools.size >= MAX_POSTGRES_POOL_IDENTITIES) {
    const evictKey = selectPostgresPoolEvictionKey(pools.entries());
    if (evictKey == null) {
      fail('POSTGRES_POOL_REGISTRY_EXHAUSTED', 'PostgreSQL connection-pool identity limit reached and every pool is active', {
        maxPoolIdentities: MAX_POSTGRES_POOL_IDENTITIES,
        activePoolIdentities: pools.size
      });
    }
    const evicted = pools.get(evictKey);
    pools.delete(evictKey);
    // The candidate is provably idle/no-waiters. Do not block connection
    // acquisition on network teardown; Pool.end() closes its idle clients and
    // the rejection is intentionally contained.
    void evicted.pool.end().catch(() => {});
  }

  const pool = new Pool({ ...config, max: 20, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
  pool.on('error', () => { /* idle-client errors surface on checkout, never here */ });
  record = { pool, lastUsedAt: now };
  pools.set(key, record);
  return pool;
}

export function poolStats() {
  return Object.freeze([...pools.entries()].map(([key, record]) => Object.freeze({
    key: `sha256:${key}`,
    totalCount: record.pool.totalCount,
    idleCount: record.pool.idleCount,
    waitingCount: record.pool.waitingCount,
    lastUsedAt: record.lastUsedAt
  })));
}

export async function closePostgresPools() {
  const open = [...pools.values()].map(record => record.pool);
  pools.clear();
  await Promise.all(open.map(pool => pool.end().catch(() => {})));
}

export async function withPostgresClient({ targetRef, credentialBroker }, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_POSTGRES_CONFIG', 'PostgreSQL client callback is required');
  return credentialBroker.withSecret(targetRef?.secretRef, async password => {
    const pool = poolFor(postgresConnectionConfig(targetRef, password));
    const client = await pool.connect();
    try {
      return await callback(client);
    } finally {
      try { client.release(); } catch { /* primary operation error wins */ }
    }
  });
}
