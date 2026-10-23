import sql from 'mssql';
import { fail } from '../../core/errors.js';

const TLS_MODES = new Set(['disable', 'require', 'verify-full']);

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_MSSQL_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_MSSQL_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

export function parseMssqlEndpoint(endpoint) {
  const text = requireText(endpoint, 'endpoint');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('INVALID_MSSQL_ENDPOINT', 'SQL Server endpoint must be a mssql:// URL');
  }
  if (url.protocol !== 'mssql:') fail('INVALID_MSSQL_ENDPOINT', 'SQL Server endpoint protocol must be mssql://');
  if (url.username || url.password) fail('RAW_SECRET_FORBIDDEN', 'SQL Server endpoint must not contain credentials; use secretRef and identity.user');
  if (url.hash) fail('INVALID_MSSQL_ENDPOINT', 'SQL Server endpoint must not contain a fragment');
  if (url.pathname && url.pathname !== '/') fail('INVALID_MSSQL_ENDPOINT', 'SQL Server database must be supplied in targetRef.database, not the endpoint path');

  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'sslmode') || keys.filter(key => key === 'sslmode').length > 1) {
    fail('INVALID_MSSQL_ENDPOINT', 'SQL Server endpoint only supports the sslmode query parameter');
  }
  const sslMode = url.searchParams.get('sslmode') ?? 'verify-full';
  if (!TLS_MODES.has(sslMode)) fail('INVALID_MSSQL_TLS_MODE', 'sslmode must be disable, require, or verify-full');
  const port = url.port ? Number(url.port) : 1433;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('INVALID_MSSQL_ENDPOINT', 'SQL Server endpoint port is invalid');
  const host = requireText(url.hostname, 'endpoint hostname');

  const normalized = new URL(`mssql://${host}${port === 1433 ? '' : `:${port}`}/`);
  normalized.searchParams.set('sslmode', sslMode);
  return Object.freeze({ endpoint: normalized.toString(), host, port, sslMode });
}

export function mssqlConnectionConfig(ref, password) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('INVALID_MSSQL_CONFIG', 'SQL Server ref is required');
  const endpoint = parseMssqlEndpoint(ref.endpoint);
  const database = requireText(ref.database, 'database');
  const user = requireText(ref.identity?.user, 'identity.user');
  if (typeof password !== 'string' || !password) fail('SECRET_NOT_FOUND', 'SQL Server password is required');

  const options = { connectTimeout: 10_000, requestTimeout: 65_000, appName: 'spool-local-runner' };
  if (endpoint.sslMode === 'disable') options.encrypt = false;
  else if (endpoint.sslMode === 'require') { options.encrypt = true; options.trustServerCertificate = true; }
  else { options.encrypt = true; options.trustServerCertificate = false; }
  return {
    server: endpoint.host,
    port: endpoint.port,
    user,
    password,
    database,
    options,
    pool: { max: 1, min: 0, idleTimeoutMillis: 10_000 }
  };
}

export async function withMssqlConnection({ targetRef, credentialBroker }, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MSSQL_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_MSSQL_CONFIG', 'SQL Server connection callback is required');
  return credentialBroker.withSecret(targetRef?.secretRef, async password => {
    const pool = new sql.ConnectionPool(mssqlConnectionConfig(targetRef, password));
    await pool.connect();
    try {
      return await callback(pool);
    } finally {
      try { await pool.close(); } catch { /* primary operation error wins */ }
    }
  });
}
