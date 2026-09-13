import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { withMysqlConnection } from './connection.js';
import { mysqlTargetContractId } from './preflight.js';

const LEDGER_TABLE = 'spool_batch_ledger';
const LEASE_TABLE = 'spool_execution_leases';
const PAYLOAD_DOMAIN = 'spool-mysql-batch-payload-v1';
const HASH = /^sha256:[0-9a-f]{64}$/;

function requiredString(name, value) {
  if (typeof value !== 'string' || !value) fail('INVALID_BATCH_EVIDENCE', `${name} must be a non-empty string`);
  return value;
}

function requiredHash(name, value) {
  requiredString(name, value);
  if (!HASH.test(value)) fail('INVALID_BATCH_EVIDENCE', `${name} must be a canonical sha256 identity`);
  return value;
}

function quoteIdentifier(value) {
  const text = requiredString('MySQL identifier', value);
  if (text.includes('\u0000')) fail('INVALID_MYSQL_IDENTIFIER', 'MySQL identifiers cannot contain NUL');
  return `\`${text.replaceAll('`', '``')}\``;
}

function validateRows(rows) {
  if (!Array.isArray(rows)) fail('INVALID_BATCH_ROWS', 'rows must be an array');
  if (rows.length === 0) return [];
  const first = rows[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) fail('INVALID_BATCH_ROW', 'Each row must be an object');
  const columns = Object.keys(first);
  if (columns.length === 0) fail('INVALID_BATCH_ROW', 'Rows must contain at least one column');
  const signature = [...columns].sort().join('\u0000');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_BATCH_ROW', 'Each row must be an object');
    const keys = Object.keys(row);
    if ([...keys].sort().join('\u0000') !== signature) fail('ROW_SHAPE_MISMATCH', 'All rows in a batch must have the same columns');
    for (const key of keys) {
      const value = row[key];
      if (value !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof value) && !(value instanceof Uint8Array) && !(value instanceof Date)) {
        fail('UNSUPPORTED_MYSQL_VALUE', `Unsupported MySQL value for ${key}`);
      }
      if (typeof value === 'number' && !Number.isFinite(value)) fail('UNSUPPORTED_MYSQL_VALUE', `Non-finite MySQL number for ${key}`);
    }
  }
  return columns;
}

export function mysqlPayloadEvidence(rows) {
  validateRows(rows);
  return Object.freeze({ rowCount: rows.length, payloadHash: sha256Canonical(PAYLOAD_DOMAIN, rows) });
}

function evidenceFrom(input, payloadHash, rowCount) {
  const mappingRevision = input.mappingRevision;
  if (!Number.isInteger(mappingRevision) || mappingRevision < 1) fail('INVALID_BATCH_EVIDENCE', 'mappingRevision must be >= 1');
  if (!Number.isInteger(rowCount) || rowCount < 0) fail('INVALID_BATCH_EVIDENCE', 'rowCount must be a non-negative integer');
  return {
    batchIdentity: requiredHash('batchIdentity', input.batchIdentity),
    migrationId: requiredString('migrationId', input.migrationId),
    planId: requiredHash('planId', input.planId),
    sourceSnapshotId: requiredHash('sourceSnapshotId', input.sourceSnapshotId),
    mappingRevision,
    rowCount,
    payloadHash: requiredHash('payloadHash', payloadHash)
  };
}

function ledgerMatches(row, evidence, targetRef) {
  return row
    && row.batch_identity === evidence.batchIdentity
    && row.migration_id === evidence.migrationId
    && row.plan_id === evidence.planId
    && row.source_snapshot_id === evidence.sourceSnapshotId
    && Number(row.mapping_revision) === evidence.mappingRevision
    && Number(row.row_count) === evidence.rowCount
    && row.payload_hash === evidence.payloadHash
    && row.target_database === targetRef.database
    && row.target_table === targetRef.table;
}

