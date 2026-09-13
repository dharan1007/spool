import sql from 'mssql';
import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { connectorIdentity } from '../../platform/contracts.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { createMssqlSourceState } from '../../protocol/state-descriptors.js';
import { validateConnectorDescriptor } from '../contract.js';
import { materializeSnapshotBatches } from '../materialized-snapshot.js';
import { parseMssqlEndpoint, withMssqlConnection } from './connection.js';
import { mssqlQuery } from './preflight.js';

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10_000;

export const MSSQL_SOURCE_DESCRIPTOR = validateConnectorDescriptor({
  name: 'mssql',
  role: 'source',
  version: 1,
  assurance: { level: 'C1' },
  capabilities: {
    streaming: true,
    snapshotBinding: true,
    durableMaterialization: true,
    readOnlySnapshot: true
  }
});

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_MSSQL_SOURCE_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_MSSQL_SOURCE_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

function quoteIdentifier(value) {
  const text = String(value);
  if (!text || text.includes('[') || text.includes(']')) fail('INVALID_MSSQL_SOURCE_CONFIG', 'SQL Server source identifiers cannot be empty or contain brackets');
  return `[${text}]`;
}

function sourceRefConfig(sourceRef) {
  if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) fail('INVALID_SOURCE_REF', 'SQL Server sourceRef is required');
  if (sourceRef.connector !== 'mssql') fail('UNSUPPORTED_SOURCE_CONNECTOR', 'SQL Server source runtime requires connector mssql');
  if (sourceRef.path != null) fail('INVALID_SOURCE_REF', 'SQL Server sourceRef must not contain a filesystem path');
  const endpoint = parseMssqlEndpoint(sourceRef.endpoint);
  const database = requireText(sourceRef.database, 'sourceRef.database');
  const table = requireText(sourceRef.table, 'sourceRef.table');
  const user = requireText(sourceRef.identity?.user, 'sourceRef.identity.user');
  const secretRef = validateSecretRef(sourceRef.secretRef);
  return Object.freeze({
    ...structuredClone(sourceRef),
    endpoint: endpoint.endpoint,
    database,
    table,
    identity: Object.freeze({ ...sourceRef.identity, user }),
    secretRef
  });
}

function requireBatchSize(value) {
  const size = value ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
    fail('INVALID_MSSQL_SOURCE_CONFIG', `batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return size;
}

async function inspectRelation(queryable, ref) {
  const tables = await mssqlQuery(queryable,
    'SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_CATALOG = @p1 AND TABLE_SCHEMA = @p2 AND TABLE_NAME = @p3 AND TABLE_TYPE = \'BASE TABLE\'',
    [ref.database, 'dbo', ref.table]
  );
  if (tables.recordset.length !== 1) fail('MSSQL_SOURCE_NOT_FOUND', `SQL Server source ${ref.database}.dbo.${ref.table} was not found`);
  const columns = await mssqlQuery(queryable,
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS isNullable, ORDINAL_POSITION AS position
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_CATALOG = @p1 AND TABLE_SCHEMA = @p2 AND TABLE_NAME = @p3 ORDER BY ORDINAL_POSITION`,
    [ref.database, 'dbo', ref.table]
  );
  if (!columns.recordset.length) fail('MSSQL_SOURCE_EMPTY_SCHEMA', 'SQL Server source relation has no readable columns');
  const keys = await mssqlQuery(queryable,
    `SELECT kcu.COLUMN_NAME AS name FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       ON kcu.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG AND kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
     WHERE tc.TABLE_CATALOG = @p1 AND tc.TABLE_SCHEMA = @p2 AND tc.TABLE_NAME = @p3 AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
     ORDER BY kcu.ORDINAL_POSITION`,
    [ref.database, 'dbo', ref.table]
  );
  if (!keys.recordset.length) {
    fail('MSSQL_SOURCE_ORDER_REQUIRED', 'SQL Server C1 source streaming requires a primary key for deterministic keyset traversal');
  }
  const contract = Object.freeze({
    schemaVersion: 1,
    relation: Object.freeze({ database: ref.database, table: ref.table }),
    columns: Object.freeze(columns.recordset.map(row => Object.freeze({
      name: row.name,
      type: String(row.type).toLowerCase(),
      nullable: row.isNullable === 'YES',
      position: Number(row.position)
    }))),
    primaryKey: Object.freeze(keys.recordset.map(row => row.name))
  });
  const contractId = sha256Canonical('spool-mssql-source-contract-v1', contract);
  return Object.freeze({ contract, contractId });
}

async function captureSourceState(queryable, ref, inspection) {
  let identity;
  try {
    identity = await mssqlQuery(queryable,
      'SELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name, @@VERSION AS server_version, @@SPID AS session_id'
    );
  } catch (error) {
    fail('MSSQL_SOURCE_IDENTITY_UNAVAILABLE', 'Unable to capture SQL Server source identity', { cause: error?.message });
  }
  const row = identity.recordset[0];
  if (!row || row.server_name === null || row.server_name === undefined) fail('MSSQL_SOURCE_IDENTITY_UNAVAILABLE', 'SQL Server instance has no server name');
  return createMssqlSourceState({
    serverName: String(row.server_name),
    databaseName: row.database_name,
    serverVersion: String(row.server_version),
    relation: { table: inspection.contract.relation.table },
    snapshot: { engine: 'snapshot-isolation', sessionId: String(row.session_id), isolationLevel: 'SNAPSHOT' },
    contractId: inspection.contractId
  });
}

