import { Client, Pool } from 'pg';
import { createHash } from 'node:crypto';
import { fail } from '../../core/errors.js';

const TLS_MODES = new Set(['disable', 'require', 'verify-full']);

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
const pools = new Map();

function poolKey(config, password) {
  const digest = createHash('sha256').update(password, 'utf8').digest('hex').slice(0, 16);
  return `${config.host}:${config.port}/${config.database}/${config.user}/${digest}`;
}

function poolFor(config) {
  let pool = pools.get(poolKey(config, config.password));
  if (!pool) {
    pool = new Pool({ ...config, max: 20, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
    pool.on('error', () => { /* idle-client errors surface on checkout, never here */ });
    pools.set(poolKey(config, config.password), pool);
  }
  return pool;
}

export function poolStats() {
  return Object.freeze([...pools.entries()].map(([key, pool]) => Object.freeze({
    key: key.replace(/\/[a-f0-9]{16}$/, '/<redacted>'),
    totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount
  })));
}

export async function closePostgresPools() {
  const open = [...pools.values()];
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
