import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { normalizeBigQueryRef, escapeBigQueryTable, withBigQueryClient } from './connection.js';

const METADATA_DATASET = '_spool_metadata';
const LEDGER_TABLE = '_spool_batch_ledger';
const LEASE_TABLE = '_spool_execution_leases';
const PAYLOAD_DOMAIN = 'spool-bigquery-batch-v1';
const ATOMIC_PROTOCOL = 'SPOOL_ATOMIC_V2';

function safeColumnName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    fail('INVALID_BIGQUERY_IDENTIFIER', 'Only ordinary unambiguous column identifiers are supported for transactional writes');
  }
  return `\`${name}\``;
}


export function bigqueryPayloadEvidence(rows) {
  if (!Array.isArray(rows)) fail('INVALID_BATCH_ROWS', 'Batch rows must be an array');
  const payloadHash = sha256Canonical(PAYLOAD_DOMAIN, rows);
  return Object.freeze({ rowCount: rows.length, payloadHash });
}

export async function ensureBigQueryMetadata(client, projectId) {
  const metaTable = `\`${projectId}.${METADATA_DATASET}.${LEDGER_TABLE}\``;
  const leaseTable = `\`${projectId}.${METADATA_DATASET}.${LEASE_TABLE}\``;

  await client.query(`CREATE SCHEMA IF NOT EXISTS \`${projectId}.${METADATA_DATASET}\``);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${metaTable} (
      batch_identity STRING NOT NULL,
      migration_id STRING NOT NULL,
      plan_id STRING NOT NULL,
      row_count INT64 NOT NULL,
      payload_hash STRING NOT NULL,
      fencing_token INT64 NOT NULL,
      committed_at TIMESTAMP NOT NULL,
      commit_protocol STRING
    )
  `);

  await client.query(`ALTER TABLE ${metaTable} ADD COLUMN IF NOT EXISTS commit_protocol STRING`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${leaseTable} (
      resource STRING NOT NULL,
      owner STRING NOT NULL,
      fencing_token INT64 NOT NULL,
      expires_at_ms INT64 NOT NULL
    )
  `);
}

export class BigQueryTarget {
  constructor({ targetRef, credentialBroker, mockClient = null, requireFencing = false, fenceResource = null, fenceOwner = null } = {}) {
    this.targetRef = normalizeBigQueryRef(targetRef);
    this.credentialBroker = credentialBroker;
    this.mockClient = mockClient;
    this.requireFencing = requireFencing;
    this.fenceResource = fenceResource;
    this.fenceOwner = fenceOwner;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('BIGQUERY_TARGET_CLOSED', 'BigQuery target is closed');
  }

  describeBatch(input = {}) {
    this.#assertOpen();
    return bigqueryPayloadEvidence(input.rows ?? []);
  }

