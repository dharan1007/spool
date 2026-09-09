import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';

const LEDGER_TABLE = '__spool_batch_ledger';
const PAYLOAD_DOMAIN = 'spool-sqlite-batch-payload-v1';
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
  const text = requiredString('SQLite identifier', value);
  if (text.includes('\u0000')) fail('INVALID_SQLITE_IDENTIFIER', 'SQLite identifiers cannot contain NUL');
  return `"${text.replaceAll('"', '""')}"`;
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
      if (value !== null && !['string', 'number', 'bigint'].includes(typeof value) && !(value instanceof Uint8Array)) {
        fail('UNSUPPORTED_SQLITE_VALUE', `Unsupported SQLite value for ${key}`);
      }
      if (typeof value === 'number' && !Number.isFinite(value)) fail('UNSUPPORTED_SQLITE_VALUE', `Non-finite SQLite number for ${key}`);
    }
  }
  return columns;
}

function evidenceFrom(input, payloadHash, rowCount) {
  const mappingRevision = input.mappingRevision;
  if (!Number.isInteger(mappingRevision) || mappingRevision < 0) fail('INVALID_BATCH_EVIDENCE', 'mappingRevision must be a non-negative integer');
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

function ledgerMatches(row, evidence, targetTable) {
  return row
    && row.batch_identity === evidence.batchIdentity
    && row.migration_id === evidence.migrationId
    && row.plan_id === evidence.planId
    && row.source_snapshot_id === evidence.sourceSnapshotId
    && Number(row.mapping_revision) === evidence.mappingRevision
    && Number(row.row_count) === evidence.rowCount
    && row.payload_hash === evidence.payloadHash
    && row.target_table === targetTable;
}

export class SqliteTarget {
  constructor({ path, table, busyTimeoutMs = 5000 } = {}) {
    requiredString('path', path);
    requiredString('table', table);
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) fail('INVALID_SQLITE_CONFIG', 'busyTimeoutMs must be a non-negative integer');
    this.path = resolve(path);
    this.table = table;
    this.quotedTable = quoteIdentifier(table);
    this.db = new DatabaseSync(this.path);
    this.closed = false;
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(LEDGER_TABLE)} (
        batch_identity TEXT PRIMARY KEY NOT NULL,
        migration_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        source_snapshot_id TEXT NOT NULL,
        mapping_revision INTEGER NOT NULL,
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        payload_hash TEXT NOT NULL,
        target_table TEXT NOT NULL,
        committed_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  #assertOpen() {
    if (this.closed) fail('SQLITE_TARGET_CLOSED', 'SQLite target is closed');
  }

  #readLedger(batchIdentity) {
    return this.db.prepare(`
      SELECT batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
             row_count, payload_hash, target_table, committed_at
      FROM ${quoteIdentifier(LEDGER_TABLE)}
      WHERE batch_identity = ?
    `).get(batchIdentity);
  }

  commitBatch(input = {}) {
    this.#assertOpen();
    const rows = input.rows;
    const columns = validateRows(rows);
    const payloadHash = sha256Canonical(PAYLOAD_DOMAIN, rows);
    const evidence = evidenceFrom(input, payloadHash, rows.length);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.#readLedger(evidence.batchIdentity);
      if (existing) {
        if (!ledgerMatches(existing, evidence, this.table)) {
          fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', {
            batchIdentity: evidence.batchIdentity
          });
        }
        this.db.exec('COMMIT;');
        return Object.freeze({
          status: 'COMMITTED_EXACT',
          alreadyCommitted: true,
          batchIdentity: evidence.batchIdentity,
          rowCount: evidence.rowCount,
          payloadHash: evidence.payloadHash
        });
      }

      if (rows.length) {
        const quotedColumns = columns.map(quoteIdentifier);
        const placeholders = columns.map(() => '?').join(', ');
        const insert = this.db.prepare(`INSERT INTO ${this.quotedTable} (${quotedColumns.join(', ')}) VALUES (${placeholders})`);
        for (const row of rows) insert.run(...columns.map(column => row[column]));
      }

      this.db.prepare(`
        INSERT INTO ${quoteIdentifier(LEDGER_TABLE)}
          (batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision, row_count, payload_hash, target_table, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidence.batchIdentity,
        evidence.migrationId,
        evidence.planId,
        evidence.sourceSnapshotId,
        evidence.mappingRevision,
        evidence.rowCount,
        evidence.payloadHash,
        this.table,
        new Date().toISOString()
      );
      this.db.exec('COMMIT;');
      return Object.freeze({
        status: 'COMMITTED_EXACT',
        alreadyCommitted: false,
        batchIdentity: evidence.batchIdentity,
        rowCount: evidence.rowCount,
        payloadHash: evidence.payloadHash
      });
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  reconcileTargetCommit(input = {}) {
    this.#assertOpen();
    try {
      const evidence = evidenceFrom(input, input.payloadHash, input.rowCount);
      const existing = this.#readLedger(evidence.batchIdentity);
      if (!existing) return Object.freeze({ status: 'NOT_COMMITTED', batchIdentity: evidence.batchIdentity });
      if (!ledgerMatches(existing, evidence, this.table)) {
        return Object.freeze({ status: 'CONFLICT', batchIdentity: evidence.batchIdentity });
      }
      return Object.freeze({
        status: 'COMMITTED_EXACT',
        batchIdentity: evidence.batchIdentity,
        rowCount: evidence.rowCount,
        payloadHash: evidence.payloadHash,
        committedAt: existing.committed_at
      });
    } catch (error) {
      if (error?.code === 'INVALID_BATCH_EVIDENCE') throw error;
      return Object.freeze({ status: 'INDETERMINATE', batchIdentity: input?.batchIdentity ?? null });
    }
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
