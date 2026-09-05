import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from '../core/errors.js';
import { canonicalJson } from '../platform/canonical-json.js';
import {
  assertJobTransition,
  safeDurableClone,
  validateCheckpointContract,
  validateCounts,
  validateExecutionOwnership,
  validateJobRecord
} from '../platform/runtime-contracts.js';

const ACTIVE_RECOVERY_STATES = new Set(['RUNNING', 'PAUSING', 'VERIFYING', 'RECOVERING']);
const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED', 'ABORTED']);
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

function clone(value) {
  return structuredClone(value);
}

function parseJsonRecord(text, context) {
  try {
    return JSON.parse(text);
  } catch {
    fail('CORRUPT_JOB_STORE', `Stored ${context} is not valid JSON`);
  }
}

function validateExpectedStateVersion(value) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_STATE_VERSION', 'expectedStateVersion must be a non-negative safe integer');
  }
}

function validateOwner(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200) {
    fail('INVALID_EXECUTION_OWNER', 'ownerId must be a non-empty string of at most 200 characters');
  }
}

function validateLeaseMs(leaseMs) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    fail('INVALID_EXECUTION_LEASE', `leaseMs must be an integer between 1 and ${MAX_LEASE_MS}`);
  }
}

function sameCounts(a, b) {
  return a?.processedRows === b?.processedRows
    && a?.acceptedRows === b?.acceptedRows
    && a?.rejectedRows === b?.rejectedRows;
}

function requireString(value, code, label) {
  if (typeof value !== 'string' || !value) fail(code, `${label} is required`);
}

function validateCursor(value, label) {
  if (value == null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_PENDING_BATCH', `${label} must be an object or null`);
  }
  safeDurableClone(value, `pending batch ${label}`);
}

function validatePendingBatch(pendingBatch, job) {
  const durable = safeDurableClone(pendingBatch, 'pending batch');
  if (!durable || typeof durable !== 'object' || Array.isArray(durable)) {
    fail('INVALID_PENDING_BATCH', 'Pending batch must be an object');
  }
  if (durable.schemaVersion !== 1) fail('INVALID_PENDING_BATCH', 'Pending batch schemaVersion must be 1');
  if (durable.planId !== job.planId || durable.planRevision !== job.planRevision) {
    fail('PENDING_BATCH_PLAN_MISMATCH', 'Pending batch plan identity does not match the job');
  }
  requireString(durable.batchIdentity, 'INVALID_PENDING_BATCH', 'batchIdentity');
  requireString(durable.sourceIdentity, 'INVALID_PENDING_BATCH', 'sourceIdentity');
  requireString(durable.payloadHash, 'INVALID_PENDING_BATCH', 'payloadHash');
  validateCursor(durable.previousSourceCursor, 'previousSourceCursor');
  validateCursor(durable.sourceCursor, 'sourceCursor');
  if (!durable.targetRef || typeof durable.targetRef !== 'object' || Array.isArray(durable.targetRef)) {
    fail('INVALID_PENDING_BATCH', 'targetRef is required');
  }
  const targetKeys = Object.keys(durable.targetRef);
  if (targetKeys.some(key => !['connector', 'resource'].includes(key))) {
    fail('INVALID_PENDING_BATCH', 'Pending batch targetRef may contain only connector and resource');
  }
  requireString(durable.targetRef.connector, 'INVALID_PENDING_BATCH', 'target connector');
  requireString(durable.targetRef.resource, 'INVALID_PENDING_BATCH', 'target resource');
  validateCounts(durable.counts);
  return durable;
}

function receiptMatchesJob(receipt, job) {
  if (receipt.jobId !== job.jobId) fail('RECEIPT_JOB_MISMATCH', 'Receipt job identity does not match the job');
  if (receipt.planId !== job.planId || receipt.planRevision !== job.planRevision) {
    fail('RECEIPT_PLAN_MISMATCH', 'Receipt plan identity does not match the job');
  }
  if (receipt.terminalStatus !== 'COMPLETE') fail('INVALID_RECEIPT_STATE', 'Verified finalization requires a COMPLETE receipt');
  if (!sameCounts(receipt.counts, job.counts)) fail('RECEIPT_COUNTS_MISMATCH', 'Receipt counts do not match durable job counts');
  const verificationPassed = job.verification?.status === 'PASS' || job.verification?.ok === true;
  if (!verificationPassed) fail('VERIFICATION_REQUIRED', 'Verified finalization requires successful job verification');
  if (canonicalJson(receipt.verification ?? null) !== canonicalJson(job.verification ?? null)) {
    fail('RECEIPT_VERIFICATION_MISMATCH', 'Receipt verification evidence does not match the job');
  }
}

