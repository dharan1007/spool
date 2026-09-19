import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';
import {
  MIGRATION_STATES,
  isAllowedTransition,
  assertAllowedTransition,
  assertTransitionPreconditions,
  buildTransitionRecord,
  createTransitionId,
  validateTransitionRecord,
  buildSnapshotCdcBinding,
  buildCutoverAttemptId,
  requireCutoverAttemptId
} from '../protocol/migration-state-machine.js';
import {
  verificationSemanticId,
  verificationStatus,
  assertVerificationIdentity
} from '../protocol/verification-coordinator.js';

function text(value, label = 'value') {
  if (typeof value !== 'string' || !value) fail('INVALID_RUN_STORE_INPUT', `${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_RUN_STORE_INPUT', `${label} must be a non-negative safe integer`);
  return value;
}

function parse(json) { return json == null ? null : JSON.parse(json); }

const STATE_CHECKSUM_DOMAIN = 'spool-migration-state-v1';
const BINDING_CHECKSUM_DOMAIN = 'spool-snapshot-cdc-binding-v1';

function computeStateChecksum(stateWithoutChecksum) {
  return sha256Canonical(STATE_CHECKSUM_DOMAIN, stateWithoutChecksum);
}

export class RunStore {
  constructor({ path } = {}) {
    text(path, 'state path');
    this.path = resolve(path);
    this.db = new Database(this.path);
    this.closed = false;
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
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
      const runColumns = new Set(this.db.prepare('PRAGMA table_info(spool_runs)').all().map(column => column.name));
      if (!runColumns.has('repair_json')) this.db.exec('ALTER TABLE spool_runs ADD COLUMN repair_json TEXT');
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS spool_repair_operations (
        migration_id TEXT NOT NULL,
        repair_plan_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        effect TEXT NOT NULL,
        applied INTEGER NOT NULL,
        observed_row_hash TEXT,
        written_row_hash TEXT,
        attempted_at TEXT NOT NULL,
        PRIMARY KEY (migration_id, repair_plan_id, key_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spool_cutovers (
        migration_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        receipt_kind TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        source_snapshot_id TEXT NOT NULL,
        target_identity_json TEXT NOT NULL,
        target_contract_id TEXT NOT NULL,
        commit_evidence_json TEXT,
        abort_reason TEXT,
        cutover_attempt_id TEXT,
        armed_at TEXT NOT NULL,
        decided_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spool_verifications (
        migration_id TEXT NOT NULL,
        verification_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (migration_id, verification_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS spool_verifications_migration_mode ON spool_verifications(migration_id, mode);
      CREATE TABLE IF NOT EXISTS spool_migration_state (
        migration_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        current_state TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        transition_id TEXT NOT NULL,
        plan_id TEXT,
        source_state_id TEXT,
        target_contract_id TEXT,
        fence_token INTEGER,
        updated_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spool_transitions (
        migration_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        transition_id TEXT NOT NULL,
        command_id TEXT,
        previous_transition_id TEXT,
        previous_state TEXT,
        next_state TEXT NOT NULL,
        principal TEXT NOT NULL,
        reason TEXT,
        plan_id TEXT,
        source_state_id TEXT,
        target_contract_id TEXT,
        fence_token INTEGER,
        evidence_json TEXT,
        timestamp TEXT NOT NULL,
        transition_json TEXT NOT NULL,
        PRIMARY KEY (migration_id, sequence),
        UNIQUE (transition_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS spool_transitions_migration_seq ON spool_transitions(migration_id, sequence);
      CREATE TABLE IF NOT EXISTS spool_snapshot_cdc_bindings (
        migration_id TEXT PRIMARY KEY NOT NULL,
        binding_json TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        source_state_id TEXT NOT NULL,
        database_snapshot_identity TEXT NOT NULL,
        exported_snapshot_id TEXT,
        snapshot_lsn TEXT NOT NULL,
        cdc_start_lsn TEXT NOT NULL,
        received_lsn TEXT,
        applied_lsn TEXT,
        acknowledged_lsn TEXT,
        cdc_slot TEXT,
        cdc_publication TEXT,
        catalog_id TEXT,
        updated_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT;
      `);
      // Schema evolution for databases created before these columns existed.
      // Fresh databases already have them via CREATE TABLE above; the guards
      // keep this idempotent for pre-existing state files.
      const transitionColumns = new Set(this.db.prepare('PRAGMA table_info(spool_transitions)').all().map(column => column.name));
      if (!transitionColumns.has('command_id')) this.db.exec('ALTER TABLE spool_transitions ADD COLUMN command_id TEXT');
      if (!transitionColumns.has('previous_transition_id')) this.db.exec('ALTER TABLE spool_transitions ADD COLUMN previous_transition_id TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS spool_transitions_migration_command ON spool_transitions(migration_id, command_id)');
      const cutoverColumns = new Set(this.db.prepare('PRAGMA table_info(spool_cutovers)').all().map(column => column.name));
      if (!cutoverColumns.has('cutover_attempt_id')) this.db.exec('ALTER TABLE spool_cutovers ADD COLUMN cutover_attempt_id TEXT');
    } catch (error) {
      try { this.db.close(); } catch { /* preserve the original error */ }
      throw error;
    }
  }
  #open() { if (this.closed) fail('RUN_STORE_CLOSED', 'Run store is closed'); }

  // ---------- Migration State Machine durable implementation ----------

  _validateStateChecksum(row) {
    const stateWithoutChecksum = {
      schemaVersion: 1,
      migrationId: row.migration_id,
      runId: row.run_id,
      currentState: row.current_state,
      sequence: Number(row.sequence),
      transitionId: row.transition_id,
      planId: row.plan_id,
      sourceStateId: row.source_state_id,
      targetContractId: row.target_contract_id,
      fenceToken: row.fence_token == null ? null : Number(row.fence_token),
      updatedAt: row.updated_at
    };
    const expected = computeStateChecksum(stateWithoutChecksum);
    if (expected !== row.checksum) {
      fail('RUN_STATE_CORRUPT', 'Migration state checksum mismatch — durable state is corrupt', {
        migrationId: row.migration_id,
        expected,
        actual: row.checksum
      });
    }
    return true;
  }

  _loadTransitions(migrationId) {
    const rows = this.db.prepare('SELECT * FROM spool_transitions WHERE migration_id = ? ORDER BY sequence ASC').all(migrationId);
    let lastState = null;
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      let record;
      try {
        record = JSON.parse(row.transition_json);
      } catch (cause) {
        fail('RUN_STATE_CORRUPT', 'Transition JSON is corrupt and cannot be parsed', { migrationId, sequence: row.sequence, cause: cause?.message });
      }
      // validate record transitionId — any validation failure is corruption
      try {
        validateTransitionRecord({ ...record, transitionId: row.transition_id });
      } catch (cause) {
        if (cause?.code === 'RUN_STATE_CORRUPT') throw cause;
        fail('RUN_STATE_CORRUPT', `Transition record is corrupt: ${cause?.code ?? cause?.message}`, { migrationId, sequence: row.sequence, cause: cause?.code });
      }
      if (Number(row.sequence) !== record.sequence) fail('RUN_STATE_CORRUPT', 'Transition sequence mismatch', { migrationId, sequence: row.sequence });
      if (idx === 0) {
        if (record.sequence !== 0) fail('RUN_STATE_CORRUPT', 'First transition sequence must be 0');
        if (record.previousState !== null) fail('RUN_STATE_CORRUPT', 'First transition previousState must be null');
      } else {
        if (rows[idx - 1].next_state !== record.previousState) fail('RUN_STATE_CORRUPT', 'Transition previousState does not match prior nextState');
        if (Number(row.sequence) !== Number(rows[idx - 1].sequence) + 1) fail('RUN_STATE_CORRUPT', 'Transition sequence gap detected');
      }
      lastState = record.nextState;
      // also check stored columns match record
      if (row.next_state !== record.nextState || row.previous_state !== record.previousState) {
        fail('RUN_STATE_CORRUPT', 'Transition row state columns disagree with canonical JSON');
      }
    }
    return rows.map(r => JSON.parse(r.transition_json)).map((record, idx) => Object.freeze({ ...record, transitionId: rows[idx].transition_id }));
  }

  initializeMigration(migrationId, { runId = null, principal = 'system', reason = 'initialize', planId = null, sourceStateId = null, targetContractId = null } = {}) {
    this.#open(); text(migrationId, 'migrationId');
    const existing = this.db.prepare('SELECT * FROM spool_migration_state WHERE migration_id = ?').get(migrationId);
    if (existing) {
      this._validateStateChecksum(existing);
      // if already initialized, return current state idempotently; validate runId epoch if supplied
      if (runId && existing.run_id !== runId) {
        fail('STALE_COORDINATOR_EPOCH', 'RunId epoch mismatch — stale coordinator', { migrationId, expectedRunId: existing.run_id, actualRunId: runId });
      }
      // verify transitions not corrupt
      this._loadTransitions(migrationId);
      return this.getMigrationState(migrationId);
    }
    const finalRunId = runId ?? randomUUID();
    const now = new Date().toISOString();
    const record = buildTransitionRecord({
      migrationId,
      runId: finalRunId,
      previousState: null,
      nextState: MIGRATION_STATES.CREATED,
      sequence: 0,
      principal,
      reason,
      timestamp: now,
      planId,
      sourceStateId,
      targetContractId,
      fenceToken: null,
      evidence: null
    });
    const transitionId = createTransitionId(record);
    const transitionJson = canonicalJson(record);
    const checksum = computeStateChecksum({
      schemaVersion: 1,
      migrationId,
      runId: finalRunId,
      currentState: MIGRATION_STATES.CREATED,
      sequence: 0,
      transitionId,
      planId,
      sourceStateId,
      targetContractId,
      fenceToken: null,
      updatedAt: now
    });
    const insertTx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO spool_transitions (migration_id, sequence, transition_id, previous_state, next_state, principal, reason, plan_id, source_state_id, target_contract_id, fence_token, evidence_json, timestamp, transition_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(migrationId, 0, transitionId, null, MIGRATION_STATES.CREATED, principal, reason, planId, sourceStateId, targetContractId, null, null, now, transitionJson);
      this.db.prepare(`
        INSERT INTO spool_migration_state (migration_id, run_id, current_state, sequence, transition_id, plan_id, source_state_id, target_contract_id, fence_token, updated_at, checksum)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(migrationId, finalRunId, MIGRATION_STATES.CREATED, 0, transitionId, planId, sourceStateId, targetContractId, null, now, checksum);
    });
    insertTx();
    return this.getMigrationState(migrationId);
  }

  getMigrationState(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    const row = this.db.prepare('SELECT * FROM spool_migration_state WHERE migration_id = ?').get(migrationId);
    if (!row) return null;
    this._validateStateChecksum(row);
    // also validate transition log chain; corruption fails closed
    const transitions = this.db.prepare('SELECT COUNT(*) as c FROM spool_transitions WHERE migration_id = ?').get(migrationId);
    if (Number(transitions.c) !== Number(row.sequence) + 1) {
      fail('RUN_STATE_CORRUPT', 'Migration state sequence does not match transition log length', { migrationId, stateSequence: row.sequence, transitionCount: transitions.c });
    }
    // validate last transition matches state
    const last = this.db.prepare('SELECT * FROM spool_transitions WHERE migration_id = ? ORDER BY sequence DESC LIMIT 1').get(migrationId);
    if (!last || last.transition_id !== row.transition_id || last.next_state !== row.current_state) {
      fail('RUN_STATE_CORRUPT', 'Migration state does not match last transition', { migrationId });
    }
    // full chain validation
    this._loadTransitions(migrationId);
    return Object.freeze({
      migrationId: row.migration_id,
      runId: row.run_id,
      currentState: row.current_state,
      sequence: Number(row.sequence),
      transitionId: row.transition_id,
      planId: row.plan_id,
      sourceStateId: row.source_state_id,
      targetContractId: row.target_contract_id,
      fenceToken: row.fence_token == null ? null : Number(row.fence_token),
      updatedAt: row.updated_at,
      checksum: row.checksum
    });
  }

  listTransitions(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    const rows = this.db.prepare('SELECT * FROM spool_transitions WHERE migration_id = ? ORDER BY sequence ASC').all(migrationId);
    // validate each
    for (const row of rows) {
      const rec = JSON.parse(row.transition_json);
      validateTransitionRecord({ ...rec, transitionId: row.transition_id });
    }
    // chain check
    this._loadTransitions(migrationId);
    return Object.freeze(rows.map(row => {
      const rec = JSON.parse(row.transition_json);
      return Object.freeze({ ...rec, transitionId: row.transition_id });
    }));
  }

  /**
   * Durable CAS transition. expectedSequence if provided must match current sequence.
   * expectedRunId if provided must match current runId (epoch fencing).
   *
   * Idempotency: every transition carries a stable command identity
   * (transitionCommandId) derived from migrationId + runId + expected sequence +
   * from/to + semantic evidence identity + caller idempotency key. Wall-clock
   * timestamps and fresh fence tokens are execution metadata and are excluded,
   * so retrying the same logical command after a crash (e.g. commit observed
   * lost) recognizes the already-committed transition instead of conflicting:
   * - same command id -> return the STORED transition (idempotent success)
   * - same sequence, different command id -> TRANSITION_CONFLICT
   * - stale expectedSequence -> STALE_TRANSITION_VERSION
   */
  transition(migrationId, { expectedSequence = null, expectedRunId = null, runId = null, previousState = undefined, nextState, principal, reason = '', planId = null, sourceStateId = null, targetContractId = null, fenceToken = null, evidence = null, context = {}, commandId = null, semanticEvidenceId = null, idempotencyKey = null } = {}) {
    this.#open(); text(migrationId, 'migrationId');
    if (!nextState) fail('INVALID_TRANSITION_INPUT', 'nextState is required');
    if (commandId != null && (typeof commandId !== 'string' || !commandId)) fail('INVALID_TRANSITION_INPUT', 'commandId must be a non-empty string');
    const now = new Date().toISOString();
    const principalText = typeof principal === 'string' && principal.trim() ? principal.trim() : fail('INVALID_PRINCIPAL', 'principal is required');

    const tx = this.db.transaction(() => {
      const stateRow = this.db.prepare('SELECT * FROM spool_migration_state WHERE migration_id = ?').get(migrationId);
      let currentState = null;
      let currentSequence = -1;
      let storedRunId = null;
      if (stateRow) {
        this._validateStateChecksum(stateRow);
        currentState = stateRow.current_state;
        currentSequence = Number(stateRow.sequence);
        storedRunId = stateRow.run_id;
        // Explicit command identity is recognized BEFORE sequence/version
        // checks: a retry issued after a crash (stale sequence, fresh fence)
        // must resolve to the already-committed transition, not fail stale.
        // Same identity + different target transition or different semantic
        // evidence fails closed as a conflict instead of replaying.
        if (commandId != null) {
          const priorCommand = this.db.prepare('SELECT * FROM spool_transitions WHERE migration_id = ? AND command_id = ?').get(migrationId, commandId);
          if (priorCommand) {
            if (priorCommand.next_state !== nextState) {
              fail('TRANSITION_CONFLICT', 'Command identity already committed a different transition', {
                migrationId, commandId,
                committedTransition: priorCommand.next_state, requestedTransition: nextState
              });
            }
            if (priorCommand.evidence_json !== (evidence ? canonicalJson(evidence) : null)) {
              fail('TRANSITION_CONFLICT', 'Command identity already committed with different evidence', {
                migrationId, commandId, existingTransitionId: priorCommand.transition_id
              });
            }
            const priorRecord = JSON.parse(priorCommand.transition_json);
            if (priorRecord.principal !== principalText) {
              fail('TRANSITION_CONFLICT', 'Command identity already committed by a different principal', {
                migrationId, commandId, existingPrincipal: priorRecord.principal
              });
            }
            const stored = JSON.parse(priorCommand.transition_json);
            return { transition: Object.freeze({ ...stored, transitionId: priorCommand.transition_id, commandId: priorCommand.command_id }), idempotent: true };
          }
        }
        // epoch fencing
        const effectiveRunId = runId ?? storedRunId;
        if (expectedRunId && expectedRunId !== storedRunId) fail('STALE_COORDINATOR_EPOCH', 'Stale coordinator epoch — runId mismatch', { migrationId, expectedRunId, actualRunId: storedRunId });
        if (runId && runId !== storedRunId) fail('STALE_COORDINATOR_EPOCH', 'Stale coordinator epoch — runId mismatch', { migrationId, expectedRunId: storedRunId, actualRunId: runId });
        if (expectedSequence != null && Number(expectedSequence) !== currentSequence) {
          fail('STALE_TRANSITION_VERSION', 'Transition expectedSequence does not match durable current sequence', { migrationId, expectedSequence, actualSequence: currentSequence });
        }
        const from = previousState !== undefined ? previousState : currentState;
        if (from !== currentState) fail('ILLEGAL_STATE_TRANSITION', `CAS previousState ${String(from)} does not match durable currentState ${String(currentState)}`);
        // Compute effective coalesced values for state consistency
        const effectivePlanId = planId ?? stateRow.plan_id ?? null;
        const effectiveSourceStateId = sourceStateId ?? stateRow.source_state_id ?? null;
        const effectiveTargetContractId = targetContractId ?? stateRow.target_contract_id ?? null;
        const effectiveFenceToken = fenceToken ?? (stateRow.fence_token == null ? null : Number(stateRow.fence_token));
        // Stable command identity for idempotent retry recognition. Volatile
        // execution metadata (timestamps, fresh fence tokens) is excluded on
        // purpose: a retried command carries a new fence but the same semantics.
        const nextSequence = currentSequence + 1;
        const effectiveCommandId = commandId ?? sha256Canonical('spool-transition-command-v1', {
          migrationId,
          runId: storedRunId,
          sequence: nextSequence,
          from: currentState,
          to: nextState,
          semantic: semanticEvidenceId ?? canonicalJson(evidence ?? null),
          key: idempotencyKey ?? ''
        });
        const existingNext = this.db.prepare('SELECT * FROM spool_transitions WHERE migration_id = ? AND sequence = ?').get(migrationId, nextSequence);
        if (existingNext) {
          if (existingNext.command_id != null && existingNext.command_id === effectiveCommandId) {
            // Same logical command retried (e.g. crash before the result was
            // observed): return the STORED transition so identities stay stable.
            const stored = JSON.parse(existingNext.transition_json);
            return { transition: Object.freeze({ ...stored, transitionId: existingNext.transition_id, commandId: existingNext.command_id }), idempotent: true };
          }
          const probeForConflict = buildTransitionRecord({
            migrationId,
            runId: storedRunId,
            previousState: currentState,
            nextState,
            sequence: nextSequence,
            principal: principalText,
            reason,
            timestamp: now,
            planId: effectivePlanId,
            sourceStateId: effectiveSourceStateId,
            targetContractId: effectiveTargetContractId,
            fenceToken: effectiveFenceToken,
            evidence
          });
          if (existingNext.transition_id === createTransitionId(probeForConflict)) {
            // byte-identical duplicate (same timestamp too)
            const stored = JSON.parse(existingNext.transition_json);
            return { transition: Object.freeze({ ...stored, transitionId: existingNext.transition_id, commandId: existingNext.command_id ?? effectiveCommandId }), idempotent: true };
          }
          // same sequence but different command -> conflict
          fail('TRANSITION_CONFLICT', 'Same transition sequence exists with a different command identity', { migrationId, sequence: nextSequence, existingTransitionId: existingNext.transition_id, existingCommandId: existingNext.command_id ?? null, attemptedCommandId: effectiveCommandId });
        }
        // Build record — use effective values for deterministic identity
        const probeRecord = buildTransitionRecord({
          migrationId,
          runId: storedRunId,
          previousState: currentState,
          nextState,
          sequence: nextSequence,
          principal: principalText,
          reason,
          timestamp: now,
          planId: effectivePlanId,
          sourceStateId: effectiveSourceStateId,
          targetContractId: effectiveTargetContractId,
          fenceToken: effectiveFenceToken,
          evidence
        });
        const probeId = createTransitionId(probeRecord);
        // precondition checks beyond graph
        assertTransitionPreconditions({ from: currentState, to: nextState, context });
        // Cutover-grade transitions additionally validate the persisted
        // verification evidence inside the same transaction.
        this.#assertPersistedCutoverVerification({ migrationId, to: nextState, context, effectivePlanId, effectiveSourceStateId, effectiveTargetContractId });
        const transitionJson = canonicalJson(probeRecord);
        const previousTransitionId = stateRow.transition_id;
        this.db.prepare(`
          INSERT INTO spool_transitions (migration_id, sequence, transition_id, command_id, previous_transition_id, previous_state, next_state, principal, reason, plan_id, source_state_id, target_contract_id, fence_token, evidence_json, timestamp, transition_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(migrationId, nextSequence, probeId, effectiveCommandId, previousTransitionId, currentState, nextState, principalText, reason, effectivePlanId, effectiveSourceStateId, effectiveTargetContractId, effectiveFenceToken, evidence ? canonicalJson(evidence) : null, now, transitionJson);
        const newStateChecksum = computeStateChecksum({
          schemaVersion: 1,
          migrationId,
          runId: storedRunId,
          currentState: nextState,
          sequence: nextSequence,
          transitionId: probeId,
          planId: effectivePlanId,
          sourceStateId: effectiveSourceStateId,
          targetContractId: effectiveTargetContractId,
          fenceToken: effectiveFenceToken,
          updatedAt: now
        });
        this.db.prepare(`
          UPDATE spool_migration_state SET current_state = ?, sequence = ?, transition_id = ?, plan_id = ?, source_state_id = ?, target_contract_id = ?, fence_token = ?, updated_at = ?, checksum = ?
          WHERE migration_id = ?
        `).run(nextState, nextSequence, probeId, effectivePlanId, effectiveSourceStateId, effectiveTargetContractId, effectiveFenceToken, now, newStateChecksum, migrationId);
        // keep spool_runs coarse status in sync for legacy callers (best effort)
        this._syncLegacyRunStatus(migrationId, nextState, { planId, sourceStateId, targetContractId });
        return { transition: Object.freeze({ ...probeRecord, transitionId: probeId, commandId: effectiveCommandId }), idempotent: false };
      } else {
        // No state yet — only allowed if nextState === CREATED and previousState null
        if (nextState !== MIGRATION_STATES.CREATED) fail('ILLEGAL_STATE_TRANSITION', 'No migration state exists; first transition must be to CREATED');
        if (previousState !== null && previousState !== undefined) fail('ILLEGAL_STATE_TRANSITION', 'First transition previousState must be null');
        if (expectedSequence != null && expectedSequence !== -1) fail('STALE_TRANSITION_VERSION', 'No existing state; expectedSequence must be -1 or null');
        const finalRunId = runId ?? randomUUID();
        if (expectedRunId && expectedRunId !== finalRunId) fail('STALE_COORDINATOR_EPOCH', 'RunId mismatch on creation');
        const record = buildTransitionRecord({
          migrationId,
          runId: finalRunId,
          previousState: null,
          nextState: MIGRATION_STATES.CREATED,
          sequence: 0,
          principal: principalText,
          reason,
          timestamp: now,
          planId,
          sourceStateId,
          targetContractId,
          fenceToken,
          evidence
        });
        const transitionId = createTransitionId(record);
        const transitionJson = canonicalJson(record);
        // check duplicate
        const existing = this.db.prepare('SELECT * FROM spool_transitions WHERE migration_id = ? AND sequence = 0').get(migrationId);
        if (existing) {
          if (existing.transition_id === transitionId) return { transition: Object.freeze({ ...record, transitionId }), idempotent: true };
          fail('TRANSITION_CONFLICT', 'CREATED transition already exists with conflicting content');
        }
        assertTransitionPreconditions({ from: null, to: MIGRATION_STATES.CREATED, context });
        this.db.prepare(`
          INSERT INTO spool_transitions (migration_id, sequence, transition_id, previous_state, next_state, principal, reason, plan_id, source_state_id, target_contract_id, fence_token, evidence_json, timestamp, transition_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(migrationId, 0, transitionId, null, MIGRATION_STATES.CREATED, principalText, reason, planId, sourceStateId, targetContractId, fenceToken, evidence ? canonicalJson(evidence) : null, now, transitionJson);
        const checksum = computeStateChecksum({
          schemaVersion: 1,
          migrationId,
          runId: finalRunId,
          currentState: MIGRATION_STATES.CREATED,
          sequence: 0,
          transitionId,
          planId,
          sourceStateId,
          targetContractId,
          fenceToken,
          updatedAt: now
        });
        this.db.prepare(`
          INSERT INTO spool_migration_state (migration_id, run_id, current_state, sequence, transition_id, plan_id, source_state_id, target_contract_id, fence_token, updated_at, checksum)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(migrationId, finalRunId, MIGRATION_STATES.CREATED, 0, transitionId, planId, sourceStateId, targetContractId, fenceToken, now, checksum);
        this._syncLegacyRunStatus(migrationId, MIGRATION_STATES.CREATED, { planId, sourceStateId, targetContractId });
        return { transition: Object.freeze({ ...record, transitionId }), idempotent: false };
      }
    });

    const result = tx();
    return result.transition;
  }

  findTransitionByCommand(migrationId, commandId) {
    this.#open(); text(migrationId, 'migrationId');
    if (typeof commandId !== 'string' || !commandId) fail('INVALID_TRANSITION_INPUT', 'commandId must be a non-empty string');
    const row = this.db.prepare('SELECT * FROM spool_transitions WHERE migration_id = ? AND command_id = ?').get(migrationId, commandId);
    if (!row) return null;
    const stored = JSON.parse(row.transition_json);
    return Object.freeze({ ...stored, transitionId: row.transition_id, commandId: row.command_id });
  }

  // Validate persisted cutover verification evidence inside the committing
  // transaction. Object presence in context is never sufficient: the exact
  // persisted record is loaded by identity and checked for existence, mode,
  // derived status, plan/source/contract bindings, cutover attempt binding,
  // and recency relative to the drain/armed transition of this attempt.
  #assertPersistedCutoverVerification({ migrationId, to, context, effectivePlanId, effectiveSourceStateId, effectiveTargetContractId }) {
    const wantFinal = to === MIGRATION_STATES.CUTOVER_COMMITTED;
    const wantPost = to === MIGRATION_STATES.COMPLETED;
    if (!wantFinal && !wantPost) return;
    const verificationId = wantFinal ? context?.finalVerificationId : context?.postCutoverVerificationId;
    if (typeof verificationId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(verificationId)) {
      fail('VERIFICATION_REQUIRED', `${wantFinal ? 'CUTOVER_COMMITTED' : 'COMPLETED'} requires the exact persisted verification identity`);
    }
    const row = this.db.prepare('SELECT verification_json FROM spool_verifications WHERE migration_id = ? AND verification_id = ?').get(migrationId, verificationId);
    if (!row) fail('VERIFICATION_REQUIRED', 'Persisted verification evidence is absent for the bound verification identity', { verificationId });
    const record = JSON.parse(row.verification_json);
    // Authenticity first: identity must match canonical semantic contents.
    assertVerificationIdentity(record);
    // Status is derived from content, never trusted from storage.
    if (verificationStatus(record) !== 'VERIFIED' || record.status !== 'VERIFIED') {
      fail('VERIFICATION_REQUIRED', 'Persisted verification is not VERIFIED', { verificationId, status: record.status });
    }
    const expectedMode = wantFinal ? 'FINAL_PRE_CUTOVER' : 'POST_CUTOVER';
    if (record.mode !== expectedMode) {
      fail('VERIFICATION_MODE_MISMATCH', `Persisted verification mode ${record.mode} cannot authorize ${to}; expected ${expectedMode}`, { verificationId });
    }
    if (record.migrationId !== migrationId
      || record.planId !== effectivePlanId
      || record.sourceStateId !== effectiveSourceStateId
      || record.targetContractId !== effectiveTargetContractId) {
      fail('VERIFICATION_BINDING_MISMATCH', 'Persisted verification is bound to different plan/source/contract than the committing transition', {
        verificationId,
        record: { planId: record.planId, sourceStateId: record.sourceStateId, targetContractId: record.targetContractId },
        transition: { planId: effectivePlanId, sourceStateId: effectiveSourceStateId, targetContractId: effectiveTargetContractId }
      });
    }
    const cutoverRow = this.db.prepare('SELECT cutover_attempt_id FROM spool_cutovers WHERE migration_id = ?').get(migrationId);
    if (!cutoverRow?.cutover_attempt_id || record.cutoverAttemptId !== cutoverRow.cutover_attempt_id) {
      fail('CUTOVER_ATTEMPT_MISMATCH', 'Persisted verification belongs to a different cutover attempt than the committing transition', {
        verificationId,
        verificationAttempt: record.cutoverAttemptId ?? null,
        currentAttempt: cutoverRow?.cutover_attempt_id ?? null
      });
    }
    // Recency: the verification must have been created after the drain (CDC)
    // or arming (non-CDC) transition of this attempt — never before it.
    const anchor = wantFinal
      ? this.db.prepare(`SELECT timestamp FROM spool_transitions WHERE migration_id = ? AND next_state IN ('FINAL_DRAIN','CUTOVER_ARMED') ORDER BY sequence DESC LIMIT 1`).get(migrationId)
      : this.db.prepare(`SELECT timestamp FROM spool_transitions WHERE migration_id = ? AND next_state = 'CUTOVER_COMMITTED' ORDER BY sequence DESC LIMIT 1`).get(migrationId);
    if (!anchor?.timestamp) fail('VERIFICATION_REQUIRED', 'Cutover attempt has no drain/arming/commit anchor for verification recency', { verificationId });
    // completedAt is execution metadata (not part of the semantic identity),
    // but it must still postdate the attempt anchor: evidence created before
    // the final drain finished cannot authorize the commit.
    if (typeof record.completedAt !== 'string' || record.completedAt < anchor.timestamp) {
      fail('STALE_VERIFICATION', 'Persisted verification predates the current cutover attempt anchor; a fresh verification is required', {
        verificationId,
        verificationCompletedAt: record.completedAt ?? null,
        anchorTimestamp: anchor.timestamp
      });
    }
  }

  _syncLegacyRunStatus(migrationId, newState, { planId, sourceStateId, targetContractId } = {}) {
    // Map fine-grained state to coarse legacy spool_runs status for backward compatibility.
    // Do not overwrite receipts unless completing. Early lifecycle states should not create spool_runs — legacy only tracks running migrations.
    const coarseMap = {
      [MIGRATION_STATES.CREATED]: null,
      [MIGRATION_STATES.DISCOVERING]: null,
      [MIGRATION_STATES.PREFLIGHTED]: null,
      [MIGRATION_STATES.PLANNED]: null,
      [MIGRATION_STATES.AWAITING_APPROVAL]: null,
      [MIGRATION_STATES.APPROVED]: null,
      [MIGRATION_STATES.SNAPSHOT_ARMED]: null,
      [MIGRATION_STATES.SNAPSHOT_RUNNING]: null,
      [MIGRATION_STATES.FULL_LOAD_RUNNING]: 'RUNNING',
      [MIGRATION_STATES.CDC_RUNNING]: 'RUNNING',
      [MIGRATION_STATES.CATCHING_UP]: 'RUNNING',
      [MIGRATION_STATES.VERIFYING]: 'RUNNING',
      [MIGRATION_STATES.VERIFICATION_FAILED]: 'VERIFICATION_FAILED',
      [MIGRATION_STATES.READY_FOR_CUTOVER]: 'COMPLETE',
      [MIGRATION_STATES.REPAIR_PLANNED]: 'VERIFICATION_FAILED',
      [MIGRATION_STATES.REPAIR_APPROVED]: 'VERIFICATION_FAILED',
      [MIGRATION_STATES.REPAIRING]: 'VERIFICATION_FAILED',
      [MIGRATION_STATES.REVERIFYING]: 'RUNNING',
      [MIGRATION_STATES.CUTOVER_ARMED]: null,
      [MIGRATION_STATES.FINAL_DRAIN]: null,
      [MIGRATION_STATES.FINAL_VERIFY]: null,
      [MIGRATION_STATES.CUTOVER_COMMITTED]: null,
      [MIGRATION_STATES.POST_CUTOVER_VERIFY]: null,
      [MIGRATION_STATES.COMPLETED]: 'COMPLETE',
      [MIGRATION_STATES.FAILED_RECOVERABLE]: 'FAILED',
      [MIGRATION_STATES.FAILED_OPERATOR_REQUIRED]: 'FAILED',
      [MIGRATION_STATES.ABORTED]: null
    };
    const coarse = coarseMap[newState];
    if (coarse == null) return;
    const existing = this.db.prepare('SELECT status FROM spool_runs WHERE migration_id = ?').get(migrationId);
    if (!existing) {
      // Only create legacy row once we reach execution states
      try {
        this.db.prepare(`INSERT INTO spool_runs (migration_id, status, plan_id, source_snapshot_id) VALUES (?, ?, ?, ?)`).run(migrationId, coarse, planId, sourceStateId);
      } catch { /* ignore if race */ }
      return;
    }
    // Only update if not already terminal COMPLETE/VERIFICATION_FAILED etc? We allow transitions to update status.
    if (coarse === 'COMPLETE' || coarse === 'VERIFICATION_FAILED' || coarse === 'FAILED') {
      this.db.prepare(`UPDATE spool_runs SET status = ?, last_error_code = CASE WHEN ? IN ('VERIFICATION_FAILED','FAILED') THEN ? ELSE last_error_code END WHERE migration_id = ?`).run(coarse, coarse, coarse, migrationId);
    } else if (coarse === 'RUNNING') {
      if (existing.status !== 'COMPLETE' && existing.status !== 'VERIFICATION_FAILED') {
        this.db.prepare(`UPDATE spool_runs SET status = 'RUNNING' WHERE migration_id = ?`).run(migrationId);
      }
    }
  }

  // ---------- Snapshot/CDC binding durable protocol ----------

  setSnapshotCdcBinding(migrationId, binding) {
    this.#open(); text(migrationId, 'migrationId');
    const validated = buildSnapshotCdcBinding(binding);
    const bindingId = sha256Canonical('spool-snapshot-cdc-binding-v1', validated);
    const bindingJson = canonicalJson(validated);
    const checksum = sha256Canonical(BINDING_CHECKSUM_DOMAIN, validated);
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const state = this.db.prepare('SELECT * FROM spool_migration_state WHERE migration_id = ?').get(migrationId);
      if (!state) fail('MIGRATION_NOT_FOUND', 'Snapshot/CDC binding requires an existing migration state');
      this._validateStateChecksum(state);
      // binding must be created in correct sequence: snapshot and CDC boundary must be set before CDC_RUNNING
      // For now allow any state >= APPROVED
      const allowedStates = new Set([MIGRATION_STATES.APPROVED, MIGRATION_STATES.SNAPSHOT_ARMED, MIGRATION_STATES.SNAPSHOT_RUNNING, MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.CDC_RUNNING, MIGRATION_STATES.CATCHING_UP, MIGRATION_STATES.VERIFYING, MIGRATION_STATES.READY_FOR_CUTOVER]);
      if (!allowedStates.has(state.current_state)) {
        fail('ILLEGAL_STATE_TRANSITION', `Snapshot/CDC binding can only be set from ${[...allowedStates].join(',')} not ${state.current_state}`);
      }
      // Upsert binding
      this.db.prepare(`
        INSERT INTO spool_snapshot_cdc_bindings (migration_id, binding_json, binding_id, source_state_id, database_snapshot_identity, exported_snapshot_id, snapshot_lsn, cdc_start_lsn, received_lsn, applied_lsn, acknowledged_lsn, cdc_slot, cdc_publication, catalog_id, updated_at, checksum)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(migration_id) DO UPDATE SET
          binding_json=excluded.binding_json, binding_id=excluded.binding_id, source_state_id=excluded.source_state_id, database_snapshot_identity=excluded.database_snapshot_identity, exported_snapshot_id=excluded.exported_snapshot_id, snapshot_lsn=excluded.snapshot_lsn, cdc_start_lsn=excluded.cdc_start_lsn, received_lsn=excluded.received_lsn, applied_lsn=excluded.applied_lsn, acknowledged_lsn=excluded.acknowledged_lsn, cdc_slot=excluded.cdc_slot, cdc_publication=excluded.cdc_publication, catalog_id=excluded.catalog_id, updated_at=excluded.updated_at, checksum=excluded.checksum
      `).run(migrationId, bindingJson, bindingId, validated.sourceStateId, validated.databaseSnapshotIdentity, validated.exportedSnapshotId, validated.snapshotLsn, validated.cdcStartLsn, validated.receivedLsn, validated.appliedLsn, validated.acknowledgedLsn, validated.cdcSlot, validated.cdcPublication, validated.catalogId, now, checksum);
    });
    tx();
    return this.getSnapshotCdcBinding(migrationId);
  }

  getSnapshotCdcBinding(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    const row = this.db.prepare('SELECT * FROM spool_snapshot_cdc_bindings WHERE migration_id = ?').get(migrationId);
    if (!row) return null;
    const parsed = JSON.parse(row.binding_json);
    // validate checksum
    const expected = sha256Canonical(BINDING_CHECKSUM_DOMAIN, parsed);
    if (expected !== row.checksum) fail('RUN_STATE_CORRUPT', 'Snapshot/CDC binding checksum mismatch');
    if (parsed.sourceStateId !== row.source_state_id) fail('RUN_STATE_CORRUPT', 'Snapshot/CDC binding row mismatch');
    return Object.freeze(parsed);
  }

  updateCdcProgress(migrationId, { receivedLsn = null, appliedLsn = null, acknowledgedLsn = null } = {}) {
    this.#open(); text(migrationId, 'migrationId');
    const row = this.db.prepare('SELECT * FROM spool_snapshot_cdc_bindings WHERE migration_id = ?').get(migrationId);
    if (!row) fail('CDC_BINDING_REQUIRED', 'CDC progress update requires an existing snapshot/CDC binding');
    const current = JSON.parse(row.binding_json);
    const updated = buildSnapshotCdcBinding({
      ...current,
      receivedLsn: receivedLsn ?? current.receivedLsn,
      appliedLsn: appliedLsn ?? current.appliedLsn,
      acknowledgedLsn: acknowledgedLsn ?? current.acknowledgedLsn
    });
    // monotonicity already validated by buildSnapshotCdcBinding; also ensure ack <= applied
    return this.setSnapshotCdcBinding(migrationId, updated);
  }

  // ---------- Legacy spool_runs helpers (kept for backward compat, now also drive state machine where relevant) ----------

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
      repair: parse(row.repair_json),
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
        receipt_json=NULL, repair_json=NULL, completed_at=NULL, last_error_code=NULL
    `).run(text(migrationId, 'migrationId'), text(planId, 'planId'), text(sourceSnapshotId, 'sourceSnapshotId'), canonicalJson(targetIdentity), text(startedAt, 'startedAt'));
    this.db.prepare('DELETE FROM spool_repair_operations WHERE migration_id=?').run(text(migrationId, 'migrationId'));
    // Ensure migration state exists and advance if needed (best-effort, ignore if already transitioned)
    try {
      if (!this.getMigrationState(migrationId)) {
        this.initializeMigration(migrationId, { principal: 'system', reason: 'run start' });
      }
      const state = this.getMigrationState(migrationId);
      if (state && [MIGRATION_STATES.CREATED, MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL, MIGRATION_STATES.APPROVED, MIGRATION_STATES.SNAPSHOT_ARMED, MIGRATION_STATES.SNAPSHOT_RUNNING].includes(state.currentState)) {
        // advance to FULL_LOAD_RUNNING if not already there, respecting allowed graph
        // We do stepwise advancement via transitions to keep durability
        const path = [];
        if (state.currentState === MIGRATION_STATES.CREATED) path.push(MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL, MIGRATION_STATES.APPROVED);
        else if (state.currentState === MIGRATION_STATES.DISCOVERING) path.push(MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL, MIGRATION_STATES.APPROVED);
        else if (state.currentState === MIGRATION_STATES.PREFLIGHTED) path.push(MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL, MIGRATION_STATES.APPROVED);
        else if (state.currentState === MIGRATION_STATES.PLANNED) path.push(MIGRATION_STATES.AWAITING_APPROVAL, MIGRATION_STATES.APPROVED);
        else if (state.currentState === MIGRATION_STATES.AWAITING_APPROVAL) path.push(MIGRATION_STATES.APPROVED);
        // Simplified approval precondition: if we are moving to APPROVED, we need a fake context that passes? Instead, only transition if approval is already stored elsewhere — skip precondition by using minimal context that will fail? To avoid breaking legacy start without approval context, we skip APPROVED transition if not yet approved and go directly?
        // For legacy filesystem runs, approval is validated in command-service before start; state machine will have been moved to APPROVED already via command-service. So start() here is after approval, so we should have already passed APPROVED.
        // If we still attempt to advance to APPROVED without approval context, precondition will throw APPROVAL_REQUIRED — we should catch and ignore.
        for (const next of path) {
          try {
            const cur = this.getMigrationState(migrationId);
            if (!isAllowedTransition(cur.currentState, next)) break;
            // supply minimal approval context if needed — if fails, break
            this.transition(migrationId, { nextState: next, principal: 'system', reason: 'legacy start auto-advance', planId, sourceStateId: sourceSnapshotId, context: {} });
          } catch (e) {
            if (e?.code === 'APPROVAL_REQUIRED' || e?.code === 'REPAIR_APPROVAL_MISUSE') break;
            // also break on precondition failures for auto-advance
            if (e?.code === 'ILLEGAL_STATE_TRANSITION') break;
            throw e;
          }
        }
        const cur2 = this.getMigrationState(migrationId);
        if (cur2 && [MIGRATION_STATES.APPROVED, MIGRATION_STATES.SNAPSHOT_ARMED].includes(cur2.currentState)) {
          try { this.transition(migrationId, { nextState: MIGRATION_STATES.SNAPSHOT_RUNNING, principal: 'system', reason: 'legacy start', planId, sourceStateId: sourceSnapshotId }); } catch (e) { this.#tolerateAutoAdvanceRace(e); }
        }
        const cur3 = this.getMigrationState(migrationId);
        if (cur3 && cur3.currentState === MIGRATION_STATES.SNAPSHOT_RUNNING) {
          try { this.transition(migrationId, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'system', reason: 'legacy start', planId, sourceStateId: sourceSnapshotId }); } catch (e) { this.#tolerateAutoAdvanceRace(e); }
        }
        // If still in APPROVED, jump to FULL_LOAD_RUNNING directly (allowed edge)
        const cur4 = this.getMigrationState(migrationId);
        if (cur4 && cur4.currentState === MIGRATION_STATES.APPROVED) {
          try { this.transition(migrationId, { nextState: MIGRATION_STATES.FULL_LOAD_RUNNING, principal: 'system', reason: 'legacy start', planId, sourceStateId: sourceSnapshotId }); } catch (e) { this.#tolerateAutoAdvanceRace(e); }
        }
      }
    } catch (e) {
      // Canonical advancement failure aborts start: proceeding with a diverged
      // legacy projection would hide protocol errors from the caller.
      throw e;
    }
  }

  // Tolerate only the concurrent-auto-advance race in legacy best-effort
  // paths: the guard just observed the source state, so ILLEGAL means another
  // process already advanced past it. Every other protocol error propagates.
  #tolerateAutoAdvanceRace(error) {
    if (error?.code === 'ILLEGAL_STATE_TRANSITION') return;
    throw error;
  }
  complete({ migrationId, verification, receipt, completedAt }) {
    this.#open();
    this.db.prepare(`UPDATE spool_runs SET status='COMPLETE', verification_json=?, receipt_json=?, repair_json=NULL, completed_at=?, last_error_code=NULL WHERE migration_id=?`)
      .run(canonicalJson(verification), canonicalJson(receipt), text(completedAt, 'completedAt'), text(migrationId, 'migrationId'));
    // Canonical advancement participates in the same atomicity contract as the
    // legacy row update above is single-statement; only the concurrent-advance
    // race is tolerated, every other protocol error propagates.
    const state = this.getMigrationState(migrationId);
    if (state) {
      // Move through VERIFYING -> READY_FOR_CUTOVER if not already
      if ([MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.CDC_RUNNING, MIGRATION_STATES.CATCHING_UP].includes(state.currentState)) {
        try { this.transition(migrationId, { nextState: MIGRATION_STATES.VERIFYING, principal: 'system', reason: 'verify' }); } catch (e) { this.#tolerateAutoAdvanceRace(e); }
      }
      const cur = this.getMigrationState(migrationId);
      if (cur && cur.currentState === MIGRATION_STATES.VERIFYING) {
        this.transition(migrationId, { nextState: MIGRATION_STATES.READY_FOR_CUTOVER, principal: 'system', reason: 'verified', context: { verification } });
      }
      // Note: complete does not yet go to COMPLETED; that requires post-cutover verify. Keep legacy COMPLETE mapping.
    }
  }
  verificationFailed({ migrationId, verification }) {
    this.#open();
    this.db.prepare(`UPDATE spool_runs SET status='VERIFICATION_FAILED', verification_json=?, receipt_json=NULL, repair_json=NULL, completed_at=NULL, last_error_code='VERIFICATION_FAILED' WHERE migration_id=?`)
      .run(canonicalJson(verification), text(migrationId, 'migrationId'));
    this.db.prepare('DELETE FROM spool_repair_operations WHERE migration_id=?').run(text(migrationId, 'migrationId'));
    const state = this.getMigrationState(migrationId);
    if (state && state.currentState === MIGRATION_STATES.VERIFYING) {
      try { this.transition(migrationId, { nextState: MIGRATION_STATES.VERIFICATION_FAILED, principal: 'system', reason: 'verification failed', evidence: { verification } }); } catch (e) { this.#tolerateAutoAdvanceRace(e); }
    } else if (state && state.currentState === MIGRATION_STATES.REVERIFYING) {
      try { this.transition(migrationId, { nextState: MIGRATION_STATES.VERIFICATION_FAILED, principal: 'system', reason: 'reverification failed', evidence: { verification } }); } catch (e) { this.#tolerateAutoAdvanceRace(e); }
    }
  }
  fail({ migrationId, errorCode }) {
    this.#open();
    this.db.prepare(`UPDATE spool_runs SET status='FAILED', last_error_code=? WHERE migration_id=?`)
      .run(text(errorCode, 'errorCode'), text(migrationId, 'migrationId'));
    const state = this.getMigrationState(migrationId);
    if (state && !['FAILED_RECOVERABLE','FAILED_OPERATOR_REQUIRED','COMPLETED','ABORTED'].includes(state.currentState)) {
      const to = errorCode === 'OPERATOR_REQUIRED' ? MIGRATION_STATES.FAILED_OPERATOR_REQUIRED : MIGRATION_STATES.FAILED_RECOVERABLE;
      try { this.transition(migrationId, { nextState: to, principal: 'system', reason: errorCode }); } catch (e) { this.#tolerateAutoAdvanceRace(e); }
    }
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
  saveRepairOperation({ migrationId, repairPlanId, keyId, effect, applied, observedRowHash = null, writtenRowHash = null, attemptedAt }) {
    this.#open();
    text(migrationId, 'migrationId'); text(repairPlanId, 'repairPlanId'); text(keyId, 'keyId'); text(effect, 'effect');
    if (!['INSERT', 'UPDATE', 'DELETE'].includes(effect)) fail('INVALID_RUN_STORE_INPUT', 'repair operation effect must be INSERT, UPDATE or DELETE');
    this.db.prepare(`
      INSERT INTO spool_repair_operations (
        migration_id, repair_plan_id, key_id, effect, applied, observed_row_hash, written_row_hash, attempted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(migration_id, repair_plan_id, key_id) DO UPDATE SET
        effect=excluded.effect,
        applied=excluded.applied,
        observed_row_hash=excluded.observed_row_hash,
        written_row_hash=excluded.written_row_hash,
        attempted_at=excluded.attempted_at
    `).run(
      migrationId, repairPlanId, keyId, effect, applied === true ? 1 : 0,
      observedRowHash, writtenRowHash, text(attemptedAt, 'attemptedAt')
    );
  }
  repairOperations(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    return this.db.prepare(`
      SELECT repair_plan_id, key_id, effect, applied, observed_row_hash, written_row_hash, attempted_at
      FROM spool_repair_operations WHERE migration_id=? ORDER BY repair_plan_id, key_id
    `).all(migrationId).map(row => Object.freeze({
      repairPlanId: row.repair_plan_id,
      keyId: row.key_id,
      effect: row.effect,
      applied: Number(row.applied) === 1,
      observedRowHash: row.observed_row_hash,
      writtenRowHash: row.written_row_hash,
      attemptedAt: row.attempted_at
    }));
  }
  clearRepairOperations(migrationId) {
    this.#open();
    this.db.prepare('DELETE FROM spool_repair_operations WHERE migration_id=?').run(text(migrationId, 'migrationId'));
  }
  completeRepair({ migrationId, repair, completedAt }) {
    this.#open();
    if (!repair || typeof repair !== 'object' || Array.isArray(repair)) fail('INVALID_RUN_STORE_INPUT', 'repair record is required');
    // One transaction: legacy projection update + canonical transitions move
    // together, so a crash cannot leave REPAIR_COMPLETE recorded while the
    // canonical state still says REPAIRING.
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE spool_runs SET status='REPAIR_COMPLETE', repair_json=?, completed_at=?, last_error_code=NULL WHERE migration_id=?`)
        .run(canonicalJson(repair), text(completedAt, 'completedAt'), text(migrationId, 'migrationId'));
      const state = this.getMigrationState(migrationId);
      if (state) {
        // REPAIRING -> REVERIFYING
        if (state.currentState === MIGRATION_STATES.REPAIRING) {
          this.transition(migrationId, { nextState: MIGRATION_STATES.REVERIFYING, principal: 'system', reason: 'repair complete' });
        }
        const cur = this.getMigrationState(migrationId);
        if (cur && cur.currentState === MIGRATION_STATES.REVERIFYING) {
          // reverify succeeded implies READY_FOR_CUTOVER
          const verification = repair.verification ?? repair?.receipt?.record?.verification ?? null;
          if (!verification || verification.status !== 'VERIFIED') {
            fail('VERIFICATION_REQUIRED', 'READY_FOR_CUTOVER requires a successful reverification');
          }
          this.transition(migrationId, { nextState: MIGRATION_STATES.READY_FOR_CUTOVER, principal: 'system', reason: 'reverified', context: { verification } });
        }
      }
    });
    tx();
  }
  // ---------- Atomic cutover operations ----------
  // Each operation below performs its cutover-row write AND its canonical
  // state transition(s) inside ONE SQLite transaction, so a crash can never
  // leave the cutover record and the canonical migration state diverged:
  // either everything for the operation is durable, or nothing is.

  #requireCutoverAttempt({ migrationId, cutoverAttemptId, armedAt, receiptId, receiptKind, planId, sourceSnapshotId, targetContractId }) {
    requireCutoverAttemptId(cutoverAttemptId);
    const expected = buildCutoverAttemptId({ migrationId, receiptId, receiptKind, planId, sourceStateId: sourceSnapshotId, targetContractId, armedAt });
    if (expected !== cutoverAttemptId) {
      fail('CUTOVER_ATTEMPT_MISMATCH', 'Supplied cutoverAttemptId does not match the canonical identity of these arming inputs', {
        supplied: cutoverAttemptId,
        expected
      });
    }
    return expected;
  }

  armCutoverAtomic({ migrationId, principal, receiptId, receiptKind, planId, sourceSnapshotId, targetIdentity, targetContractId, armedAt, cutoverAttemptId, commandId = null }) {
    this.#open();
    text(migrationId, 'migrationId'); text(receiptId, 'receiptId'); text(planId, 'planId');
    text(sourceSnapshotId, 'sourceSnapshotId'); text(targetContractId, 'targetContractId'); text(armedAt, 'armedAt');
    if (typeof principal !== 'string' || !principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
    if (receiptKind !== 'migration' && receiptKind !== 'repair') fail('INVALID_RUN_STORE_INPUT', 'receiptKind must be migration or repair');
    this.#requireCutoverAttempt({ migrationId, cutoverAttemptId, armedAt, receiptId, receiptKind, planId, sourceSnapshotId, targetContractId });
    const tx = this.db.transaction(() => {
      const existing = this.cutover(migrationId);
      if (existing?.status === 'COMMITTED') fail('CUTOVER_STATE_CONFLICT', 'Cutover is already committed');
      if (existing?.status === 'ARMED') {
        if (existing.cutoverAttemptId === cutoverAttemptId) return existing;
        fail('CUTOVER_STATE_CONFLICT', 'A different cutover attempt is already armed; abort or re-arm it first', {
          armedAttempt: existing.cutoverAttemptId ?? null
        });
      }
      this.db.prepare(`
        INSERT INTO spool_cutovers (
          migration_id, status, receipt_id, receipt_kind, plan_id, source_snapshot_id,
          target_identity_json, target_contract_id, commit_evidence_json, abort_reason, cutover_attempt_id, armed_at, decided_at
        ) VALUES (?, 'ARMED', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)
        ON CONFLICT(migration_id) DO UPDATE SET
          status='ARMED', receipt_id=excluded.receipt_id, receipt_kind=excluded.receipt_kind,
          plan_id=excluded.plan_id, source_snapshot_id=excluded.source_snapshot_id,
          target_identity_json=excluded.target_identity_json, target_contract_id=excluded.target_contract_id,
          commit_evidence_json=NULL, abort_reason=NULL, cutover_attempt_id=excluded.cutover_attempt_id,
          armed_at=excluded.armed_at, decided_at=NULL
      `).run(
        migrationId, receiptId, receiptKind, planId, sourceSnapshotId,
        canonicalJson(targetIdentity), targetContractId, cutoverAttemptId, armedAt
      );
      this.transition(migrationId, {
        nextState: MIGRATION_STATES.CUTOVER_ARMED, principal, reason: 'cutover armed',
        planId, sourceStateId: sourceSnapshotId, targetContractId,
        evidence: { receiptId, receiptKind, cutoverAttemptId },
        context: { cutoverEvidence: { receiptId, receiptKind, cutoverAttemptId }, receiptId, receiptKind, cutoverAttemptId, planId, targetContractId },
        commandId: commandId ?? `cutover-arm:${cutoverAttemptId}`
      });
      return this.cutover(migrationId);
    });
    return tx();
  }

  // Explicit re-arm after abort. Mints nothing implicitly: the caller supplies
  // a FRESH attempt id (new armedAt); reusing the aborted attempt's id fails.
  // Re-arm re-validates plan and contract against the CURRENT canonical state
  // bindings rather than trusting the aborted attempt's values.
  rearmCutoverAtomic({ migrationId, principal, reason, receiptId, receiptKind, planId, sourceSnapshotId, targetIdentity, targetContractId, armedAt, cutoverAttemptId, commandId = null }) {
    this.#open();
    text(migrationId, 'migrationId');
    if (typeof principal !== 'string' || !principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
    if (typeof reason !== 'string' || !reason.trim()) fail('INVALID_CUTOVER_REQUEST', 're-arm reason must be a non-empty bounded string');
    if (receiptKind !== 'migration' && receiptKind !== 'repair') fail('INVALID_RUN_STORE_INPUT', 'receiptKind must be migration or repair');
    this.#requireCutoverAttempt({ migrationId, cutoverAttemptId, armedAt, receiptId, receiptKind, planId, sourceSnapshotId, targetContractId });
    const tx = this.db.transaction(() => {
      const existing = this.cutover(migrationId);
      if (!existing) fail('CUTOVER_STATE_CONFLICT', 'Re-arm requires a previously aborted cutover attempt');
      if (existing.status === 'COMMITTED') fail('CUTOVER_ALREADY_COMMITTED', 'A committed cutover cannot be re-armed');
      if (existing.cutoverAttemptId === cutoverAttemptId) {
        fail('CUTOVER_ATTEMPT_MISMATCH', 'Re-arm requires a fresh cutover attempt identity, not the aborted attempt', {
          abortedAttempt: existing.cutoverAttemptId ?? null
        });
      }
      const state = this.getMigrationState(migrationId);
      if (!state || state.currentState !== MIGRATION_STATES.ABORTED) {
        fail('CUTOVER_STATE_CONFLICT', `Re-arm requires canonical state ABORTED, not ${state?.currentState ?? 'absent'}`);
      }
      if (planId !== state.planId || sourceSnapshotId !== state.sourceStateId || targetContractId !== state.targetContractId) {
        fail('CUTOVER_REARM_BINDING_MISMATCH', 'Re-arm plan/source/contract must match the current canonical bindings', {
          canonical: { planId: state.planId, sourceStateId: state.sourceStateId, targetContractId: state.targetContractId }
        });
      }
      this.db.prepare(`
        UPDATE spool_cutovers SET status='ARMED', receipt_id=?, receipt_kind=?, plan_id=?, source_snapshot_id=?,
          target_identity_json=?, target_contract_id=?, commit_evidence_json=NULL, abort_reason=NULL,
          cutover_attempt_id=?, armed_at=?, decided_at=NULL WHERE migration_id=?
      `).run(
        receiptId, receiptKind, planId, sourceSnapshotId,
        canonicalJson(targetIdentity), targetContractId, cutoverAttemptId, armedAt, migrationId
      );
      this.transition(migrationId, {
        nextState: MIGRATION_STATES.CUTOVER_ARMED, principal, reason: `cutover re-armed: ${reason}`.slice(0, 256),
        planId, sourceStateId: sourceSnapshotId, targetContractId,
        evidence: { receiptId, receiptKind, cutoverAttemptId, rearmReason: reason },
        context: {
          cutoverEvidence: { receiptId, receiptKind, cutoverAttemptId }, receiptId, receiptKind, cutoverAttemptId, planId, targetContractId,
          rearm: { cutoverAttemptId, principal, reason }
        },
        commandId: commandId ?? `cutover-rearm:${cutoverAttemptId}`
      });
      return this.cutover(migrationId);
    });
    return tx();
  }

  // Persist FINAL_PRE_CUTOVER evidence and enter FINAL_VERIFY atomically.
  recordFinalVerificationAtomic({ migrationId, principal, verification, fenceToken, planId, sourceStateId, targetContractId, commandId = null }) {
    this.#open();
    text(migrationId, 'migrationId');
    if (typeof principal !== 'string' || !principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
    if (!verification || typeof verification !== 'object') fail('INVALID_VERIFICATION', 'Final verification record is required');
    if (verification.mode !== 'FINAL_PRE_CUTOVER') fail('VERIFICATION_MODE_MISMATCH', 'FINAL_VERIFY requires a FINAL_PRE_CUTOVER verification record');
    if (verification.status !== 'VERIFIED') fail('VERIFICATION_REQUIRED', 'FINAL_VERIFY requires a VERIFIED final verification record');
    assertVerificationIdentity(verification);
    if (!Number.isSafeInteger(fenceToken) || fenceToken < 1) fail('FENCE_REQUIRED', 'FINAL_VERIFY requires a fresh fence token');
    const tx = this.db.transaction(() => {
      this.saveVerification(migrationId, verification);
      this.transition(migrationId, {
        nextState: MIGRATION_STATES.FINAL_VERIFY, principal, reason: 'final verify',
        planId, sourceStateId, targetContractId, fenceToken,
        evidence: { fencingToken: fenceToken, finalVerificationId: verification.verificationId },
        context: { fenceToken, finalVerificationId: verification.verificationId },
        commandId: commandId ?? `cutover-final-verify:${verification.cutoverAttemptId ?? verification.verificationId}`
      });
      return this.getVerificationById(migrationId, verification.verificationId);
    });
    return tx();
  }

  commitCutoverAtomic({ migrationId, principal, commitEvidence, decidedAt, finalVerificationId, fenceToken, planId, sourceStateId, targetContractId, commandId = null }) {
    this.#open();
    if (!commitEvidence || typeof commitEvidence !== 'object' || Array.isArray(commitEvidence)) fail('INVALID_RUN_STORE_INPUT', 'commit evidence is required');
    if (typeof principal !== 'string' || !principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
    const tx = this.db.transaction(() => {
      const existing = this.cutover(migrationId);
      if (!existing) fail('CUTOVER_STATE_CONFLICT', 'Cutover commit requires an armed cutover');
      if (existing.status === 'COMMITTED') {
        // Crash-after-commit retry with the same bound verification is
        // idempotent; anything else on a committed migration is refused.
        const commitRow = this.db.prepare(`SELECT evidence_json FROM spool_transitions WHERE migration_id = ? AND next_state = 'CUTOVER_COMMITTED' ORDER BY sequence DESC LIMIT 1`).get(migrationId);
        const committedVerificationId = commitRow ? JSON.parse(commitRow.evidence_json ?? '{}')?.finalVerificationId ?? null : null;
        if (committedVerificationId != null && committedVerificationId === finalVerificationId) return existing;
        fail('CUTOVER_ALREADY_COMMITTED', 'Cutover is already committed');
      }
      if (existing.status !== 'ARMED') fail('CUTOVER_STATE_CONFLICT', 'Cutover commit requires an armed cutover');
      this.transition(migrationId, {
        nextState: MIGRATION_STATES.CUTOVER_COMMITTED, principal, reason: 'cutover committed',
        planId, sourceStateId, targetContractId, fenceToken,
        evidence: { fencingToken: fenceToken, targetContractId, finalVerificationId },
        context: { fenceToken, finalVerificationId },
        commandId: commandId ?? `cutover-commit:${existing.cutoverAttemptId ?? finalVerificationId}`
      });
      this.db.prepare(`UPDATE spool_cutovers SET status='COMMITTED', commit_evidence_json=?, decided_at=? WHERE migration_id=?`)
        .run(canonicalJson(commitEvidence), text(decidedAt, 'decidedAt'), text(migrationId, 'migrationId'));
      return this.cutover(migrationId);
    });
    return tx();
  }

  recordPostCutoverVerificationAtomic({ migrationId, principal, verification, commandId = null }) {
    this.#open();
    text(migrationId, 'migrationId');
    if (typeof principal !== 'string' || !principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
    if (!verification || typeof verification !== 'object') fail('INVALID_VERIFICATION', 'Post-cutover verification record is required');
    if (verification.mode !== 'POST_CUTOVER') fail('VERIFICATION_MODE_MISMATCH', 'POST_CUTOVER_VERIFY requires a POST_CUTOVER verification record');
    if (verification.status !== 'VERIFIED') fail('VERIFICATION_REQUIRED', 'POST_CUTOVER_VERIFY requires a VERIFIED post-cutover verification record');
    assertVerificationIdentity(verification);
    const tx = this.db.transaction(() => {
      this.saveVerification(migrationId, verification);
      this.transition(migrationId, {
        nextState: MIGRATION_STATES.POST_CUTOVER_VERIFY, principal, reason: 'post cutover verify',
        planId: verification.planId, sourceStateId: verification.sourceStateId, targetContractId: verification.targetContractId,
        evidence: { postCutoverVerificationId: verification.verificationId },
        context: { postCutoverVerificationId: verification.verificationId },
        commandId: commandId ?? `cutover-post-verify:${verification.cutoverAttemptId ?? verification.verificationId}`
      });
      return this.getVerificationById(migrationId, verification.verificationId);
    });
    return tx();
  }

  completeMigrationAtomic({ migrationId, principal, postCutoverVerificationId, planId, sourceStateId, targetContractId, commandId = null }) {
    this.#open();
    text(migrationId, 'migrationId');
    if (typeof principal !== 'string' || !principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
    const tx = this.db.transaction(() => {
      this.transition(migrationId, {
        nextState: MIGRATION_STATES.COMPLETED, principal, reason: 'completed',
        planId, sourceStateId, targetContractId,
        evidence: { postCutoverVerificationId },
        context: { postCutoverVerificationId },
        commandId: commandId ?? `cutover-complete:${postCutoverVerificationId}`
      });
      return this.getMigrationState(migrationId);
    });
    return tx();
  }

  abortCutoverAtomic({ migrationId, principal, reason, decidedAt, commandId = null }) {
    this.#open();
    if (typeof principal !== 'string' || !principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 256) fail('INVALID_CUTOVER_REQUEST', 'abort reason must be a non-empty bounded string');
    const tx = this.db.transaction(() => {
      const existing = this.cutover(migrationId);
      if (!existing) fail('CUTOVER_STATE_CONFLICT', 'Cutover abort requires an armed cutover');
      if (existing.status === 'COMMITTED') fail('CUTOVER_ALREADY_COMMITTED', 'A committed cutover cannot be aborted');
      if (existing.status !== 'ARMED') fail('CUTOVER_STATE_CONFLICT', 'Cutover abort requires an armed cutover');
      this.db.prepare(`UPDATE spool_cutovers SET status='ABORTED', abort_reason=?, decided_at=? WHERE migration_id=?`)
        .run(text(reason, 'reason'), text(decidedAt, 'decidedAt'), text(migrationId, 'migrationId'));
      const state = this.getMigrationState(migrationId);
      if (state && [MIGRATION_STATES.CUTOVER_ARMED, MIGRATION_STATES.FINAL_DRAIN, MIGRATION_STATES.FINAL_VERIFY].includes(state.currentState)) {
        this.transition(migrationId, {
          nextState: MIGRATION_STATES.ABORTED, principal, reason: reason.trim(),
          evidence: { cutoverAttemptId: existing.cutoverAttemptId ?? null },
          commandId: commandId ?? `cutover-abort:${existing.cutoverAttemptId ?? migrationId}:${decidedAt}`
        });
      }
      return this.cutover(migrationId);
    });
    return tx();
  }

  // Explicit operator-initiated recovery from FAILED_RECOVERABLE. The intent
  // (target resume point + justification) and the effect (arrival at the
  // resume point) commit atomically, so a crash leaves either the original
  // FAILED_RECOVERABLE state or the fully recorded recovery — never a bare
  // RECOVERY_PENDING without effect, and never an effect without intent.
  beginRecovery({ migrationId, principal, reason, targetState, commandId = null }) {
    this.#open();
    text(migrationId, 'migrationId');
    if (typeof principal !== 'string' || !principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
    if (typeof reason !== 'string' || !reason.trim()) fail('RECOVERY_EVIDENCE_REQUIRED', 'Recovery requires a reason describing the resolved failure cause');
    if (![MIGRATION_STATES.SNAPSHOT_ARMED, MIGRATION_STATES.FULL_LOAD_RUNNING].includes(targetState)) {
      fail('RECOVERY_TARGET_INVALID', 'Recovery target must be a safe resume point (SNAPSHOT_ARMED or FULL_LOAD_RUNNING)', { targetState: targetState ?? null });
    }
    // Idempotent retry: the same recovery command issued after a crash finds
    // its committed intent and returns the current state instead of failing.
    if (commandId != null) {
      const prior = this.findTransitionByCommand(migrationId, commandId);
      if (prior) return this.getMigrationState(migrationId);
    }
    const tx = this.db.transaction(() => {
      const state = this.getMigrationState(migrationId);
      if (!state || state.currentState !== MIGRATION_STATES.FAILED_RECOVERABLE) {
        fail('RECOVERY_NOT_REQUIRED', `Recovery requires canonical state FAILED_RECOVERABLE, not ${state?.currentState ?? 'absent'}`);
      }
      if (targetState === MIGRATION_STATES.FULL_LOAD_RUNNING) {
        // Resume requires durable proof of partial progress bound to this
        // migration/plan/snapshot; otherwise restart from SNAPSHOT_ARMED.
        const checkpointRow = this.db.prepare('SELECT checkpoint_json FROM spool_checkpoints WHERE migration_id = ?').get(migrationId);
        const checkpoint = checkpointRow ? JSON.parse(checkpointRow.checkpoint_json) : null;
        if (!checkpoint || typeof checkpoint.nextOffset !== 'number' || checkpoint.nextOffset <= 0) {
          fail('RECOVERY_EVIDENCE_REQUIRED', 'Recovery to FULL_LOAD_RUNNING requires a durable checkpoint with partial progress', { targetState });
        }
        if (checkpoint.migrationId !== migrationId || (state.planId && checkpoint.planId !== state.planId) || (state.sourceStateId && checkpoint.sourceSnapshotId !== state.sourceStateId)) {
          fail('RECOVERY_EVIDENCE_REQUIRED', 'Durable checkpoint is not bound to this migration/plan/snapshot', { targetState });
        }
      }
      const recovery = { targetState, principal, reason };
      this.transition(migrationId, {
        nextState: MIGRATION_STATES.RECOVERY_PENDING, principal, reason: `recovery pending: ${reason}`.slice(0, 256),
        evidence: { recovery },
        context: { recovery },
        commandId: commandId ?? `recovery-begin:${migrationId}:${targetState}`
      });
      this.transition(migrationId, {
        nextState: targetState, principal, reason: `recovered: ${reason}`.slice(0, 256),
        context: { recovery },
        commandId: commandId ? `${commandId}:arrive` : `recovery-arrive:${migrationId}:${targetState}`
      });
      return this.getMigrationState(migrationId);
    });
    return tx();
  }
  cutover(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    const row = this.db.prepare('SELECT * FROM spool_cutovers WHERE migration_id = ?').get(migrationId);
    if (!row) return null;
    return Object.freeze({
      migrationId: row.migration_id,
      status: row.status,
      receiptId: row.receipt_id,
      receiptKind: row.receipt_kind,
      planId: row.plan_id,
      sourceSnapshotId: row.source_snapshot_id,
      targetIdentity: parse(row.target_identity_json),
      targetContractId: row.target_contract_id,
      commitEvidence: parse(row.commit_evidence_json),
      abortReason: row.abort_reason,
      cutoverAttemptId: row.cutover_attempt_id ?? null,
      armedAt: row.armed_at,
      decidedAt: row.decided_at
    });
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
        // Add checksum validation: ensure checkpoint binding matches migration state
        this.db.prepare(`INSERT INTO spool_checkpoints (migration_id, checkpoint_json) VALUES (?, ?) ON CONFLICT(migration_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json`)
          .run(migrationId, json);
      }
    });
  }
  clearCheckpoint(migrationId) {
    this.#open(); this.db.prepare('DELETE FROM spool_checkpoints WHERE migration_id=?').run(text(migrationId, 'migrationId'));
  }

  // Immutable verification evidence store. The supplied verificationId must
  // equal the recomputed semantic identity; a mismatch means the record was
  // mutated after minting (VERIFICATION_ID_MISMATCH). An existing row with the
  // same identity but different payload is a conflict (VERIFICATION_ID_CONFLICT);
  // byte-identical re-save is idempotent. Evidence is never overwritten.
  saveVerification(migrationId, verification) {
    this.#open(); text(migrationId, 'migrationId');
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) fail('INVALID_VERIFICATION', 'Verification record is required');
    assertVerificationIdentity(verification);
    if (typeof verification.mode !== 'string' || !verification.mode) fail('INVALID_VERIFICATION', 'Verification mode is required');
    const verificationJson = canonicalJson(verification);
    const existing = this.db.prepare('SELECT verification_json FROM spool_verifications WHERE migration_id = ? AND verification_id = ?').get(migrationId, verification.verificationId);
    if (existing) {
      if (existing.verification_json !== verificationJson) {
        fail('VERIFICATION_ID_CONFLICT', 'A different verification payload already exists under this verification identity', {
          verificationId: verification.verificationId
        });
      }
      return this.getVerificationById(migrationId, verification.verificationId);
    }
    this.db.prepare(`
      INSERT INTO spool_verifications (migration_id, verification_id, mode, verification_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(text(migrationId, 'migrationId'), text(verification.verificationId, 'verificationId'), text(verification.mode, 'mode'), verificationJson, text(new Date().toISOString(), 'createdAt'));
    return this.getVerificationById(migrationId, verification.verificationId);
  }

  getVerification(migrationId) {
    this.#open(); text(migrationId, 'migrationId');
    const row = this.db.prepare('SELECT verification_json FROM spool_verifications WHERE migration_id = ? ORDER BY created_at DESC LIMIT 1').get(migrationId);
    if (!row) return null;
    return Object.freeze(JSON.parse(row.verification_json));
  }

  getVerificationById(migrationId, verificationId) {
    this.#open(); text(migrationId, 'migrationId'); text(verificationId, 'verificationId');
    const row = this.db.prepare('SELECT verification_json FROM spool_verifications WHERE migration_id = ? AND verification_id = ?').get(migrationId, verificationId);
    if (!row) return null;
    return Object.freeze(JSON.parse(row.verification_json));
  }

  // Latest persisted verification for an attempt+mode, if any. Used by
  // crash-recovery paths to resume without minting duplicate evidence.
  findVerification({ migrationId, mode = null, cutoverAttemptId = null } = {}) {
    this.#open(); text(migrationId, 'migrationId');
    const rows = this.db.prepare('SELECT verification_json, created_at FROM spool_verifications WHERE migration_id = ? ORDER BY created_at DESC').all(migrationId);
    for (const row of rows) {
      const record = JSON.parse(row.verification_json);
      if (mode != null && record.mode !== mode) continue;
      if (cutoverAttemptId != null && record.cutoverAttemptId !== cutoverAttemptId) continue;
      return Object.freeze(record);
    }
    return null;
  }

  close() {
    if (!this.closed) {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
      this.db.close();
      this.closed = true;
      // Small delay to allow OS to release file locks on Windows
      const start = Date.now(); while (Date.now() - start < 50) {}
    }
  }
}
