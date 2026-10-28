import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { withMssqlConnection } from './connection.js';
import { loadMssqlDriver } from './driver.js';
import { mssqlQuery, mssqlTargetContractId } from './preflight.js';

const LEDGER_TABLE = 'spool_batch_ledger';
const LEASE_TABLE = 'spool_execution_leases';
const PAYLOAD_DOMAIN = 'spool-mssql-batch-payload-v1';
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
  const text = requiredString('SQL Server identifier', value);
  if (text.includes('\u0000')) fail('INVALID_MSSQL_IDENTIFIER', 'SQL Server identifiers cannot contain NUL');
  if (text.includes('[') || text.includes(']')) fail('INVALID_MSSQL_IDENTIFIER', 'SQL Server identifiers cannot contain brackets');
  return `[${text}]`;
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
        fail('UNSUPPORTED_MSSQL_VALUE', `Unsupported SQL Server value for ${key}`);
      }
      if (typeof value === 'number' && !Number.isFinite(value)) fail('UNSUPPORTED_MSSQL_VALUE', `Non-finite SQL Server number for ${key}`);
    }
  }
  return columns;
}

export function mssqlPayloadEvidence(rows) {
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
  if (token < 1n || token > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_FENCING_TOKEN', 'SQL Server fencing token exceeds the supported safe integer range');
  return Number(token);
}

async function tableExists(queryable, table) {
  const result = await mssqlQuery(queryable, 'SELECT OBJECT_ID(@p1, \'U\') AS objectId', [`dbo.${table}`]);
  return result.recordset[0]?.objectId != null;
}

export async function ensureMssqlMetadata({ targetRef, credentialBroker } = {}) {
  await withMssqlConnection({ targetRef, credentialBroker }, async pool => {
    for (const statement of [
      `IF OBJECT_ID('dbo.${LEDGER_TABLE}', 'U') IS NULL CREATE TABLE dbo.${quoteIdentifier(LEDGER_TABLE)} (
        batch_identity NVARCHAR(255) PRIMARY KEY,
        migration_id NVARCHAR(MAX) NOT NULL,
        plan_id NVARCHAR(MAX) NOT NULL,
        source_snapshot_id NVARCHAR(MAX) NOT NULL,
        mapping_revision INT NOT NULL CHECK (mapping_revision >= 1),
        row_count INT NOT NULL CHECK (row_count >= 0),
        payload_hash NVARCHAR(MAX) NOT NULL,
        target_database NVARCHAR(128) NOT NULL,
        target_table NVARCHAR(128) NOT NULL,
        committed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      )`,
      `IF OBJECT_ID('dbo.${LEASE_TABLE}', 'U') IS NULL CREATE TABLE dbo.${quoteIdentifier(LEASE_TABLE)} (
        resource NVARCHAR(255) PRIMARY KEY,
        owner NVARCHAR(MAX) NOT NULL,
        fencing_token BIGINT NOT NULL CHECK (fencing_token >= 1),
        expires_at DATETIME2 NOT NULL,
        updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      )`
    ]) {
      try {
        await mssqlQuery(pool, statement);
      } catch (error) {
        if (error?.number !== 2714) throw error;
      }
    }
    const ledger = await tableExists(pool, LEDGER_TABLE);
    const lease = await tableExists(pool, LEASE_TABLE);
    if (!ledger || !lease) fail('MSSQL_METADATA_CONTRACT_INVALID', 'SPOOL SQL Server metadata tables are unavailable');
    for (const [table, required] of [
      [LEDGER_TABLE, ['batch_identity', 'migration_id', 'plan_id', 'source_snapshot_id', 'mapping_revision', 'row_count', 'payload_hash', 'target_database', 'target_table', 'committed_at']],
      [LEASE_TABLE, ['resource', 'owner', 'fencing_token', 'expires_at', 'updated_at']]
    ]) {
      const columns = await mssqlQuery(pool, 'SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2', ['dbo', table]);
      const present = new Set(columns.recordset.map(row => String(row.name).toLowerCase()));
      if (required.some(name => !present.has(name))) {
        fail('MSSQL_METADATA_CONTRACT_INVALID', 'Existing SPOOL SQL Server metadata tables do not match the required contract');
      }
    }
  });
}

export async function acquireMssqlLease({ targetRef, credentialBroker, resource, owner, ttlMs } = {}) {
  requiredString('resource', resource); requiredString('owner', owner);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('INVALID_MSSQL_RUNTIME_CONFIG', 'ttlMs must be a positive safe integer');
  const sql = await loadMssqlDriver();
  await ensureMssqlMetadata({ targetRef, credentialBroker });

  const result = await withMssqlConnection({ targetRef, credentialBroker }, async pool => {
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const found = await mssqlQuery(transaction,
        `SELECT owner, CAST(fencing_token AS VARCHAR) AS fencing_token,
                CASE WHEN expires_at > SYSUTCDATETIME() THEN 1 ELSE 0 END AS active
         FROM dbo.${quoteIdentifier(LEASE_TABLE)} WITH (UPDLOCK, HOLDLOCK) WHERE resource = @p1`,
        [resource]
      );
      const existing = found.recordset[0] ?? null;
      if (existing && existing.owner !== owner && Number(existing.active) === 1) {
        await transaction.rollback();
        return { status: 'HELD', owner: existing.owner, fencingToken: existing.fencing_token };
      }
      const nextToken = existing
        ? (existing.owner === owner ? BigInt(existing.fencing_token) : BigInt(existing.fencing_token) + 1n)
        : 1n;
      if (nextToken > BigInt(Number.MAX_SAFE_INTEGER)) {
        await transaction.rollback();
        return { status: 'TOKEN_OVERFLOW' };
      }
      const upserted = await mssqlQuery(transaction,
        `UPDATE dbo.${quoteIdentifier(LEASE_TABLE)}
         SET owner = @p1, fencing_token = @p2, expires_at = DATEADD(MICROSECOND, @p3, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
         WHERE resource = @p4`,
        [owner, nextToken.toString(), ttlMs * 1000, resource]
      );
      if (upserted.rowsAffected[0] === 0) {
        await mssqlQuery(transaction,
          `INSERT INTO dbo.${quoteIdentifier(LEASE_TABLE)} (resource, owner, fencing_token, expires_at, updated_at)
           VALUES (@p1, @p2, @p3, DATEADD(MICROSECOND, @p4, SYSUTCDATETIME()), SYSUTCDATETIME())`,
          [resource, owner, nextToken.toString(), ttlMs * 1000]
        );
      }
      const fresh = await mssqlQuery(transaction,
        `SELECT CAST(fencing_token AS VARCHAR) AS fencing_token, expires_at
         FROM dbo.${quoteIdentifier(LEASE_TABLE)} WHERE resource = @p1`,
        [resource]
      );
      await transaction.commit();
      return { status: 'ACQUIRED', fencingToken: fresh.recordset[0].fencing_token, expiresAt: fresh.recordset[0].expires_at };
    } catch (error) {
      try { await transaction.rollback(); } catch { /* primary error wins */ }
      throw error;
    }
  });

  if (result.status === 'HELD') fail('LEASE_HELD', 'SQL Server execution lease is held by another owner', { resource, owner: result.owner });
  if (result.status === 'TOKEN_OVERFLOW') fail('FENCING_TOKEN_EXHAUSTED', 'SQL Server fencing token exceeded the supported safe integer range', { resource });
  return Object.freeze({ resource, owner, fencingToken: safeFencingToken(result.fencingToken), expiresAt: new Date(result.expiresAt).toISOString() });
}