export class SQLiteJobStore {
  constructor({ stateDir, dbPath } = {}) {
    if (typeof stateDir !== 'string' || !stateDir) fail('INVALID_STATE_DIR', 'stateDir is required');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.stateDir = stateDir;
    this.dbPath = dbPath ?? join(stateDir, 'spool-state.sqlite3');
    this.db = new DatabaseSync(this.dbPath);
    this.configure();
    this.migrate();
  }

  configure() {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  migrate() {
    const row = this.db.prepare('PRAGMA user_version').get();
    const version = Number(row?.user_version ?? 0);
    if (version > 1) fail('UNSUPPORTED_JOB_STORE_SCHEMA', `Unsupported SQLite JobStore schema version ${version}`);
    if (version === 1) return;

    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          state TEXT NOT NULL,
          state_version INTEGER NOT NULL,
          execution_epoch INTEGER NOT NULL,
          execution_owner TEXT,
          execution_lease_expires_at TEXT,
          record_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX jobs_state_idx ON jobs(state);
        CREATE INDEX jobs_updated_idx ON jobs(updated_at DESC);
        CREATE TABLE receipts (
          receipt_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX receipts_job_idx ON receipts(job_id);
        CREATE TABLE recovery_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          event_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT
        );
        CREATE INDEX recovery_events_job_idx ON recovery_events(job_id, sequence);
        PRAGMA user_version = 1;
      `);
    });
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  rowToJob(row) {
    if (!row) return null;
    const job = parseJsonRecord(row.record_json, 'job record');
    if (
      job.jobId !== row.job_id
      || job.planId !== row.plan_id
      || job.planRevision !== row.plan_revision
      || job.state !== row.state
      || job.stateVersion !== row.state_version
      || job.executionEpoch !== row.execution_epoch
      || (job.executionOwner ?? null) !== (row.execution_owner ?? null)
      || (job.executionLeaseExpiresAt ?? null) !== (row.execution_lease_expires_at ?? null)
    ) {
      fail('CORRUPT_JOB_STORE', `SQLite columns and job payload disagree for ${row.job_id}`);
    }
    if (job.pendingBatch === undefined) job.pendingBatch = null;
    if (job.pendingBatch != null) validatePendingBatch(job.pendingBatch, job);
    validateJobRecord(job);
    return job;
  }

  loadLocked(jobId) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
    if (!row) fail('JOB_NOT_FOUND', `Job ${jobId} was not found`);
    return this.rowToJob(row);
  }

  writeJobLocked(previous, next) {
    const durable = safeDurableClone(next, 'sqlite job record');
    const result = this.db.prepare(`
      UPDATE jobs
      SET state = ?, state_version = ?, execution_epoch = ?, execution_owner = ?,
          execution_lease_expires_at = ?, record_json = ?, updated_at = ?
      WHERE job_id = ? AND state_version = ? AND execution_epoch = ?
    `).run(
      durable.state,
      durable.stateVersion,
      durable.executionEpoch,
      durable.executionOwner ?? null,
      durable.executionLeaseExpiresAt ?? null,
      JSON.stringify(durable),
      durable.updatedAt,
      durable.jobId,
      previous.stateVersion,
      previous.executionEpoch
    );
    if (Number(result.changes) !== 1) fail('STALE_STATE_VERSION', `Job ${durable.jobId} changed before the mutation committed`);
    return durable;
  }

  mutateLocked(jobId, updater, { expectedStateVersion, expectedExecutionEpoch } = {}) {
    if (typeof updater !== 'function') fail('INVALID_JOB_UPDATER', 'Job updater must be a function');
    validateExpectedStateVersion(expectedStateVersion);
    const previous = this.loadLocked(jobId);
    if (expectedStateVersion !== undefined && previous.stateVersion !== expectedStateVersion) {
      fail('STALE_STATE_VERSION', `Job ${jobId} state version has advanced`);
    }
    if (expectedExecutionEpoch !== undefined) validateExecutionOwnership(previous, expectedExecutionEpoch);
    const candidate = updater(clone(previous));
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('INVALID_JOB_RECORD', 'Job updater must return a job record');
    }
    const next = clone(candidate);
    next.stateVersion = previous.stateVersion + 1;
    next.updatedAt = new Date().toISOString();
    if (previous.state === 'PLANNED' && next.state === 'RUNNING' && !next.startedAt) next.startedAt = next.updatedAt;
    if (TERMINAL_STATES.has(next.state) && !next.completedAt) next.completedAt = next.updatedAt;
    if (next.pendingBatch != null) validatePendingBatch(next.pendingBatch, next);
    assertJobTransition(previous, next);
    return this.writeJobLocked(previous, next);
  }

  async create(plan) {
    if (!plan?.planId || !Number.isSafeInteger(plan.planRevision) || plan.planRevision < 1) {
      fail('INVALID_PLAN', 'Job creation requires planId and planRevision');
    }
    const now = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      jobId: `job_${randomUUID()}`,
      planId: plan.planId,
      planRevision: plan.planRevision,
      state: 'PLANNED',
      stateVersion: 0,
      executionEpoch: 0,
      executionOwner: null,
      executionLeaseExpiresAt: null,
      counts: { processedRows: 0, acceptedRows: 0, rejectedRows: 0 },
      checkpoint: null,
      pendingBatch: null,
      verification: null,
      receiptId: null,
      lastError: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now
    };
    validateJobRecord(job);
    const durable = safeDurableClone(job, 'sqlite job record');
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO jobs (
          job_id, plan_id, plan_revision, state, state_version, execution_epoch,
          execution_owner, execution_lease_expires_at, record_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        durable.jobId, durable.planId, durable.planRevision, durable.state, durable.stateVersion,
        durable.executionEpoch, null, null, JSON.stringify(durable), durable.createdAt, durable.updatedAt
      );
    });
    return clone(durable);
  }

  async load(jobId) {
    return clone(this.loadLocked(jobId));
  }

  async list() {
    return this.db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, job_id ASC').all().map(row => clone(this.rowToJob(row)));
  }

  async update(jobId, updater, options = {}) {
    return clone(this.transaction(() => this.mutateLocked(jobId, updater, options)));
  }

  async acquireExecution(jobId, { expectedStateVersion, ownerId, leaseMs = 30_000 } = {}) {
    validateExpectedStateVersion(expectedStateVersion);
    validateOwner(ownerId);
    validateLeaseMs(leaseMs);
    return clone(this.transaction(() => {
      const previous = this.loadLocked(jobId);
      if (expectedStateVersion !== undefined && previous.stateVersion !== expectedStateVersion) {
        fail('STALE_STATE_VERSION', `Job ${jobId} state version has advanced`);
      }
      if (TERMINAL_STATES.has(previous.state)) fail('TERMINAL_JOB', `Cannot acquire execution ownership for terminal job ${jobId}`);
      const nowMs = Date.now();
      const leaseExpiryMs = previous.executionLeaseExpiresAt ? Date.parse(previous.executionLeaseExpiresAt) : 0;
      if (previous.executionOwner && previous.executionOwner !== ownerId && Number.isFinite(leaseExpiryMs) && leaseExpiryMs > nowMs) {
        fail('EXECUTION_LEASE_HELD', `Job ${jobId} already has an active execution lease`);
      }
      let nextState = previous.state;
      const expiredForeignLease = previous.executionOwner && previous.executionOwner !== ownerId && leaseExpiryMs <= nowMs;
      if (expiredForeignLease && ACTIVE_RECOVERY_STATES.has(previous.state)) nextState = 'RECOVERING';
      if (previous.state === 'RECOVERY_REQUIRED') nextState = 'RECOVERING';
      const next = {
        ...previous,
        state: nextState,
        stateVersion: previous.stateVersion + 1,
        executionEpoch: previous.executionEpoch + 1,
        executionOwner: ownerId,
        executionLeaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
        updatedAt: new Date().toISOString()
      };
      assertJobTransition(previous, next);
      return this.writeJobLocked(previous, next);
    }));
  }

  async renewExecution(jobId, { expectedStateVersion, expectedExecutionEpoch, ownerId, leaseMs = 30_000 } = {}) {
    validateExpectedStateVersion(expectedStateVersion);
    validateOwner(ownerId);
    validateLeaseMs(leaseMs);
    return clone(this.transaction(() => {
      const previous = this.loadLocked(jobId);
      if (expectedStateVersion !== undefined && previous.stateVersion !== expectedStateVersion) {
        fail('STALE_STATE_VERSION', `Job ${jobId} state version has advanced`);
      }
      if (expectedExecutionEpoch === undefined) fail('INVALID_EXECUTION_EPOCH', 'expectedExecutionEpoch is required to renew execution ownership');
      validateExecutionOwnership(previous, expectedExecutionEpoch);
      if (previous.executionOwner !== ownerId) fail('STALE_EXECUTION_OWNER', `Execution owner ${ownerId} no longer owns job ${jobId}`);
      if (TERMINAL_STATES.has(previous.state) || previous.state === 'RECOVERY_REQUIRED') {
        fail('INVALID_EXECUTION_LEASE', `Execution lease cannot be renewed while job ${jobId} is ${previous.state}`);
      }
      const nowMs = Date.now();
      const leaseExpiryMs = previous.executionLeaseExpiresAt ? Date.parse(previous.executionLeaseExpiresAt) : Number.NaN;
      if (!Number.isFinite(leaseExpiryMs) || leaseExpiryMs <= nowMs) fail('EXECUTION_LEASE_EXPIRED', `Execution lease for job ${jobId} has expired`);
      const next = {
        ...previous,
        stateVersion: previous.stateVersion + 1,
        executionLeaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
        updatedAt: new Date().toISOString()
      };
      assertJobTransition(previous, next);
      return this.writeJobLocked(previous, next);
    }));
  }

  async releaseExecution(jobId, { expectedStateVersion, expectedExecutionEpoch } = {}) {
    return clone(this.transaction(() => this.mutateLocked(
      jobId,
      current => ({ ...current, executionOwner: null, executionLeaseExpiresAt: null }),
      { expectedStateVersion, expectedExecutionEpoch }
    )));
  }

  async beginPendingBatch(jobId, pendingBatch, { expectedStateVersion, expectedExecutionEpoch } = {}) {
    return clone(this.transaction(() => {
      const previous = this.loadLocked(jobId);
      const durable = validatePendingBatch(pendingBatch, previous);
      if (previous.state !== 'RUNNING') fail('INVALID_PENDING_BATCH_STATE', `Cannot begin a target batch while job ${jobId} is ${previous.state}`);
      if (previous.pendingBatch != null) fail('PENDING_BATCH_EXISTS', `Job ${jobId} already has a pending target batch`);
      return this.mutateLocked(
        jobId,
        current => ({ ...current, pendingBatch: durable }),
        { expectedStateVersion, expectedExecutionEpoch }
      );
    }));
  }

  async clearPendingBatch(jobId, { expectedStateVersion, expectedExecutionEpoch } = {}) {
    return clone(this.transaction(() => this.mutateLocked(
      jobId,
      current => ({ ...current, pendingBatch: null }),
      { expectedStateVersion, expectedExecutionEpoch }
    )));
  }

  async commitCheckpoint(jobId, checkpoint, { expectedStateVersion, expectedExecutionEpoch } = {}) {
    return clone(this.transaction(() => {
      const previous = this.loadLocked(jobId);
      if (previous.state === 'RECOVERY_REQUIRED') {
        fail('RECOVERY_REQUIRED', `Job ${jobId} requires reconciliation before checkpoint writes can continue`);
      }
      return this.mutateLocked(
        jobId,
        current => {
          const next = {
            ...current,
            checkpoint: safeDurableClone(checkpoint, 'checkpoint'),
            pendingBatch: null,
            counts: {
              processedRows: checkpoint?.processedRows,
              acceptedRows: checkpoint?.acceptedRows,
              rejectedRows: checkpoint?.rejectedRows
            }
          };
          validateCheckpointContract(next.checkpoint, next);
          return next;
        },
        { expectedStateVersion, expectedExecutionEpoch }
      );
    }));
  }

  appendRecoveryEventLocked(jobId, event) {
    const durable = safeDurableClone(event, 'recovery event');
    if (!durable || typeof durable !== 'object' || Array.isArray(durable)) fail('INVALID_RECOVERY_EVENT', 'Recovery event must be an object');
    if (durable.jobId !== jobId) fail('RECOVERY_EVENT_JOB_MISMATCH', 'Recovery event jobId does not match the target job');
    if (typeof durable.kind !== 'string' || !durable.kind) fail('INVALID_RECOVERY_EVENT', 'Recovery event kind is required');
    const createdAt = durable.createdAt ?? new Date().toISOString();
    const normalized = { ...durable, createdAt };
    this.db.prepare('INSERT INTO recovery_events (job_id, kind, event_json, created_at) VALUES (?, ?, ?, ?)')
      .run(jobId, normalized.kind, JSON.stringify(normalized), createdAt);
    return normalized;
  }

  async appendRecoveryEvent(jobId, event) {
    return clone(this.transaction(() => {
      this.loadLocked(jobId);
      return this.appendRecoveryEventLocked(jobId, { ...event, jobId });
    }));
  }

  async listRecoveryEvents(jobId) {
    this.loadLocked(jobId);
    return this.db.prepare('SELECT event_json FROM recovery_events WHERE job_id = ? ORDER BY sequence ASC')
      .all(jobId)
      .map(row => parseJsonRecord(row.event_json, 'recovery event'));
  }

  async recoverInterruptedJobs() {
    return clone(this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM jobs
        WHERE state IN ('RUNNING', 'PAUSING', 'VERIFYING', 'RECOVERING')
        ORDER BY updated_at ASC, job_id ASC
      `).all();
      const changed = [];
      for (const row of rows) {
        const previous = this.rowToJob(row);
        const now = new Date().toISOString();
        const next = {
          ...previous,
          state: 'RECOVERY_REQUIRED',
          stateVersion: previous.stateVersion + 1,
          executionOwner: null,
          executionLeaseExpiresAt: null,
          updatedAt: now
        };
        assertJobTransition(previous, next);
        this.writeJobLocked(previous, next);
        this.appendRecoveryEventLocked(previous.jobId, {
          schemaVersion: 1,
          jobId: previous.jobId,
          kind: 'startup_orphaned_execution',
          fromState: previous.state,
          executionEpoch: previous.executionEpoch,
          stateVersion: next.stateVersion,
          createdAt: now
        });
        changed.push(next);
      }
      return changed;
    }));
  }

  saveReceiptLocked(receipt) {
    if (!receipt?.receiptId || typeof receipt.receiptId !== 'string') fail('INVALID_RECEIPT', 'receiptId is required');
    const durable = safeDurableClone(receipt, 'receipt');
    const existing = this.db.prepare('SELECT receipt_json FROM receipts WHERE receipt_id = ?').get(durable.receiptId);
    if (existing) {
      const parsed = parseJsonRecord(existing.receipt_json, 'receipt');
      if (canonicalJson(parsed) !== canonicalJson(durable)) fail('RECEIPT_IMMUTABLE', `Receipt ${durable.receiptId} is immutable`);
      return parsed;
    }
    this.db.prepare(`
      INSERT INTO receipts (receipt_id, job_id, plan_id, plan_revision, receipt_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      durable.receiptId, durable.jobId, durable.planId, durable.planRevision,
      JSON.stringify(durable), durable.timing?.completedAt ?? new Date().toISOString()
    );
    return durable;
  }

  async saveReceipt(receipt) {
    return clone(this.transaction(() => this.saveReceiptLocked(receipt)));
  }

  async loadReceipt(receiptId) {
    const row = this.db.prepare('SELECT receipt_json FROM receipts WHERE receipt_id = ?').get(receiptId);
    if (!row) fail('RECEIPT_NOT_FOUND', `Receipt ${receiptId} was not found`);
    return parseJsonRecord(row.receipt_json, 'receipt');
  }

  async finalizeVerifiedJob(jobId, receipt, { expectedStateVersion, expectedExecutionEpoch } = {}) {
    return clone(this.transaction(() => {
      const previous = this.loadLocked(jobId);
      if (previous.state === 'COMPLETE') {
        if (previous.receiptId !== receipt?.receiptId) fail('RECEIPT_IMMUTABLE', `Job ${jobId} is already finalized with another receipt`);
        const stored = this.saveReceiptLocked(receipt);
        if (canonicalJson(stored) !== canonicalJson(receipt)) fail('RECEIPT_IMMUTABLE', `Receipt ${receipt.receiptId} is immutable`);
        return previous;
      }
      validateExpectedStateVersion(expectedStateVersion);
      if (expectedStateVersion !== undefined && previous.stateVersion !== expectedStateVersion) {
        fail('STALE_STATE_VERSION', `Job ${jobId} state version has advanced`);
      }
      if (expectedExecutionEpoch !== undefined) validateExecutionOwnership(previous, expectedExecutionEpoch);
      if (previous.state !== 'VERIFYING') fail('INVALID_JOB_TRANSITION', `Cannot finalize job from ${previous.state}`);
      if (previous.pendingBatch != null) fail('PENDING_BATCH_EXISTS', 'Cannot finalize while a target batch is unresolved');
      receiptMatchesJob(receipt, previous);
      const storedReceipt = this.saveReceiptLocked(receipt);
      const completedAt = storedReceipt.timing?.completedAt ?? new Date().toISOString();
      const next = {
        ...previous,
        state: 'COMPLETE',
        stateVersion: previous.stateVersion + 1,
        receiptId: storedReceipt.receiptId,
        completedAt,
        executionOwner: null,
        executionLeaseExpiresAt: null,
        updatedAt: new Date().toISOString()
      };
      assertJobTransition(previous, next);
      this.writeJobLocked(previous, next);
      return next;
    }));
  }
}
