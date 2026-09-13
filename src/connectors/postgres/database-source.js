import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { parsePostgresEndpoint, withPostgresClient } from './connection.js';

const CATALOG_DOMAIN = 'spool-postgres-catalog-v1';
const SPOOL_METADATA_SCHEMA = 'spool_internal';
const SNAPSHOT_TOKEN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-\d+$/;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const TXID = /^\d+$/;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_POSTGRES_DATABASE_SOURCE', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_POSTGRES_DATABASE_SOURCE', `${label} cannot contain NUL`);
  return value.trim();
}

function requireDatabaseRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('INVALID_POSTGRES_DATABASE_SOURCE', 'PostgreSQL database ref is required');
  const endpoint = parsePostgresEndpoint(ref.endpoint);
  const database = requireText(ref.database, 'ref.database');
  const user = requireText(ref.identity?.user, 'ref.identity.user');
  const secretRef = validateSecretRef(ref.secretRef);
  return Object.freeze({
    endpoint: endpoint.endpoint,
    database,
    identity: Object.freeze({ ...ref.identity, user }),
    secretRef
  });
}

function requireSchemas(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_POSTGRES_DATABASE_SOURCE', 'schemas must be a non-empty array when supplied');
  const seen = new Set();
  return Object.freeze(value.map(name => {
    if (typeof name !== 'string' || !SCHEMA_NAME.test(name)) fail('INVALID_POSTGRES_DATABASE_SOURCE', `Invalid schema name ${String(name)}`);
    if (seen.has(name)) fail('INVALID_POSTGRES_DATABASE_SOURCE', `Duplicate schema ${name}`);
    seen.add(name);
    return name;
  }));
}

function requireSnapshotToken(value) {
  if (typeof value !== 'string' || !SNAPSHOT_TOKEN.test(value)) {
    fail('INVALID_POSTGRES_SNAPSHOT_TOKEN', 'PostgreSQL snapshot token must be an exported snapshot identifier');
  }
  return value;
}

function parseSnapshotText(value) {
  const text = requireText(value, 'pg_current_snapshot()');
  const parts = text.split(':');
  if (parts.length !== 3 || !TXID.test(parts[0]) || !TXID.test(parts[1])) {
    fail('INVALID_POSTGRES_SNAPSHOT', 'PostgreSQL returned an invalid MVCC snapshot');
  }
  const xip = parts[2] ? parts[2].split(',') : [];
  if (xip.some(item => !TXID.test(item))) fail('INVALID_POSTGRES_SNAPSHOT', 'PostgreSQL snapshot contains an invalid in-progress transaction id');
  return Object.freeze({ xmin: parts[0], xmax: parts[1], xip: Object.freeze(xip) });
}

export function postgresCatalogIdentity(tables) {
  if (!Array.isArray(tables)) fail('INVALID_POSTGRES_DATABASE_SOURCE', 'catalog tables must be an array');
  const normalized = tables.map((table, index) => {
    if (!table || typeof table !== 'object' || Array.isArray(table)) fail('INVALID_POSTGRES_DATABASE_SOURCE', `catalog table ${index} must be an object`);
    const schema = requireText(table.schema, `catalog table ${index} schema`);
    const name = requireText(table.table, `catalog table ${index} table`);
    if (!Array.isArray(table.columns) || table.columns.length === 0) fail('INVALID_POSTGRES_DATABASE_SOURCE', `catalog table ${index} columns are required`);
    const columns = table.columns.map((column, columnIndex) => {
      if (!column || typeof column !== 'object' || Array.isArray(column)) fail('INVALID_POSTGRES_DATABASE_SOURCE', `catalog table ${index} column ${columnIndex} must be an object`);
      return Object.freeze({
        name: requireText(column.name, `catalog table ${index} column name`),
        type: requireText(column.type, `catalog table ${index} column type`),
        nullable: column.nullable !== false,
        position: Number.isSafeInteger(column.position) && column.position >= 1 ? column.position : columnIndex + 1
      });
    });
    const primaryKey = Array.isArray(table.primaryKey) ? [...table.primaryKey] : [];
    for (const key of primaryKey) {
      if (!columns.some(column => column.name === key)) fail('INVALID_POSTGRES_DATABASE_SOURCE', `catalog table ${index} primary key ${key} is not a column`);
    }
    return Object.freeze({ schema, table: name, relkind: table.relkind === 'p' ? 'p' : 'r', columns: Object.freeze(columns), primaryKey: Object.freeze(primaryKey) });
  });
  normalized.sort((left, right) => left.schema.localeCompare(right.schema) || left.table.localeCompare(right.table));
  return sha256Canonical(CATALOG_DOMAIN, { tables: normalized.map(table => ({ ...table })) });
}

