import mysql from 'mysql2/promise';
import { fail } from '../../core/errors.js';

const TLS_MODES = new Set(['disable', 'require', 'verify-full']);

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_MYSQL_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_MYSQL_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

export function parseMysqlEndpoint(endpoint) {
  const text = requireText(endpoint, 'endpoint');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('INVALID_MYSQL_ENDPOINT', 'MySQL endpoint must be a mysql:// URL');
  }
  if (url.protocol !== 'mysql:') fail('INVALID_MYSQL_ENDPOINT', 'MySQL endpoint protocol must be mysql://');
  if (url.username || url.password) fail('RAW_SECRET_FORBIDDEN', 'MySQL endpoint must not contain credentials; use secretRef and identity.user');
  if (url.hash) fail('INVALID_MYSQL_ENDPOINT', 'MySQL endpoint must not contain a fragment');
  if (url.pathname && url.pathname !== '/') fail('INVALID_MYSQL_ENDPOINT', 'MySQL database must be supplied in targetRef.database, not the endpoint path');

  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'sslmode') || keys.filter(key => key === 'sslmode').length > 1) {
    fail('INVALID_MYSQL_ENDPOINT', 'MySQL endpoint only supports the sslmode query parameter');
  }
  const sslMode = url.searchParams.get('sslmode') ?? 'verify-full';
  if (!TLS_MODES.has(sslMode)) fail('INVALID_MYSQL_TLS_MODE', 'sslmode must be disable, require, or verify-full');
  const port = url.port ? Number(url.port) : 3306;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('INVALID_MYSQL_ENDPOINT', 'MySQL endpoint port is invalid');
  const host = requireText(url.hostname, 'endpoint hostname');

  const normalized = new URL(`mysql://${host}${port === 3306 ? '' : `:${port}`}/`);
  normalized.searchParams.set('sslmode', sslMode);
  return Object.freeze({ endpoint: normalized.toString(), host, port, sslMode });
}

export function mysqlConnectionConfig(ref, password) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('INVALID_MYSQL_CONFIG', 'MySQL ref is required');
  const endpoint = parseMysqlEndpoint(ref.endpoint);
  const database = requireText(ref.database, 'database');
  const user = requireText(ref.identity?.user, 'identity.user');
  if (typeof password !== 'string' || !password) fail('SECRET_NOT_FOUND', 'MySQL password is required');

  const config = {
    host: endpoint.host,
    port: endpoint.port,
    user,
    password,
    database,
    connectTimeout: 10_000,
    supportBigNumbers: false
  };
  if (endpoint.sslMode === 'require') config.ssl = { rejectUnauthorized: false };
  else if (endpoint.sslMode === 'verify-full') config.ssl = {};
  return config;
}

export async function withMysqlConnection({ targetRef, credentialBroker }, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MYSQL_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_MYSQL_CONFIG', 'MySQL connection callback is required');
  return credentialBroker.withSecret(targetRef?.secretRef, async password => {
    const connection = await mysql.createConnection(mysqlConnectionConfig(targetRef, password));
    try {
      return await callback(connection);
    } finally {
      try { await connection.end(); } catch { /* primary operation error wins */ }
    }
  });
}
