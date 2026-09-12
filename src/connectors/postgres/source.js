import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { createPostgresSourceState } from '../../protocol/state-descriptors.js';
import { validateConnectorDescriptor } from '../contract.js';
import { parsePostgresEndpoint, withPostgresClient } from './connection.js';

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10_000;

export const POSTGRES_SOURCE_DESCRIPTOR = validateConnectorDescriptor({
  name: 'postgres',
  role: 'source',
  version: 1,
  assurance: { level: 'C1' },
  capabilities: {
    streaming: true,
    snapshotBinding: true,
    readOnlySnapshot: true
  }
});

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_POSTGRES_SOURCE_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_POSTGRES_SOURCE_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sourceRefConfig(sourceRef) {
  if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) fail('INVALID_SOURCE_REF', 'PostgreSQL sourceRef is required');
  if (sourceRef.connector !== 'postgres') fail('UNSUPPORTED_SOURCE_CONNECTOR', 'PostgreSQL source runtime requires connector postgres');
  if (sourceRef.path != null) fail('INVALID_SOURCE_REF', 'PostgreSQL sourceRef must not contain a filesystem path');
  const endpoint = parsePostgresEndpoint(sourceRef.endpoint);
  const database = requireText(sourceRef.database, 'sourceRef.database');
  const schema = requireText(sourceRef.schema, 'sourceRef.schema');
  const table = requireText(sourceRef.table, 'sourceRef.table');
  const user = requireText(sourceRef.identity?.user, 'sourceRef.identity.user');
  const secretRef = validateSecretRef(sourceRef.secretRef);
  return Object.freeze({
    ...structuredClone(sourceRef),
    endpoint: endpoint.endpoint,
    database,
    schema,
    table,
    identity: Object.freeze({ ...sourceRef.identity, user }),
    secretRef
  });
}