function safeFencingToken(value) {
  const token = typeof value === 'bigint' ? value : BigInt(value);
  if (token < 1n || token > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_FENCING_TOKEN', 'MySQL fencing token exceeds the supported safe integer range');
  return Number(token);
}

async function describeMetadata(connection) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)`,
    [LEDGER_TABLE, LEASE_TABLE]
  );
  return rows;
}

function validateMetadataDescription(rows) {
  const byTable = new Map();
  for (const row of rows) {
    if (!byTable.has(row.tableName)) byTable.set(row.tableName, new Set());
    byTable.get(row.tableName).add(row.columnName);
  }
  const ledger = byTable.get(LEDGER_TABLE) ?? new Set();
  const lease = byTable.get(LEASE_TABLE) ?? new Set();
  const requiredLedger = ['batch_identity', 'migration_id', 'plan_id', 'source_snapshot_id', 'mapping_revision', 'row_count', 'payload_hash', 'target_database', 'target_table', 'committed_at'];
  const requiredLease = ['resource', 'owner', 'fencing_token', 'expires_at', 'updated_at'];
  if (requiredLedger.some(name => !ledger.has(name)) || requiredLease.some(name => !lease.has(name))) {
    fail('MYSQL_METADATA_CONTRACT_INVALID', 'Existing SPOOL MySQL metadata tables do not match the required contract');
  }
}

export async function ensureMysqlMetadata({ targetRef, credentialBroker } = {}) {
  const description = await withMysqlConnection({ targetRef, credentialBroker }, async connection => {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(LEDGER_TABLE)} (
        batch_identity VARCHAR(255) PRIMARY KEY,
        migration_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        source_snapshot_id TEXT NOT NULL,
        mapping_revision INT NOT NULL CHECK (mapping_revision >= 1),
        row_count INT NOT NULL CHECK (row_count >= 0),
        payload_hash TEXT NOT NULL,
        target_database TEXT NOT NULL,
        target_table TEXT NOT NULL,
        committed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(LEASE_TABLE)} (
        resource VARCHAR(255) PRIMARY KEY,
        owner TEXT NOT NULL,
        fencing_token BIGINT NOT NULL CHECK (fencing_token >= 1),
        expires_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      )
    `);
    return describeMetadata(connection);
  });
  validateMetadataDescription(description);
}

export async function acquireMysqlLease({ targetRef, credentialBroker, resource, owner, ttlMs } = {}) {
  requiredString('resource', resource); requiredString('owner', owner);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('INVALID_MYSQL_RUNTIME_CONFIG', 'ttlMs must be a positive safe integer');
  await ensureMysqlMetadata({ targetRef, credentialBroker });

  const result = await withMysqlConnection({ targetRef, credentialBroker }, async connection => {
    await connection.beginTransaction();
    try {
      const [existingRows] = await connection.query(
        `SELECT owner, CAST(fencing_token AS CHAR) AS fencing_token, expires_at, expires_at > UTC_TIMESTAMP(3) AS active
         FROM ${quoteIdentifier(LEASE_TABLE)} WHERE resource = ? FOR UPDATE`,
        [resource]
      );
      const existing = existingRows[0] ?? null;
      if (existing && existing.owner !== owner && Number(existing.active) === 1) {
        await connection.rollback();
        return { status: 'HELD', owner: existing.owner, fencingToken: existing.fencing_token };
      }
      const nextToken = existing
        ? (existing.owner === owner ? BigInt(existing.fencing_token) : BigInt(existing.fencing_token) + 1n)
        : 1n;
      if (nextToken > BigInt(Number.MAX_SAFE_INTEGER)) {
        await connection.rollback();
        return { status: 'TOKEN_OVERFLOW' };
      }
      await connection.query(
        `INSERT INTO ${quoteIdentifier(LEASE_TABLE)} (resource, owner, fencing_token, expires_at, updated_at)
         VALUES (?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL ? MICROSECOND, UTC_TIMESTAMP(3)) AS incoming
         ON DUPLICATE KEY UPDATE owner = incoming.owner, fencing_token = incoming.fencing_token,
           expires_at = incoming.expires_at, updated_at = incoming.updated_at`,
        [resource, owner, nextToken.toString(), ttlMs * 1000]
      );
      const [fresh] = await connection.query(
        `SELECT CAST(fencing_token AS CHAR) AS fencing_token, expires_at
         FROM ${quoteIdentifier(LEASE_TABLE)} WHERE resource = ?`,
        [resource]
      );
      await connection.commit();
      return { status: 'ACQUIRED', fencingToken: fresh[0].fencing_token, expiresAt: fresh[0].expires_at };
    } catch (error) {
      try { await connection.rollback(); } catch { /* primary error wins */ }
      throw error;
    }
  });

  if (result.status === 'HELD') fail('LEASE_HELD', 'MySQL execution lease is held by another owner', { resource, owner: result.owner });
  if (result.status === 'TOKEN_OVERFLOW') fail('FENCING_TOKEN_EXHAUSTED', 'MySQL fencing token exceeded the supported safe integer range', { resource });
  return Object.freeze({ resource, owner, fencingToken: safeFencingToken(result.fencingToken), expiresAt: new Date(result.expiresAt).toISOString() });
}

