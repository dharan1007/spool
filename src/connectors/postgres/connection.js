import { Client } from 'pg';
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

export async function withPostgresClient({ targetRef, credentialBroker }, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_POSTGRES_CONFIG', 'PostgreSQL client callback is required');
  return credentialBroker.withSecret(targetRef?.secretRef, async password => {
    const client = new Client(postgresConnectionConfig(targetRef, password));
    await client.connect();
    try {
      return await callback(client);
    } finally {
      try { await client.end(); } catch { /* primary operation error wins */ }
    }
  });
}