export async function releaseMssqlLease({ targetRef, credentialBroker, resource, owner, fencingToken } = {}) {
  requiredString('resource', resource); requiredString('owner', owner);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) fail('INVALID_FENCING_TOKEN', 'fencingToken must be a positive safe integer');
  await withMssqlConnection({ targetRef, credentialBroker }, async pool => {
    await mssqlQuery(pool,
      `UPDATE dbo.${quoteIdentifier(LEASE_TABLE)} SET expires_at = CAST('1970-01-01' AS DATETIME2)
       WHERE resource = @p1 AND owner = @p2 AND fencing_token = @p3`,
      [resource, owner, fencingToken]
    );
  });
}

function bindValue(request, name, value) {
  if (value === undefined) request.input(name, null);
  else if (value instanceof Uint8Array) request.input(name, Buffer.from(value));
  else request.input(name, value);
}

async function insertRows(sql, transaction, targetRef, columns, rows) {
  if (!rows.length) return;
  const qualifiedTable = `dbo.${quoteIdentifier(targetRef.table)}`;
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const maxRowsPerStatement = Math.max(1, Math.min(500, Math.floor(2000 / columns.length)));
  for (let offset = 0; offset < rows.length; offset += maxRowsPerStatement) {
    const chunk = rows.slice(offset, offset + maxRowsPerStatement);
    const request = new sql.Request(transaction);
    const groups = chunk.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        const name = `r${offset + rowIndex}c${columnIndex}`;
        bindValue(request, name, row[column]);
        return `@${name}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await request.query(`INSERT INTO ${qualifiedTable} (${quotedColumns}) VALUES ${groups.join(', ')}`);
  }
}

export class MssqlTarget {
  constructor({ targetRef, credentialBroker, requireFencing = false, fenceResource = null, fenceOwner = null } = {}) {
    if (!targetRef || typeof targetRef !== 'object') fail('INVALID_MSSQL_CONFIG', 'targetRef is required');
    this.targetRef = Object.freeze(structuredClone(targetRef));
    this.credentialBroker = credentialBroker;
    this.requireFencing = requireFencing;
    this.fenceResource = fenceResource;
    this.fenceOwner = fenceOwner;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('MSSQL_TARGET_CLOSED', 'SQL Server target is closed');
  }

  describeBatch(input = {}) {
    this.#assertOpen();
    return mssqlPayloadEvidence(input.rows);
  }

  async reconcileTargetCommit(input = {}) {
    this.#assertOpen();
    let evidence;
    try {
      evidence = evidenceFrom(input, input.payloadHash, input.rowCount);
      const row = await withMssqlConnection({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async pool => {
        const found = await mssqlQuery(pool,
          `SELECT batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
                  row_count, payload_hash, target_database, target_table, committed_at
           FROM dbo.${quoteIdentifier(LEDGER_TABLE)} WHERE batch_identity = @p1`,
          [evidence.batchIdentity]
        );
        return found.recordset[0] ?? null;
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
    const described = mssqlPayloadEvidence(rows);
    const evidence = evidenceFrom(input, described.payloadHash, described.rowCount);
    if (this.requireFencing && (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)) fail('FENCE_REQUIRED', 'Production SQL Server mutation requires a fencing token');
    const sql = await loadMssqlDriver();

    const result = await withMssqlConnection({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async pool => {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        if (this.requireFencing) {
          const fenceResult = await mssqlQuery(transaction,
            `SELECT owner, CAST(fencing_token AS VARCHAR) AS fencing_token,
                    CASE WHEN expires_at > SYSUTCDATETIME() THEN 1 ELSE 0 END AS active
             FROM dbo.${quoteIdentifier(LEASE_TABLE)} WITH (UPDLOCK, HOLDLOCK) WHERE resource = @p1`,
            [this.fenceResource]
          );
          const fence = fenceResult.recordset[0] ?? null;
          if (!fence || Number(fence.fencing_token) !== input.fencingToken || fence.owner !== this.fenceOwner) {
            await transaction.rollback();
            fail('STALE_FENCE', 'SQL Server mutation fencing token is stale', { resource: this.fenceResource, expected: fence?.fencing_token ?? null, actual: input.fencingToken });
          }
          if (Number(fence.active) !== 1) {
            await transaction.rollback();
            fail('LEASE_EXPIRED', 'SQL Server mutation lease has expired', { resource: this.fenceResource, fencingToken: input.fencingToken });
          }
        }

        if (input.targetContractId != null) {
          requiredHash('targetContractId', input.targetContractId);
          const actualTargetContractId = await mssqlTargetContractId(transaction, this.targetRef);
          if (actualTargetContractId !== input.targetContractId) {
            await transaction.rollback();
            fail('TARGET_CONTRACT_CHANGED', 'Live SQL Server target contract changed after planning/approval', { expectedTargetContractId: input.targetContractId, actualTargetContractId });
          }
        }

        const existingResult = await mssqlQuery(transaction,
          `SELECT batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
                  row_count, payload_hash, target_database, target_table, committed_at
           FROM dbo.${quoteIdentifier(LEDGER_TABLE)} WITH (UPDLOCK, HOLDLOCK) WHERE batch_identity = @p1`,
          [evidence.batchIdentity]
        );
        const existing = existingResult.recordset[0] ?? null;
        if (existing) {
          if (!ledgerMatches(existing, evidence, this.targetRef)) {
            await transaction.rollback();
            return { kind: 'BATCH_IDENTITY_CONFLICT' };
          }
          await transaction.commit();
          return { kind: 'COMMITTED_EXACT', alreadyCommitted: true };
        }

        await insertRows(sql, transaction, this.targetRef, columns, rows);
        await mssqlQuery(transaction,
          `INSERT INTO dbo.${quoteIdentifier(LEDGER_TABLE)}
             (batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
              row_count, payload_hash, target_database, target_table)
           VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9)`,
          [
            evidence.batchIdentity, evidence.migrationId, evidence.planId, evidence.sourceSnapshotId,
            evidence.mappingRevision, evidence.rowCount, evidence.payloadHash,
            this.targetRef.database, this.targetRef.table
          ]
        );
        await transaction.commit();
        return { kind: 'COMMITTED_EXACT', alreadyCommitted: false };
      } catch (error) {
        try { await transaction.rollback(); } catch { /* primary error wins */ }
        throw error;
      }
    });

    if (result.kind === 'BATCH_IDENTITY_CONFLICT') fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', { batchIdentity: evidence.batchIdentity });
    if (result.kind !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'SQL Server target did not return exact commit evidence');
    return Object.freeze({
      status: 'COMMITTED_EXACT', alreadyCommitted: result.alreadyCommitted,
      batchIdentity: evidence.batchIdentity, rowCount: evidence.rowCount, payloadHash: evidence.payloadHash
    });
  }

  async ledgerEntries({ migrationId = null } = {}) {
    this.#assertOpen();
    const values = [this.targetRef.database, this.targetRef.table];
    let migrationClause = '';
    if (migrationId) { values.push(migrationId); migrationClause = ' AND migration_id = @p3'; }
    const rows = await withMssqlConnection({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async pool => {
      const found = await mssqlQuery(pool,
        `SELECT batch_identity AS [batchIdentity], migration_id AS [migrationId], plan_id AS [planId],
                source_snapshot_id AS [sourceSnapshotId], mapping_revision AS [mappingRevision],
                row_count AS [rowCount], payload_hash AS [payloadHash], target_table AS [targetTable],
                committed_at AS [committedAt]
         FROM dbo.${quoteIdentifier(LEDGER_TABLE)} WHERE target_database = @p1 AND target_table = @p2${migrationClause}
         ORDER BY committed_at, batch_identity`,
        values
      );
      return found.recordset;
    });
    return rows.map(row => Object.freeze({
      batchIdentity: row.batchIdentity, migrationId: row.migrationId, planId: row.planId,
      sourceSnapshotId: row.sourceSnapshotId, mappingRevision: Number(row.mappingRevision),
      rowCount: Number(row.rowCount), payloadHash: row.payloadHash, targetTable: row.targetTable,
      committedAt: new Date(row.committedAt).toISOString()
    }));
  }

  close() { this.closed = true; }
}