export async function releaseMysqlLease({ targetRef, credentialBroker, resource, owner, fencingToken } = {}) {
  requiredString('resource', resource); requiredString('owner', owner);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) fail('INVALID_FENCING_TOKEN', 'fencingToken must be a positive safe integer');
  await withMysqlConnection({ targetRef, credentialBroker }, async connection => {
    await connection.query(
      `UPDATE ${quoteIdentifier(LEASE_TABLE)} SET expires_at = FROM_UNIXTIME(0) WHERE resource = ? AND owner = ? AND fencing_token = ?`,
      [resource, owner, fencingToken]
    );
  });
}

async function findLedgerEntry(connection, targetRef, batchIdentity) {
  const [rows] = await connection.query(
    `SELECT batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
            row_count, payload_hash, target_database, target_table, committed_at
     FROM ${quoteIdentifier(LEDGER_TABLE)} WHERE batch_identity = ? FOR UPDATE`,
    [batchIdentity]
  );
  return rows[0] ?? null;
}

async function insertLedgerEntry(connection, targetRef, evidence) {
  await connection.query(
    `INSERT INTO ${quoteIdentifier(LEDGER_TABLE)}
       (batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
        row_count, payload_hash, target_database, target_table)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      evidence.batchIdentity, evidence.migrationId, evidence.planId, evidence.sourceSnapshotId,
      evidence.mappingRevision, evidence.rowCount, evidence.payloadHash,
      targetRef.database, targetRef.table
    ]
  );
}

async function insertRows(connection, targetRef, columns, rows) {
  if (!rows.length) return;
  const qualifiedTable = quoteIdentifier(targetRef.table);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const maxRowsPerStatement = Math.max(1, Math.min(1000, Math.floor(60_000 / columns.length)));
  for (let offset = 0; offset < rows.length; offset += maxRowsPerStatement) {
    const chunk = rows.slice(offset, offset + maxRowsPerStatement);
    const values = [];
    const groups = chunk.map(row => {
      const placeholders = columns.map(column => {
        const value = row[column];
        values.push(value === undefined ? null : (value instanceof Uint8Array ? Buffer.from(value) : value));
        return '?';
      });
      return `(${placeholders.join(', ')})`;
    });
    await connection.query(`INSERT INTO ${qualifiedTable} (${quotedColumns}) VALUES ${groups.join(', ')}`, values);
  }
}

export class MysqlTarget {
  constructor({ targetRef, credentialBroker, requireFencing = false, fenceResource = null, fenceOwner = null } = {}) {
    if (!targetRef || typeof targetRef !== 'object') fail('INVALID_MYSQL_CONFIG', 'targetRef is required');
    this.targetRef = Object.freeze(structuredClone(targetRef));
    this.credentialBroker = credentialBroker;
    this.requireFencing = requireFencing;
    this.fenceResource = fenceResource;
    this.fenceOwner = fenceOwner;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('MYSQL_TARGET_CLOSED', 'MySQL target is closed');
  }

  describeBatch(input = {}) {
    this.#assertOpen();
    return mysqlPayloadEvidence(input.rows);
  }

  async reconcileTargetCommit(input = {}) {
    this.#assertOpen();
    let evidence;
    try {
      evidence = evidenceFrom(input, input.payloadHash, input.rowCount);
      const row = await withMysqlConnection({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async connection => {
        const [rows] = await connection.query(
          `SELECT batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
                  row_count, payload_hash, target_database, target_table, committed_at
           FROM ${quoteIdentifier(LEDGER_TABLE)} WHERE batch_identity = ?`,
          [evidence.batchIdentity]
        );
        return rows[0] ?? null;
      });
      if (!row) return Object.freeze({ status: 'NOT_COMMITTED', batchIdentity: evidence.batchIdentity });
      if (!ledgerMatches(row, evidence, this.targetRef)) return Object.freeze({ status: 'CONFLICT', batchIdentity: evidence.batchIdentity });
      return Object.freeze({
        status: 'COMMITTED_EXACT', batchIdentity: evidence.batchIdentity,
        rowCount: evidence.rowCount, payloadHash: evidence.payloadHash,
        committedAt: new Date(row.committed_at).toISOString()
      });
    } catch (error) {
      if (error?.code === 'INVALID_BATCH_EVIDENCE') throw error;
      return Object.freeze({ status: 'INDETERMINATE', batchIdentity: input?.batchIdentity ?? null });
    }
  }

  async commitBatch(input = {}) {
    this.#assertOpen();
    const rows = input.rows;
    const columns = validateRows(rows);
    const described = mysqlPayloadEvidence(rows);
    const evidence = evidenceFrom(input, described.payloadHash, described.rowCount);
    if (this.requireFencing && (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)) fail('FENCE_REQUIRED', 'Production MySQL mutation requires a fencing token');

    const result = await withMysqlConnection({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async connection => {
      await connection.beginTransaction();
      try {
        if (this.requireFencing) {
          const [fenceRows] = await connection.query(
            `SELECT owner, CAST(fencing_token AS CHAR) AS fencing_token, expires_at > UTC_TIMESTAMP(3) AS active
             FROM ${quoteIdentifier(LEASE_TABLE)} WHERE resource = ? FOR UPDATE`,
            [this.fenceResource]
          );
          const fence = fenceRows[0] ?? null;
          if (!fence || Number(fence.fencing_token) !== input.fencingToken || fence.owner !== this.fenceOwner) {
            await connection.rollback();
            fail('STALE_FENCE', 'MySQL mutation fencing token is stale', { resource: this.fenceResource, expected: fence?.fencing_token ?? null, actual: input.fencingToken });
          }
          if (Number(fence.active) !== 1) {
            await connection.rollback();
            fail('LEASE_EXPIRED', 'MySQL mutation lease has expired', { resource: this.fenceResource, fencingToken: input.fencingToken });
          }
        }

        if (input.targetContractId != null) {
          requiredHash('targetContractId', input.targetContractId);
          const actualTargetContractId = await mysqlTargetContractId(connection, this.targetRef);
          if (actualTargetContractId !== input.targetContractId) {
            await connection.rollback();
            fail('TARGET_CONTRACT_CHANGED', 'Live MySQL target contract changed after planning/approval', { expectedTargetContractId: input.targetContractId, actualTargetContractId });
          }
        }

        const existing = await findLedgerEntry(connection, this.targetRef, evidence.batchIdentity);
        if (existing) {
          if (!ledgerMatches(existing, evidence, this.targetRef)) {
            await connection.rollback();
            return { kind: 'BATCH_IDENTITY_CONFLICT' };
          }
          await connection.commit();
          return { kind: 'COMMITTED_EXACT', alreadyCommitted: true };
        }

        await insertRows(connection, this.targetRef, columns, rows);
        await insertLedgerEntry(connection, this.targetRef, evidence);
        await connection.commit();
        return { kind: 'COMMITTED_EXACT', alreadyCommitted: false };
      } catch (error) {
        try { await connection.rollback(); } catch { /* primary error wins */ }
        throw error;
      }
    });

    if (result.kind === 'BATCH_IDENTITY_CONFLICT') fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', { batchIdentity: evidence.batchIdentity });
    if (result.kind !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'MySQL target did not return exact commit evidence');
    return Object.freeze({
      status: 'COMMITTED_EXACT', alreadyCommitted: result.alreadyCommitted,
      batchIdentity: evidence.batchIdentity, rowCount: evidence.rowCount, payloadHash: evidence.payloadHash
    });
  }

  async ledgerEntries({ migrationId = null } = {}) {
    this.#assertOpen();
    const values = [this.targetRef.database, this.targetRef.table];
    let migrationClause = '';
    if (migrationId) { values.push(migrationId); migrationClause = ' AND migration_id = ?'; }
    const rows = await withMysqlConnection({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async connection => {
      const [found] = await connection.query(
        `SELECT batch_identity AS batchIdentity, migration_id AS migrationId, plan_id AS planId,
                source_snapshot_id AS sourceSnapshotId, mapping_revision AS mappingRevision,
                row_count AS rowCount, payload_hash AS payloadHash, target_table AS targetTable,
                committed_at AS committedAt
         FROM ${quoteIdentifier(LEDGER_TABLE)} WHERE target_database = ? AND target_table = ?${migrationClause}
         ORDER BY committed_at, batch_identity`,
        values
      );
      return found;
    });
    return rows.map(row => Object.freeze({ ...row, mappingRevision: Number(row.mappingRevision), rowCount: Number(row.rowCount), committedAt: new Date(row.committedAt).toISOString() }));
  }

  close() { this.closed = true; }
}
