import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { connectorIdentity } from '../../platform/contracts.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { createMysqlSourceState } from '../../protocol/state-descriptors.js';
import { validateConnectorDescriptor } from '../contract.js';
import { materializeSnapshotBatches } from '../materialized-snapshot.js';
import { parseMysqlEndpoint, withMysqlConnection } from './connection.js';

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10_000;

export const MYSQL_SOURCE_DESCRIPTOR = validateConnectorDescriptor({
  name: 'mysql',
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
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_MYSQL_SOURCE_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_MYSQL_SOURCE_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

function sourceRefConfig(sourceRef) {
  if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) fail('INVALID_SOURCE_REF', 'MySQL sourceRef is required');
  if (sourceRef.connector !== 'mysql') fail('UNSUPPORTED_SOURCE_CONNECTOR', 'MySQL source runtime requires connector mysql');
  if (sourceRef.path != null) fail('INVALID_SOURCE_REF', 'MySQL sourceRef must not contain a filesystem path');
  const endpoint = parseMysqlEndpoint(sourceRef.endpoint);
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
    fail('INVALID_MYSQL_SOURCE_CONFIG', `batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return size;
}

async function inspectRelation(connection, ref) {
  const [tables] = await connection.query(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = \'BASE TABLE\'',
    [ref.database, ref.table]
  );
  if (tables.length !== 1) fail('MYSQL_SOURCE_NOT_FOUND', `MySQL source ${ref.database}.${ref.table} was not found`);
  const [columns] = await connection.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS isNullable, ORDINAL_POSITION AS position
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [ref.database, ref.table]
  );
  if (!columns.length) fail('MYSQL_SOURCE_EMPTY_SCHEMA', 'MySQL source relation has no readable columns');
  const [keys] = await connection.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI' ORDER BY ORDINAL_POSITION`,
    [ref.database, ref.table]
  );
  if (!keys.length) {
    fail('MYSQL_SOURCE_ORDER_REQUIRED', 'MySQL C1 source streaming requires a primary key for deterministic keyset traversal');
  }
  const contract = Object.freeze({
    schemaVersion: 1,
    relation: Object.freeze({ database: ref.database, table: ref.table }),
    columns: Object.freeze(columns.map(row => Object.freeze({
      name: row.name,
      type: String(row.type).toLowerCase(),
      nullable: row.isNullable === 'YES',
      position: Number(row.position)
    }))),
    primaryKey: Object.freeze(keys.map(row => row.name))
  });
  const contractId = sha256Canonical('spool-mysql-source-contract-v1', contract);
  return Object.freeze({ contract, contractId });
}

async function captureSourceState(connection, ref, inspection) {
  let identity;
  try {
    identity = await connection.query(
      `SELECT @@server_uuid AS server_uuid, DATABASE() AS database_name, VERSION() AS server_version,
              CONNECTION_ID() AS connection_id`
    );
  } catch (error) {
    fail('MYSQL_SOURCE_IDENTITY_UNAVAILABLE', 'Unable to capture MySQL source identity', { cause: error?.message });
  }
  const row = identity[0][0];
  // The consistent snapshot is pinned to this session for the transaction
  // lifetime, so the connection id identifies the snapshot without requiring
  // any privilege beyond reading user tables.
  if (row.connection_id === null || row.connection_id === undefined) fail('MYSQL_SOURCE_IDENTITY_UNAVAILABLE', 'MySQL source connection has no connection ID');
  return createMysqlSourceState({
    serverUuid: String(row.server_uuid),
    databaseName: row.database_name,
    serverVersion: String(row.server_version),
    relation: { table: inspection.contract.relation.table },
    snapshot: { engine: 'innodb-consistent-read', connectionId: String(row.connection_id), isolationLevel: 'REPEATABLE READ' },
    contractId: inspection.contractId
  });
}

function keysetPredicate(primaryKey, lastKey) {
  if (lastKey === null) return { sql: '', values: [] };
  if (!Array.isArray(lastKey) || lastKey.length !== primaryKey.length) fail('INVALID_MYSQL_SOURCE_CURSOR', 'MySQL source cursor does not match primary-key arity');
  const left = primaryKey.map(quoteIdentifier).join(', ');
  const right = primaryKey.map(() => '?').join(', ');
  return { sql: `WHERE (${left}) > (${right})`, values: lastKey };
}

class MysqlSourceSnapshot {
  #connection;

  constructor({ connection, ref, state, contract, contractId, batchSize }) {
    this.#connection = connection;
    this.sourceRef = ref;
    this.sourceState = state;
    this.contract = contract;
    this.contractId = contractId;
    this.batchSize = batchSize;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('MYSQL_SOURCE_SNAPSHOT_CLOSED', 'MySQL source snapshot is closed');
  }

  async assertReadOnly() {
    this.#assertOpen();
    const [rows] = await this.#connection.query('SELECT @@transaction_read_only AS read_only');
    if (Number(rows[0]?.read_only) !== 1) fail('MYSQL_SOURCE_NOT_READ_ONLY', 'MySQL source transaction is not read-only');
    return true;
  }

  async *batches() {
    this.#assertOpen();
    const columns = this.contract.columns.map(column => column.name);
    const primaryKey = this.contract.primaryKey;
    const selectColumns = columns.map(quoteIdentifier).join(', ');
    const order = primaryKey.map(quoteIdentifier).join(', ');
    const qualified = quoteIdentifier(this.sourceRef.table);
    let lastKey = null;
    let offset = 0;

    for (;;) {
      this.#assertOpen();
      const predicate = keysetPredicate(primaryKey, lastKey);
      const values = [...predicate.values, this.batchSize];
      const [resultRows] = await this.#connection.query(
        `SELECT ${selectColumns} FROM ${qualified} ${predicate.sql} ORDER BY ${order} LIMIT ?`,
        values
      );
      if (!resultRows.length) return;
      const rows = Object.freeze(resultRows.map(row => Object.freeze({ ...row })));
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

export async function withMysqlSourceSnapshot({ sourceRef, credentialBroker, batchSize = DEFAULT_BATCH_SIZE } = {}, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MYSQL_SOURCE_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_MYSQL_SOURCE_CONFIG', 'snapshot callback is required');
  const ref = sourceRefConfig(sourceRef);
  const size = requireBatchSize(batchSize);

  return withMysqlConnection({ targetRef: ref, credentialBroker }, async connection => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    let snapshot;
    try {
      const inspection = await inspectRelation(connection, ref);
      const sourceState = await captureSourceState(connection, ref, inspection);
      snapshot = new MysqlSourceSnapshot({
        connection,
        ref,
        state: sourceState,
        contract: inspection.contract,
        contractId: inspection.contractId,
        batchSize: size
      });
      await snapshot.assertReadOnly();
      const result = await callback(snapshot);
      snapshot.close();
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      if (snapshot) snapshot.close();
      try { await connection.query('ROLLBACK'); } catch { /* primary source failure wins */ }
      throw error;
    }
  });
}

export async function materializeMysqlSourceSnapshot({ sourceRef, credentialBroker, snapshotDir, batchSize = DEFAULT_BATCH_SIZE, chunkRows, maxChunkBytes } = {}) {
  return withMysqlSourceSnapshot({ sourceRef, credentialBroker, batchSize }, async snapshot => materializeSnapshotBatches({
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

export function createMysqlSourceRuntime({ credentialBroker, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MYSQL_SOURCE_CONFIG', 'credentialBroker.withSecret() is required');
  const size = requireBatchSize(batchSize);
  return Object.freeze({
    descriptor: MYSQL_SOURCE_DESCRIPTOR,
    withSnapshot: (sourceRef, callback, options = {}) => withMysqlSourceSnapshot({
      sourceRef,
      credentialBroker,
      batchSize: options.batchSize ?? size
    }, callback),
    materializeSnapshot: (sourceRef, options = {}) => materializeMysqlSourceSnapshot({
      sourceRef,
      credentialBroker,
      snapshotDir: options.snapshotDir,
      batchSize: options.batchSize ?? size,
      chunkRows: options.chunkRows,
      maxChunkBytes: options.maxChunkBytes
    })
  });
}