export async function discoverPostgresCatalog({ ref, credentialBroker, schemas = null } = {}) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_DATABASE_SOURCE', 'credentialBroker.withSecret() is required');
  const databaseRef = requireDatabaseRef(ref);
  const scope = requireSchemas(schemas);
  return withPostgresClient({ targetRef: databaseRef, credentialBroker }, async client => {
    const schemaFilter = scope ? 'AND n.nspname = ANY($1::text[])' : '';
    const schemaParams = scope ? [scope] : [];
    const relations = await client.query(`
      SELECT n.nspname AS schema_name, c.relname AS table_name, c.relkind AS relkind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT LIKE 'pg\\_%'
        AND n.nspname <> 'information_schema'
        AND n.nspname <> '${SPOOL_METADATA_SCHEMA}'
        ${schemaFilter}
      ORDER BY n.nspname, c.relname
    `, schemaParams);
    const tables = [];
    for (const relation of relations.rows) {
      const columnsResult = await client.query(`
        SELECT a.attname AS name,
               pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
               a.attnotnull AS not_null,
               a.attnum::int AS position
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [relation.schema_name, relation.table_name]);
      if (!columnsResult.rowCount) continue;
      const keysResult = await client.query(`
        SELECT a.attname AS name
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
        ORDER BY key.ordinality
      `, [relation.schema_name, relation.table_name]);
      tables.push(Object.freeze({
        schema: relation.schema_name,
        table: relation.table_name,
        relkind: relation.relkind,
        columns: Object.freeze(columnsResult.rows.map(row => Object.freeze({
          name: row.name,
          type: row.type,
          nullable: !row.not_null,
          position: Number(row.position)
        }))),
        primaryKey: Object.freeze(keysResult.rows.map(row => row.name)),
        streamable: keysResult.rowCount > 0
      }));
    }
    const catalogId = postgresCatalogIdentity(tables);
    return Object.freeze({ tables: Object.freeze(tables), tableCount: tables.length, catalogId });
  });
}

async function captureDatabaseIdentity(client) {
  let identity;
  try {
    identity = await client.query(`
      SELECT (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier,
             (SELECT oid::int FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
             current_database() AS database_name,
             current_setting('server_version_num')::int AS server_version_num,
             pg_catalog.pg_export_snapshot() AS exported_snapshot_id,
             pg_catalog.pg_current_snapshot()::text AS snapshot_text,
             pg_catalog.pg_current_wal_lsn()::text AS wal_lsn
    `);
  } catch (error) {
    fail('POSTGRES_DATABASE_IDENTITY_UNAVAILABLE', 'Unable to capture PostgreSQL database identity; the principal must be allowed to inspect server identity and export a snapshot', { cause: error?.message });
  }
  const row = identity.rows[0];
  const snapshot = parseSnapshotText(row.snapshot_text);
  return Object.freeze({
    systemIdentifier: String(row.system_identifier),
    databaseOid: Number(row.database_oid),
    databaseName: row.database_name,
    serverVersionNum: Number(row.server_version_num),
    exportedSnapshotId: row.exported_snapshot_id,
    xmin: snapshot.xmin,
    xmax: snapshot.xmax,
    xip: snapshot.xip,
    walLsn: String(row.wal_lsn).toUpperCase()
  });
}

export async function withExportedPostgresSnapshot({ ref, credentialBroker } = {}, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_DATABASE_SOURCE', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_POSTGRES_DATABASE_SOURCE', 'snapshot callback is required');
  const databaseRef = requireDatabaseRef(ref);
  return withPostgresClient({ targetRef: databaseRef, credentialBroker }, async client => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const snapshot = await captureDatabaseIdentity(client);
      const result = await callback(snapshot);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* primary source failure wins */ }
      throw error;
    }
  });
}

export async function joinPostgresSnapshot(client, snapshotToken) {
  if (!client || typeof client.query !== 'function') fail('INVALID_POSTGRES_DATABASE_SOURCE', 'A PostgreSQL client is required to join a snapshot');
  const token = requireSnapshotToken(snapshotToken);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`SET TRANSACTION SNAPSHOT '${token}'`);
    const state = await client.query('SELECT pg_catalog.pg_current_snapshot()::text AS snapshot_text, pg_catalog.pg_current_wal_lsn()::text AS wal_lsn');
    const snapshot = parseSnapshotText(state.rows[0].snapshot_text);
    return Object.freeze({ snapshotToken: token, xmin: snapshot.xmin, xmax: snapshot.xmax, xip: snapshot.xip, walLsn: String(state.rows[0].wal_lsn).toUpperCase() });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* primary source failure wins */ }
    throw error;
  }
}