  async reconcileTargetCommit(input = {}) {
    this.#assertOpen();
    const batchIdentity = input.batchIdentity;
    if (!batchIdentity) fail('INVALID_BATCH_EVIDENCE', 'batchIdentity is required for reconciliation');

    return await withBigQueryClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient }, async client => {
      await ensureBigQueryMetadata(client, this.targetRef.projectId);
      const metaTable = `\`${this.targetRef.projectId}.${METADATA_DATASET}.${LEDGER_TABLE}\``;

      const res = await client.query(`
        SELECT batch_identity, migration_id, plan_id, row_count, payload_hash, commit_protocol, committed_at
        FROM ${metaTable}
        WHERE batch_identity = ?
        LIMIT 1
      `, [batchIdentity]);

      const row = res.rows?.[0];
      if (!row) {
        return Object.freeze({ status: 'NOT_COMMITTED', batchIdentity });
      }

      if (row.commit_protocol !== ATOMIC_PROTOCOL) {
        return Object.freeze({ status: 'INDETERMINATE', batchIdentity, reason: 'LEGACY_OR_UNPROVEN_LEDGER_PROTOCOL' });
      }
      if ((input.payloadHash && input.payloadHash !== row.payload_hash) ||
          (input.rowCount !== undefined && Number(input.rowCount) !== Number(row.row_count)) ||
          (input.migrationId && input.migrationId !== row.migration_id) ||
          (input.planId && input.planId !== row.plan_id)) {
        return Object.freeze({ status: 'CONFLICT', batchIdentity });
      }

      return Object.freeze({
        status: 'COMMITTED_EXACT',
        batchIdentity,
        rowCount: Number(row.row_count),
        payloadHash: row.payload_hash,
        committedAt: new Date(row.committed_at).toISOString()
      });
    });
  }


  async commitBatch(input = {}) {
    this.#assertOpen();
    const { batchIdentity, migrationId, planId, rows = [], fencingToken = 1 } = input;
    if (typeof batchIdentity !== 'string' || !batchIdentity || !Array.isArray(rows)) {
      fail('INVALID_BATCH_INPUT', 'batchIdentity and an array of rows are required');
    }
    if (rows.length && (!migrationId || !planId)) fail('INVALID_BATCH_INPUT', 'Non-empty batches require migrationId and planId');
    const effectiveMigrationId = migrationId || 'unknown';
    const effectivePlanId = planId || 'unknown';
    if (rows.length > 500) fail('BIGQUERY_BATCH_TOO_LARGE', 'Atomic BigQuery batches are limited to 500 rows');
    const evidence = this.describeBatch({ rows });
    const columns = rows.length ? Object.keys(rows[0]) : [];
    if (rows.length && columns.length === 0) fail('INVALID_BATCH_ROWS', 'Rows need columns');
    const safeColumns = columns.map(safeColumnName);
    const values = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          Object.keys(row).length !== columns.length || columns.some(col => !Object.hasOwn(row, col))) {
        fail('INVALID_BATCH_ROWS', 'All rows must have the same column keys');
      }
      for (const col of columns) {
        const v = row[col];
        if (v === null || !['string', 'number', 'boolean'].includes(typeof v) ||
            (typeof v === 'number' && !Number.isFinite(v))) {
          fail('BIGQUERY_UNSUPPORTED_VALUE', 'Only non-null finite scalar values are supported by this transactional connector');
        }
        values.push(v);
      }
    }
    if (this.requireFencing && (!this.fenceResource || !Number.isSafeInteger(fencingToken))) {
      fail('INVALID_FENCE', 'A resource and integer fencing token are required');
    }

    return await withBigQueryClient({
      targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient
    }, async client => {
      await ensureBigQueryMetadata(client, this.targetRef.projectId);
      const targetTable = escapeBigQueryTable(this.targetRef);
      const metaTable = `\`${this.targetRef.projectId}.${METADATA_DATASET}.${LEDGER_TABLE}\``;
      const leaseTable = `\`${this.targetRef.projectId}.${METADATA_DATASET}.${LEASE_TABLE}\``;
      const params = [
        batchIdentity,
        batchIdentity, evidence.payloadHash, evidence.rowCount, effectiveMigrationId, effectivePlanId
      ];
      let fenceClause = '';
      if (this.requireFencing) {
        fenceClause = `
        IF (SELECT COUNT(*) FROM ${leaseTable}
            WHERE resource = ? AND fencing_token = ?
              AND expires_at_ms > UNIX_MILLIS(CURRENT_TIMESTAMP())${this.fenceOwner ? ' AND owner = ?' : ''}) != 1 THEN
          RAISE USING MESSAGE = 'STALE_FENCE';
        END IF;`;
        params.push(this.fenceResource, fencingToken);
        if (this.fenceOwner) params.push(this.fenceOwner);
      }
      let rowsSql = '';
      if (rows.length) {
        const placeholders = rows.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', ');
        rowsSql = `INSERT INTO ${targetTable} (${safeColumns.join(', ')}) VALUES ${placeholders};`;
        params.push(...values);
      }
      params.push(batchIdentity, effectiveMigrationId, effectivePlanId, evidence.rowCount, evidence.payloadHash, fencingToken);
      // One BigQuery query job, NOT separate autocommit INSERT statements.
      // DELETE WHERE FALSE forces transactional table-level conflict detection
      // for concurrent insert-only transactions (per BigQuery documentation).
      const sql = `/* SPOOL_BIGQUERY_ATOMIC_V2 */
BEGIN
  DECLARE seen INT64 DEFAULT 0;
  BEGIN TRANSACTION;
  DELETE FROM ${metaTable} WHERE FALSE;
  SET seen = (SELECT COUNT(*) FROM ${metaTable} WHERE batch_identity = ?);
  IF seen > 1 THEN
    RAISE USING MESSAGE = 'SPOOL_LEDGER_DUPLICATE';
  END IF;
  IF seen = 1 THEN
    IF (SELECT COUNT(*) FROM ${metaTable}
        WHERE batch_identity = ? AND payload_hash = ? AND row_count = ?
          AND migration_id = ? AND plan_id = ? AND commit_protocol = 'SPOOL_ATOMIC_V2') != 1 THEN
      RAISE USING MESSAGE = 'SPOOL_LEDGER_CONFLICT';
    END IF;
  ELSE
    ${fenceClause}
    ${rowsSql}
    INSERT INTO ${metaTable}
      (batch_identity, migration_id, plan_id, row_count, payload_hash,
       fencing_token, committed_at, commit_protocol)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(), 'SPOOL_ATOMIC_V2');
  END IF;
  COMMIT TRANSACTION;
EXCEPTION WHEN ERROR THEN
  ROLLBACK TRANSACTION;
  RAISE;
END;`;
      if (sql.length > 450000) fail('BIGQUERY_BATCH_TOO_LARGE', 'Atomic SQL script exceeds safe query length');
      // An ambiguous transport failure must propagate; never retry individual rows.
      await client.query(sql, params);
      const recovered = await this.reconcileTargetCommit({
        batchIdentity, migrationId: effectiveMigrationId, planId: effectivePlanId, rowCount: evidence.rowCount, payloadHash: evidence.payloadHash
      });
      if (recovered.status !== 'COMMITTED_EXACT') {
        fail('TARGET_COMMIT_UNPROVEN', 'BigQuery transaction did not produce matching atomic commit evidence', {
          batchIdentity, status: recovered.status
        });
      }
      return Object.freeze({
        status: 'COMMITTED_EXACT',
        batchIdentity, writtenRows: recovered.rowCount, rowCount: recovered.rowCount,
        payloadHash: recovered.payloadHash
      });
    });
  }

  async truncateTarget() {
    this.#assertOpen();
    return await withBigQueryClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient }, async client => {
      const targetTable = escapeBigQueryTable(this.targetRef);
      await client.query(`TRUNCATE TABLE ${targetTable}`);
      return Object.freeze({ status: 'TRUNCATED' });
    });
  }

  close() {
    this.closed = true;
  }
}
