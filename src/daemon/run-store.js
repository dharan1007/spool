import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { canonicalJson } from '../platform/canonical-json.js';

function text(value, label = 'value') {
  if (typeof value !== 'string' || !value) fail('INVALID_RUN_STORE_INPUT', `${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_RUN_STORE_INPUT', `${label} must be a non-negative safe integer`);
  return value;
}

function parse(json) { return json == null ? null : JSON.parse(json); }

export class RunStore {
  constructor({ path } = {}) {
    text(path, 'state path');
    this.path = resolve(path);
    this.db = new Database(this.path);
    this.closed = false;
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spool_runs (
        migration_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        plan_id TEXT,
        source_snapshot_id TEXT,
        target_identity_json TEXT,
        verification_json TEXT,
        receipt_json TEXT,
        started_at TEXT,
        completed_at TEXT,
        last_error_code TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spool_checkpoints (
        migration_id TEXT PRIMARY KEY NOT NULL,
        checkpoint_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spool_verification_batches (
        migration_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        source_start INTEGER NOT NULL,
        source_end_exclusive INTEGER NOT NULL,
        verification_json TEXT NOT NULL,
        repair_json TEXT,
        PRIMARY KEY (migration_id, ordinal)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS spool_verification_batches_migration_range
        ON spool_verification_batches(migration_id, source_start, source_end_exclusive);
    `);
  }
  #open() { if (this.closed) fail('RUN_STORE_CLOSED', 'Run store is closed'); }
  get(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    const row = this.db.prepare('SELECT * FROM spool_runs WHERE migration_id = ?').get(migrationId);
    if (!row) return null;
    return Object.freeze({
      migrationId: row.migration_id,
      status: row.status,
      planId: row.plan_id,
      sourceSnapshotId: row.source_snapshot_id,
      targetIdentity: parse(row.target_identity_json),
      verification: parse(row.verification_json),
      receipt: parse(row.receipt_json),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      lastErrorCode: row.last_error_code
    });
  }
  start({ migrationId, planId, sourceSnapshotId, targetIdentity, startedAt }) {
    this.#open();
    this.db.prepare(`
      INSERT INTO spool_runs (migration_id, status, plan_id, source_snapshot_id, target_identity_json, started_at)
      VALUES (?, 'RUNNING', ?, ?, ?, ?)
      ON CONFLICT(migration_id) DO UPDATE SET
        status='RUNNING', plan_id=excluded.plan_id, source_snapshot_id=excluded.source_snapshot_id,
        target_identity_json=excluded.target_identity_json, started_at=COALESCE(spool_runs.started_at, excluded.started_at),
        receipt_json=NULL, completed_at=NULL, last_error_code=NULL
    `).run(text(migrationId, 'migrationId'), text(planId, 'planId'), text(sourceSnapshotId, 'sourceSnapshotId'), canonicalJson(targetIdentity), text(startedAt, 'startedAt'));
  }
  complete({ migrationId, verification, receipt, completedAt }) {
    this.#open();
    this.db.prepare(`UPDATE spool_runs SET status='COMPLETE', verification_json=?, receipt_json=?, completed_at=?, last_error_code=NULL WHERE migration_id=?`)
      .run(canonicalJson(verification), canonicalJson(receipt), text(completedAt, 'completedAt'), text(migrationId, 'migrationId'));
  }
  verificationFailed({ migrationId, verification }) {
    this.#open();
    this.db.prepare(`UPDATE spool_runs SET status='VERIFICATION_FAILED', verification_json=?, receipt_json=NULL, completed_at=NULL, last_error_code='VERIFICATION_FAILED' WHERE migration_id=?`)
      .run(canonicalJson(verification), text(migrationId, 'migrationId'));
  }
  fail({ migrationId, errorCode }) {
    this.#open();
    this.db.prepare(`UPDATE spool_runs SET status='FAILED', last_error_code=? WHERE migration_id=?`)
      .run(text(errorCode, 'errorCode'), text(migrationId, 'migrationId'));
  }
  saveVerificationBatch({ migrationId, ordinal, sourceRange, verification, repair = null }) {
    this.#open();
    text(migrationId, 'migrationId');
    nonNegativeInteger(ordinal, 'ordinal');
    if (!sourceRange || typeof sourceRange !== 'object' || Array.isArray(sourceRange)) fail('INVALID_RUN_STORE_INPUT', 'sourceRange is required');
    const start = nonNegativeInteger(sourceRange.start, 'sourceRange.start');
    const endExclusive = nonNegativeInteger(sourceRange.endExclusive, 'sourceRange.endExclusive');
    if (endExclusive < start) fail('INVALID_RUN_STORE_INPUT', 'sourceRange.endExclusive must be >= sourceRange.start');
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) fail('INVALID_RUN_STORE_INPUT', 'verification is required');
    this.db.prepare(`
      INSERT INTO spool_verification_batches (
        migration_id, ordinal, source_start, source_end_exclusive, verification_json, repair_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(migration_id, ordinal) DO UPDATE SET
        source_start=excluded.source_start,
        source_end_exclusive=excluded.source_end_exclusive,
        verification_json=excluded.verification_json,
        repair_json=excluded.repair_json
    `).run(migrationId, ordinal, start, endExclusive, canonicalJson(verification), repair == null ? null : canonicalJson(repair));
  }
  verificationBatches(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    return this.db.prepare(`
      SELECT ordinal, source_start, source_end_exclusive, verification_json, repair_json
      FROM spool_verification_batches WHERE migration_id=? ORDER BY ordinal
    `).all(migrationId).map(row => Object.freeze({
      ordinal: Number(row.ordinal),
      sourceRange: Object.freeze({ start: Number(row.source_start), endExclusive: Number(row.source_end_exclusive) }),
      verification: parse(row.verification_json),
      repair: parse(row.repair_json)
    }));
  }
  clearVerificationBatches(migrationId) {
    this.#open();
    this.db.prepare('DELETE FROM spool_verification_batches WHERE migration_id=?').run(text(migrationId, 'migrationId'));
  }
  checkpointStore(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    return Object.freeze({
      load: () => {
        const row = this.db.prepare('SELECT checkpoint_json FROM spool_checkpoints WHERE migration_id = ?').get(migrationId);
        return row ? JSON.parse(row.checkpoint_json) : null;
      },
      save: checkpoint => {
        const json = canonicalJson(checkpoint);
        this.db.prepare(`INSERT INTO spool_checkpoints (migration_id, checkpoint_json) VALUES (?, ?) ON CONFLICT(migration_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json`)
          .run(migrationId, json);
      }
    });
  }
  clearCheckpoint(migrationId) {
    this.#open(); this.db.prepare('DELETE FROM spool_checkpoints WHERE migration_id=?').run(text(migrationId, 'migrationId'));
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