function requireBatchSize(value) {
  const size = value ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
    fail('INVALID_POSTGRES_SOURCE_CONFIG', `batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return size;
}

function parseSnapshotText(value) {
  const text = requireText(value, 'pg_current_snapshot()');
  const parts = text.split(':');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
    fail('INVALID_POSTGRES_SNAPSHOT', 'PostgreSQL returned an invalid MVCC snapshot');
  }
  const xip = parts[2] ? parts[2].split(',') : [];
  if (xip.some(item => !/^\d+$/.test(item))) fail('INVALID_POSTGRES_SNAPSHOT', 'PostgreSQL snapshot contains an invalid in-progress transaction id');
  return Object.freeze({ xmin: parts[0], xmax: parts[1], xip: Object.freeze(xip) });
}

async function inspectRelation(client, ref) {
  const relation = await client.query({
    text: `
      SELECT c.oid::int AS relid, c.relkind, n.nspname AS schema_name, c.relname AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
    `,
    values: [ref.schema, ref.table]
  });
  if (relation.rowCount !== 1) fail('POSTGRES_SOURCE_NOT_FOUND', `PostgreSQL source ${ref.schema}.${ref.table} was not found`);
  const rel = relation.rows[0];
  if (!['r', 'p'].includes(rel.relkind)) fail('UNSUPPORTED_POSTGRES_SOURCE_RELATION', 'PostgreSQL source must be a table or partitioned table');

  const columnsResult = await client.query({
    text: `
      SELECT a.attname AS name,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null,
             a.attnum::int AS position
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `,
    values: [rel.relid]
  });
  if (!columnsResult.rowCount) fail('POSTGRES_SOURCE_EMPTY_SCHEMA', 'PostgreSQL source relation has no readable columns');

  const primaryKeyResult = await client.query({
    text: `
      SELECT a.attname AS name, k.ordinality::int AS ordinality
      FROM pg_catalog.pg_index i
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = $1::oid AND i.indisprimary
      ORDER BY k.ordinality
    `,
    values: [rel.relid]
  });
  if (!primaryKeyResult.rowCount) {
    fail('POSTGRES_SOURCE_ORDER_REQUIRED', 'PostgreSQL C1 source streaming requires a primary key for deterministic keyset traversal');
  }

  const columns = columnsResult.rows.map(row => Object.freeze({
    name: row.name,
    type: row.type,
    nullable: !row.not_null,
    position: Number(row.position)
  }));
  const primaryKey = primaryKeyResult.rows.map(row => row.name);
  const contract = Object.freeze({
    schemaVersion: 1,
    relation: Object.freeze({ schema: rel.schema_name, table: rel.table_name, relid: Number(rel.relid), relkind: rel.relkind }),
    columns: Object.freeze(columns),
    primaryKey: Object.freeze(primaryKey)
  });
  const contractId = sha256Canonical('spool-postgres-source-contract-v1', contract);
  return Object.freeze({ contract, contractId });
}

async function captureSourceState(client, ref, inspection) {
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
    fail('POSTGRES_SOURCE_IDENTITY_UNAVAILABLE', 'Unable to capture PostgreSQL source identity; the source principal must be allowed to inspect server identity and export a snapshot', { cause: error?.message });
  }
  const row = identity.rows[0];
  const snapshot = parseSnapshotText(row.snapshot_text);
  return createPostgresSourceState({
    systemIdentifier: row.system_identifier,
    databaseOid: Number(row.database_oid),
    databaseName: row.database_name,
    serverVersionNum: Number(row.server_version_num),
    relation: {
      schema: inspection.contract.relation.schema,
      table: inspection.contract.relation.table,
      relid: inspection.contract.relation.relid
    },
    snapshot: {
      exportedSnapshotId: row.exported_snapshot_id,
      xmin: snapshot.xmin,
      xmax: snapshot.xmax,
      xip: snapshot.xip
    },
    walLsn: row.wal_lsn,
    contractId: inspection.contractId
  });
}

function keysetPredicate(primaryKey, lastKey, startParameter) {
  if (lastKey === null) return { sql: '', values: [] };
  if (!Array.isArray(lastKey) || lastKey.length !== primaryKey.length) fail('INVALID_POSTGRES_SOURCE_CURSOR', 'PostgreSQL source cursor does not match primary-key arity');
  const left = primaryKey.map(quoteIdentifier).join(', ');
  const right = primaryKey.map((_, index) => `$${startParameter + index}`).join(', ');
  return { sql: `WHERE (${left}) > (${right})`, values: lastKey };
}

class PostgresSourceSnapshot {
  constructor({ client, ref, state, contract, contractId, batchSize }) {
    this.client = client;
    this.sourceRef = ref;
    this.sourceState = state;
    this.contract = contract;
    this.contractId = contractId;
    this.batchSize = batchSize;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('POSTGRES_SOURCE_SNAPSHOT_CLOSED', 'PostgreSQL source snapshot is closed');
  }

  async *batches() {
    this.#assertOpen();
    const columns = this.contract.columns.map(column => column.name);
    const primaryKey = this.contract.primaryKey;
    const selectColumns = columns.map(quoteIdentifier).join(', ');
    const order = primaryKey.map(quoteIdentifier).join(', ');
    const qualified = `${quoteIdentifier(this.sourceRef.schema)}.${quoteIdentifier(this.sourceRef.table)}`;
    let lastKey = null;
    let offset = 0;

    for (;;) {
      this.#assertOpen();
      const predicate = keysetPredicate(primaryKey, lastKey, 1);
      const values = [...predicate.values, this.batchSize];
      const limitParameter = values.length;
      const result = await this.client.query({
        text: `SELECT ${selectColumns} FROM ${qualified} ${predicate.sql} ORDER BY ${order} LIMIT $${limitParameter}`,
        values
      });
      if (!result.rowCount) return;
      const rows = Object.freeze(result.rows.map(row => Object.freeze({ ...row })));
      const endExclusive = offset + rows.length;
      const finalRow = rows[rows.length - 1];
      lastKey = primaryKey.map(column => finalRow[column]);
      yield Object.freeze({
        sourceStateId: this.sourceState.sourceStateId,
        sourceRange: Object.freeze({ start: offset, endExclusive }),
        cursor: Object.freeze([...lastKey]),
        rows
      });
      offset = endExclusive;
    }
  }

  close() {
    this.closed = true;
  }
}

export async function withPostgresSourceSnapshot({ sourceRef, credentialBroker, batchSize = DEFAULT_BATCH_SIZE } = {}, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_SOURCE_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_POSTGRES_SOURCE_CONFIG', 'snapshot callback is required');
  const ref = sourceRefConfig(sourceRef);
  const size = requireBatchSize(batchSize);

  return withPostgresClient({ targetRef: ref, credentialBroker }, async client => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let snapshot;
    try {
      const inspection = await inspectRelation(client, ref);
      const sourceState = await captureSourceState(client, ref, inspection);
      snapshot = new PostgresSourceSnapshot({
        client,
        ref,
        state: sourceState,
        contract: inspection.contract,
        contractId: inspection.contractId,
        batchSize: size
      });
      const result = await callback(snapshot);
      snapshot.close();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (snapshot) snapshot.close();
      try { await client.query('ROLLBACK'); } catch { /* primary source failure wins */ }
      throw error;
    }
  });
}

export function createPostgresSourceRuntime({ credentialBroker, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_SOURCE_CONFIG', 'credentialBroker.withSecret() is required');
  const size = requireBatchSize(batchSize);
  return Object.freeze({
    descriptor: POSTGRES_SOURCE_DESCRIPTOR,
    withSnapshot: (sourceRef, callback, options = {}) => withPostgresSourceSnapshot({
      sourceRef,
      credentialBroker,
      batchSize: options.batchSize ?? size
    }, callback)
  });
}