function keysetPredicate(primaryKey, lastKey) {
  if (lastKey === null) return { sql: '', values: [] };
  if (!Array.isArray(lastKey) || lastKey.length !== primaryKey.length) fail('INVALID_MSSQL_SOURCE_CURSOR', 'SQL Server source cursor does not match primary-key arity');
  const clauses = primaryKey.map((field, index) => {
    const equals = primaryKey.slice(0, index).map((previous, previousIndex) => `${quoteIdentifier(previous)} = @p${previousIndex + 1}`).join(' AND ');
    const tail = `${quoteIdentifier(field)} > @p${index + 1}`;
    return index === 0 ? `(${tail})` : `(${equals} AND ${tail})`;
  });
  return { sql: `WHERE ${clauses.join(' OR ')}`, values: lastKey };
}

class MssqlSourceSnapshot {
  #queryable;

  constructor({ queryable, ref, state, contract, contractId, batchSize }) {
    this.#queryable = queryable;
    this.sourceRef = ref;
    this.sourceState = state;
    this.contract = contract;
    this.contractId = contractId;
    this.batchSize = batchSize;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('MSSQL_SOURCE_SNAPSHOT_CLOSED', 'SQL Server source snapshot is closed');
  }

  async assertReadOnly() {
    this.#assertOpen();
    // The snapshot principal must hold no mutating database rights at all:
    // least-privilege readers (db_datareader without write roles) prove the
    // session cannot change user data, which is the read-only guarantee.
    const permissions = await mssqlQuery(this.#queryable,
      `SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') AS can_insert,
              HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS can_update,
              HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE') AS can_delete,
              HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') AS can_alter,
              HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create`
    );
    const row = permissions.recordset[0] ?? {};
    for (const [field, value] of Object.entries(row)) {
      if (value === null || value === undefined) fail('MSSQL_SOURCE_PERMISSIONS_UNKNOWN', `SQL Server could not prove read-only rights (${field})`);
      if (Number(value) !== 0) fail('MSSQL_SOURCE_NOT_READ_ONLY', `SQL Server source principal holds mutating rights (${field})`);
    }
    return true;
  }

  async *batches() {
    this.#assertOpen();
    const columns = this.contract.columns.map(column => column.name);
    const primaryKey = this.contract.primaryKey;
    const selectColumns = columns.map(quoteIdentifier).join(', ');
    const order = primaryKey.map(quoteIdentifier).join(', ');
    const qualified = `dbo.${quoteIdentifier(this.sourceRef.table)}`;
    let lastKey = null;
    let offset = 0;

    for (;;) {
      this.#assertOpen();
      const predicate = keysetPredicate(primaryKey, lastKey);
      const limitIndex = predicate.values.length + 1;
      const result = await mssqlQuery(this.#queryable,
        `SELECT TOP (@p${limitIndex}) ${selectColumns} FROM ${qualified} ${predicate.sql} ORDER BY ${order}`,
        [...predicate.values, this.batchSize]
      );
      if (!result.recordset.length) return;
      const rows = Object.freeze(result.recordset.map(row => Object.freeze({ ...row })));
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

export async function withMssqlSourceSnapshot({ sourceRef, credentialBroker, batchSize = DEFAULT_BATCH_SIZE } = {}, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MSSQL_SOURCE_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_MSSQL_SOURCE_CONFIG', 'snapshot callback is required');
  const ref = sourceRefConfig(sourceRef);
  const size = requireBatchSize(batchSize);

  return withMssqlConnection({ targetRef: ref, credentialBroker }, async pool => {
    await mssqlQuery(pool, 'SET TRANSACTION ISOLATION LEVEL SNAPSHOT');
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    let snapshot;
    try {
      const inspection = await inspectRelation(transaction, ref);
      const sourceState = await captureSourceState(transaction, ref, inspection);
      snapshot = new MssqlSourceSnapshot({
        queryable: transaction,
        ref,
        state: sourceState,
        contract: inspection.contract,
        contractId: inspection.contractId,
        batchSize: size
      });
      await snapshot.assertReadOnly();
      const result = await callback(snapshot);
      snapshot.close();
      try { await transaction.commit(); } catch { /* read-only snapshot has nothing to commit */ }
      return result;
    } catch (error) {
      if (snapshot) snapshot.close();
      try { await transaction.rollback(); } catch { /* primary source failure wins */ }
      throw error;
    }
  });
}

export async function materializeMssqlSourceSnapshot({ sourceRef, credentialBroker, snapshotDir, batchSize = DEFAULT_BATCH_SIZE, chunkRows, maxChunkBytes } = {}) {
  return withMssqlSourceSnapshot({ sourceRef, credentialBroker, batchSize }, async snapshot => materializeSnapshotBatches({
    snapshotDir,
    sourceState: snapshot.sourceState,
    contract: snapshot.contract,
    contractId: snapshot.contractId,
    sourceIdentity: connectorIdentity(snapshot.sourceRef),
    batches: snapshot.batches(),
    chunkRows,
    maxChunkBytes
  }));
}

export function createMssqlSourceRuntime({ credentialBroker, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MSSQL_SOURCE_CONFIG', 'credentialBroker.withSecret() is required');
  const size = requireBatchSize(batchSize);
  return Object.freeze({
    descriptor: MSSQL_SOURCE_DESCRIPTOR,
    withSnapshot: (sourceRef, callback, options = {}) => withMssqlSourceSnapshot({
      sourceRef,
      credentialBroker,
      batchSize: options.batchSize ?? size
    }, callback),
    materializeSnapshot: (sourceRef, options = {}) => materializeMssqlSourceSnapshot({
      sourceRef,
      credentialBroker,
      snapshotDir: options.snapshotDir,
      batchSize: options.batchSize ?? size,
      chunkRows: options.chunkRows,
      maxChunkBytes: options.maxChunkBytes
    })
  });
}
